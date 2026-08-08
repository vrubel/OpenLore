import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { CallEdge, FunctionNode, ClassNode, InheritanceEdge, SerializedCallGraph } from '../analyzer/call-graph.js';
import type { FunctionCfg } from '../analyzer/cfg.js';
import type { DecisionNode, DecisionAffectsEdge } from '../decisions/project.js';
import type { FileProvenance } from '../provenance/git-provenance.js';
import type { FileChangeCoupling, CoupledFile, ChangeCouplingResult } from '../provenance/change-coupling.js';
import type { DecisionStatus } from '../../types/index.js';
import { ARTIFACT_CALL_GRAPH_DB } from '../../constants.js';


function openDatabase(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  return db;
}

// Track nesting depth per db instance to support nested transactions via SAVEPOINT
const txDepth = new WeakMap<DatabaseSync, number>();

function runTransaction(db: DatabaseSync, fn: () => void): void {
  const depth = txDepth.get(db) ?? 0;
  const sp = `sp${depth}`;
  if (depth === 0) {
    db.exec('BEGIN');
  } else {
    db.exec(`SAVEPOINT ${sp}`);
  }
  txDepth.set(db, depth + 1);
  try {
    fn();
    if (depth === 0) {
      db.exec('COMMIT');
    } else {
      db.exec(`RELEASE ${sp}`);
    }
  } catch (err) {
    if (depth === 0) {
      db.exec('ROLLBACK');
    } else {
      // ROLLBACK TO reverts the savepoint's work but leaves it on the stack;
      // RELEASE pops it so a caught nested-tx error doesn't orphan a savepoint.
      db.exec(`ROLLBACK TO ${sp}`);
      db.exec(`RELEASE ${sp}`);
    }
    throw err;
  } finally {
    txDepth.set(db, depth);
  }
}

/** Bump when schema changes. Old DBs are dropped and rebuilt on next analyze --force. */
const SCHEMA_VERSION = 9;

export class EdgeStore {
  /**
   * True when opening this DB found a stale SCHEMA_VERSION and wiped it (rebuild-on-bump).
   * The data is gone until the next analyze repopulates it — callers that READ
   * (vs. analyze, which repopulates) should treat the store as unavailable so they
   * can tell the user to re-run analyze instead of serving an empty graph.
   */
  private _wasReset = false;
  get wasReset(): boolean { return this._wasReset; }

  /**
   * True when this handle was opened READ-ONLY and the database is not usable that
   * way — a stale SCHEMA_VERSION that only a writer could rebuild, or a schema we
   * cannot even interrogate. Callers must withhold the store and SAY why, rather
   * than serve an empty graph that reads as "no analysis here".
   */
  private _readOnlyUnusable = false;
  get readOnlyUnusable(): boolean { return this._readOnlyUnusable; }

  private constructor(private readonly db: DatabaseSync, readOnly = false) {
    if (readOnly) this.checkSchemaReadOnly();
    else this.initSchema();
  }

  /**
   * Schema handling for a READ-ONLY handle. `initSchema` CREATEs, INSERTs and — on
   * a version bump — DROPs every table: opening someone else's index for a mere
   * read would rewrite it, and on a bump would destroy it. A read-only handle looks
   * instead of repairing, and reports unusability upward.
   */
  private checkSchemaReadOnly(): void {
    try {
      const row = this.db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined;
      if (row === undefined || row.version !== SCHEMA_VERSION) this._readOnlyUnusable = true;
    } catch {
      this._readOnlyUnusable = true;
    }
  }

  private initSchema(): void {
    // Version check — if schema changed, wipe and rebuild (analyze --force repopulates).
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`);
    const row = this.db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined;
    if (row === undefined) {
      this.db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
    } else if (row.version !== SCHEMA_VERSION) {
      this._wasReset = true;
      this.db.exec(`
        DROP TABLE IF EXISTS edges;
        DROP TABLE IF EXISTS inheritance_edges;
        DROP TABLE IF EXISTS nodes;
        DROP TABLE IF EXISTS classes;
        DROP TABLE IF EXISTS file_hashes;
        DROP TABLE IF EXISTS decisions;
        DROP TABLE IF EXISTS decision_edges;
        DROP TABLE IF EXISTS provenance;
        DROP TABLE IF EXISTS change_coupling;
        DROP TABLE IF EXISTS cfg_overlay;
        DROP TABLE IF EXISTS graph_meta;
        DROP TABLE IF EXISTS schema_version;
        CREATE TABLE schema_version (version INTEGER NOT NULL);
      `);
      this.db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS edges (
        caller_id      TEXT NOT NULL,
        caller_file    TEXT NOT NULL,
        callee_id      TEXT NOT NULL,
        callee_file    TEXT,
        callee_name    TEXT NOT NULL,
        line           INTEGER,
        confidence     TEXT,
        kind           TEXT,
        call_type      TEXT,
        synthesized_by TEXT,
        -- The store is now the ONLY home of the call graph (it used to be a
        -- production-only projection alongside a full copy in llm-context.json).
        -- Test-side edges (tested_by, or either end in a test file) live here
        -- too, flagged, so the test-impact tools keep working — every production
        -- query filters is_test = 0 and is therefore unchanged by their presence.
        is_test        INTEGER NOT NULL DEFAULT 0,
        -- Insertion order of the serialized graph, so materializing it back
        -- reproduces the previous array order byte-for-byte.
        ord            INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_caller_id   ON edges(caller_id);
      CREATE INDEX IF NOT EXISTS idx_callee_id   ON edges(callee_id);
      CREATE INDEX IF NOT EXISTS idx_caller_file ON edges(caller_file);
      CREATE INDEX IF NOT EXISTS idx_callee_file ON edges(callee_file);

      CREATE TABLE IF NOT EXISTS inheritance_edges (
        -- id was dropped on the way in while llm-context.json still held a full
        -- copy of the graph; with the store now authoritative it has to survive.
        id        TEXT,
        parent_id TEXT NOT NULL,
        child_id  TEXT NOT NULL,
        kind      TEXT,
        ord       INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_inh_parent ON inheritance_edges(parent_id);
      CREATE INDEX IF NOT EXISTS idx_inh_child  ON inheritance_edges(child_id);

      CREATE TABLE IF NOT EXISTS nodes (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        file_path     TEXT NOT NULL,
        class_name    TEXT,
        is_async      INTEGER NOT NULL DEFAULT 0,
        language      TEXT NOT NULL DEFAULT '',
        start_index   INTEGER NOT NULL DEFAULT 0,
        end_index     INTEGER NOT NULL DEFAULT 0,
        fan_in        INTEGER NOT NULL DEFAULT 0,
        fan_out       INTEGER NOT NULL DEFAULT 0,
        docstring     TEXT,
        signature     TEXT,
        is_external   INTEGER NOT NULL DEFAULT 0,
        external_kind TEXT,
        is_hub        INTEGER NOT NULL DEFAULT 0,
        is_entry_point INTEGER NOT NULL DEFAULT 0,
        -- Content-addressed location-independent identity (add-content-addressed-stable-symbol-ids).
        -- Nullable: anonymous/synthetic symbols and pre-bump stores carry none. Additive: id stays PK.
        stable_id     TEXT,
        -- Fields below used to survive only in llm-context.json's copy of the graph.
        -- The store is now its only home, so they are persisted here or the tools
        -- that read them (surprising-connections' communities, health-map's
        -- complexity, every line-numbered view) would silently lose them.
        is_test       INTEGER NOT NULL DEFAULT 0,
        start_line    INTEGER,
        end_line      INTEGER,
        community_id  TEXT,
        community_label TEXT,
        cyclomatic_complexity INTEGER,
        -- Position in the serialized graph's nodes array, and in hubFunctions /
        -- entryPoints (NULL when not a member). Those two arrays were full node
        -- copies with a meaningful ranking order; the flags alone cannot restore it.
        ord           INTEGER NOT NULL DEFAULT 0,
        hub_ord       INTEGER,
        entry_ord     INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_node_file ON nodes(file_path);
      CREATE INDEX IF NOT EXISTS idx_node_name ON nodes(name);
      CREATE INDEX IF NOT EXISTS idx_node_stable ON nodes(stable_id);
      CREATE INDEX IF NOT EXISTS idx_node_test ON nodes(is_test);

      CREATE TABLE IF NOT EXISTS classes (
        id             TEXT PRIMARY KEY,
        name           TEXT NOT NULL,
        file_path      TEXT NOT NULL,
        language       TEXT NOT NULL DEFAULT '',
        parent_classes TEXT NOT NULL DEFAULT '[]',
        interfaces     TEXT NOT NULL DEFAULT '[]',
        method_ids     TEXT NOT NULL DEFAULT '[]',
        fan_in         INTEGER NOT NULL DEFAULT 0,
        fan_out        INTEGER NOT NULL DEFAULT 0,
        is_module      INTEGER NOT NULL DEFAULT 0,
        stable_id      TEXT,
        ord            INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_class_file ON classes(file_path);
      CREATE INDEX IF NOT EXISTS idx_class_name ON classes(name);

      CREATE TABLE IF NOT EXISTS file_hashes (
        file_path    TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        updated_at   INTEGER NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(node_id UNINDEXED, name, tokenize='trigram');

      -- Architectural decisions projected as first-class graph nodes (spec-16).
      -- Derived from .openlore/decisions/pending.json; the JSON store stays
      -- authoritative. Held in dedicated tables so code-node stats (hubs,
      -- entry points, countNodes) and call-edge BFS are untouched.
      CREATE TABLE IF NOT EXISTS decisions (
        id               TEXT PRIMARY KEY,  -- graph node id "decision::<id>"
        decision_id      TEXT NOT NULL,     -- original 8-char store id
        title            TEXT NOT NULL,
        status           TEXT NOT NULL,
        rationale        TEXT NOT NULL DEFAULT '',
        consequences     TEXT NOT NULL DEFAULT '',
        affected_domains TEXT NOT NULL DEFAULT '[]',
        affected_files   TEXT NOT NULL DEFAULT '[]',
        confidence       TEXT,
        supersedes       TEXT
      );

      -- affects edges: decision node -> governed file path.
      CREATE TABLE IF NOT EXISTS decision_edges (
        decision_id TEXT NOT NULL,  -- graph node id "decision::<id>"
        file_path   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_decision_edge_file ON decision_edges(file_path);
      CREATE INDEX IF NOT EXISTS idx_decision_edge_dec  ON decision_edges(decision_id);

      -- Local provenance (spec-18): per-file last-author + recent authors + PRs,
      -- derived from local git/gh. Capped upstream; one row per file, no graph bloat.
      CREATE TABLE IF NOT EXISTS provenance (
        file_path      TEXT PRIMARY KEY,
        last_author    TEXT NOT NULL,           -- JSON {name,email}
        last_date      TEXT,
        last_commit    TEXT,
        last_subject   TEXT,
        recent_authors TEXT NOT NULL DEFAULT '[]', -- JSON Author[]
        prs            TEXT NOT NULL DEFAULT '[]'   -- JSON PullRequest[]
      );

      -- Change coupling & volatility (spec-22): per-file churn + co-change pairs,
      -- mined from local git history. One row per file; advisory caution signals.
      CREATE TABLE IF NOT EXISTS change_coupling (
        file_path    TEXT PRIMARY KEY,
        churn        INTEGER NOT NULL DEFAULT 0,
        coupled_with TEXT NOT NULL DEFAULT '[]'  -- JSON CoupledFile[]
      );

      -- Intra-procedural control-flow + reaching-definitions overlay
      -- (spec: add-intraprocedural-cfg-dataflow-overlay). One compact JSON blob
      -- per function id: basic blocks + adjacency + labeled def-use edges, NOT a
      -- row per statement. DB-only and lazily loaded — never added to the
      -- resident SerializedCallGraph or the hot cached context, so in-memory
      -- footprint is unchanged. file_path is denormalized for per-file
      -- incremental delete in the watcher's per-file swap.
      CREATE TABLE IF NOT EXISTS cfg_overlay (
        function_id TEXT PRIMARY KEY,
        file_path   TEXT NOT NULL,
        cfg         TEXT NOT NULL  -- JSON FunctionCfg
      );
      CREATE INDEX IF NOT EXISTS idx_cfg_file ON cfg_overlay(file_path);

      -- The non-array remainder of the serialized call graph: stats and
      -- layerViolations. Small, but it belongs with the graph rather than in
      -- llm-context.json — otherwise the artifact would still carry a piece of
      -- the graph, and a second reader would have to know where each half lives.
      CREATE TABLE IF NOT EXISTS graph_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL  -- JSON
      );
    `);
  }

  // ── Edge queries ──────────────────────────────────────────────────────────────

  /** All distinct files that call into calleeFile (reverse lookup before delete). */
  getCallerFiles(calleeFile: string): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT caller_file FROM edges WHERE callee_file = ? AND is_test = 0')
      .all(calleeFile) as unknown as Array<{ caller_file: string }>;
    return rows.map(r => r.caller_file);
  }

  /** All outgoing + incoming edges touching a file. */
  getEdgesForFile(file: string): { outgoing: CallEdge[]; incoming: CallEdge[] } {
    const outgoing = (
      this.db.prepare('SELECT * FROM edges WHERE caller_file = ? AND is_test = 0').all(file) as unknown as RawEdge[]
    ).map(rawToCallEdge);
    const incoming = (
      this.db.prepare('SELECT * FROM edges WHERE callee_file = ? AND is_test = 0').all(file) as unknown as RawEdge[]
    ).map(rawToCallEdge);
    return { outgoing, incoming };
  }

  /** Outgoing edges from a node ID (its direct callees). */
  getCallees(nodeId: string): CallEdge[] {
    return (
      this.db.prepare('SELECT * FROM edges WHERE caller_id = ? AND is_test = 0').all(nodeId) as unknown as RawEdge[]
    ).map(rawToCallEdge);
  }

  /** Incoming edges to a node ID (its direct callers). */
  getCallers(nodeId: string): CallEdge[] {
    return (
      this.db.prepare('SELECT * FROM edges WHERE callee_id = ? AND is_test = 0').all(nodeId) as unknown as RawEdge[]
    ).map(rawToCallEdge);
  }

  /**
   * Cross-package consumer edges for a symbol name: edges whose callee is an
   * unresolved external reference (`confidence === 'external'`) with this exact
   * name. These are the call sites in *this* repo that reach a symbol published
   * by another repo — the consumer side of federated cross-repo resolution.
   * Matched on the exact name; arity/signature is unavailable at an external call
   * site, so callers must disclose name-collision risk.
   */
  getExternalConsumers(symbolName: string): CallEdge[] {
    return (
      this.db
        .prepare("SELECT * FROM edges WHERE callee_name = ? AND confidence = 'external' AND is_test = 0")
        .all(symbolName) as unknown as RawEdge[]
    ).map(rawToCallEdge);
  }

  /**
   * The distinct names of every unresolved external reference this repo makes
   * (`confidence === 'external'`) — the upstream interfaces this repo consumes from
   * the rest of the fleet. The producer side of federation resolves each of these to
   * the repo that publishes it. Non-fleet externals (npm/stdlib) appear here too and
   * are filtered downstream when no registered repo produces them.
   */
  getExternalReferenceNames(): string[] {
    return (
      this.db
        .prepare("SELECT DISTINCT callee_name FROM edges WHERE confidence = 'external' AND callee_name IS NOT NULL AND is_test = 0")
        .all() as unknown as Array<{ callee_name: string }>
    ).map((r) => r.callee_name);
  }

  /** Batch: outgoing edges for a set of caller IDs — one query instead of N. */
  getCalleesForIds(callerIds: string[]): CallEdge[] {
    if (callerIds.length === 0) return [];
    const placeholders = callerIds.map(() => '?').join(',');
    return (
      this.db.prepare(`SELECT * FROM edges WHERE caller_id IN (${placeholders}) AND is_test = 0`).all(...callerIds) as unknown as RawEdge[]
    ).map(rawToCallEdge);
  }

  /** Batch: incoming edges for a set of callee IDs — one query instead of N. */
  getCallersForIds(calleeIds: string[]): CallEdge[] {
    if (calleeIds.length === 0) return [];
    const placeholders = calleeIds.map(() => '?').join(',');
    return (
      this.db.prepare(`SELECT * FROM edges WHERE callee_id IN (${placeholders}) AND is_test = 0`).all(...calleeIds) as unknown as RawEdge[]
    ).map(rawToCallEdge);
  }

  // ── Edge mutations ────────────────────────────────────────────────────────────

  /**
   * Remove PRODUCTION edges where this file is caller or callee.
   *
   * The test side (`tested_by`, and calls from test files) is deliberately left
   * alone. The incremental re-index that calls this can only rebuild what it
   * re-parses, and it never re-parses test files: the watcher skips them, and
   * `getCallerFiles` — a production query — does not report them as callers. So
   * deleting test edges here would destroy them for good, until the next full
   * analyze. Before the graph moved into this store they lived in
   * llm-context.json, which the incremental path never rewrote; leaving them
   * untouched preserves exactly that behaviour, stale-but-present.
   */
  deleteEdgesForFile(file: string): void {
    this.db.prepare('DELETE FROM edges WHERE (caller_file = ? OR callee_file = ?) AND is_test = 0').run(file, file);
  }

  /** Remove only outgoing PRODUCTION edges from this file (incoming edges, and the test side, remain). */
  deleteOutgoingEdgesForFile(file: string): void {
    this.db.prepare('DELETE FROM edges WHERE caller_file = ? AND is_test = 0').run(file);
  }

  /**
   * Bulk-insert edges in a single transaction.
   *
   * `isTest` marks an edge as belonging to the test side of the graph
   * (`tested_by`, or either endpoint in a test file). Those edges are stored but
   * excluded from every production query, exactly as they were when the store
   * held only the production projection.
   */
  insertEdges(edges: CallEdge[], isTest?: (e: CallEdge) => boolean): void {
    const stmt: StatementSync = this.db.prepare(`
      INSERT INTO edges (caller_id, caller_file, callee_id, callee_file, callee_name, line, confidence, kind, call_type, synthesized_by, is_test, ord)
      VALUES (@callerId, @callerFile, @calleeId, @calleeFile, @calleeName, @line, @confidence, @kind, @callType, @synthesizedBy, @isTest, @ord)
    `);
    let ord = this.maxOrd('edges');
    runTransaction(this.db, () => {
      for (const e of edges) {
        const callerFile = e.callerId.includes('::') ? e.callerId.split('::')[0] : e.callerId;
        const calleeFile = e.calleeId.includes('::') ? e.calleeId.split('::')[0] : null;
        stmt.run({
          '@callerId':   e.callerId,
          '@callerFile': callerFile,
          '@calleeId':   e.calleeId,
          '@calleeFile': calleeFile,
          '@calleeName': e.calleeName,
          '@line':       e.line ?? null,
          '@confidence': e.confidence,
          '@kind':       e.kind ?? null,
          '@callType':   e.callType ?? null,
          '@synthesizedBy': e.synthesizedBy ?? null,
          '@isTest':     isTest && isTest(e) ? 1 : 0,
          '@ord':        ++ord,
        });
      }
    });
  }

  /** Bulk-insert inheritance edges in a single transaction. */
  insertInheritanceEdges(edges: InheritanceEdge[]): void {
    const stmt: StatementSync = this.db.prepare(
      'INSERT INTO inheritance_edges (id, parent_id, child_id, kind, ord) VALUES (@id, @parentId, @childId, @kind, @ord)'
    );
    let ord = this.maxOrd('inheritance_edges');
    runTransaction(this.db, () => {
      for (const e of edges) {
        stmt.run({ '@id': e.id ?? null, '@parentId': e.parentId, '@childId': e.childId, '@kind': e.kind ?? null, '@ord': ++ord });
      }
    });
  }

  // ── Node queries ──────────────────────────────────────────────────────────────

  getNode(id: string): FunctionNode | null {
    const row = this.db.prepare('SELECT * FROM nodes WHERE id = ? AND is_test = 0').get(id) as RawNode | undefined;
    return row ? rawToFunctionNode(row) : null;
  }

  getNodesForFile(file: string): FunctionNode[] {
    return (
      this.db.prepare('SELECT * FROM nodes WHERE file_path = ? AND is_test = 0').all(file) as unknown as RawNode[]
    ).map(rawToFunctionNode);
  }

  /**
   * Resolve a node by its content-addressed `stableId`
   * (add-content-addressed-stable-symbol-ids). Returns the match only when it is
   * unambiguous — a single internal node. Ambiguous (a collision the ordinal pass
   * still left, or two files momentarily sharing one) or absent → null, so a
   * rename-resolution caller never guesses between candidates.
   */
  getNodeByStableId(stableId: string): FunctionNode | null {
    const rows = this.db
      .prepare('SELECT * FROM nodes WHERE stable_id = ? AND is_external = 0 AND is_test = 0')
      .all(stableId) as unknown as RawNode[];
    return rows.length === 1 ? rawToFunctionNode(rows[0]) : null;
  }

  /**
   * All internal (non-external) nodes. Used to seed cross-file call resolution
   * during an incremental subset rebuild, so calls into files outside the
   * re-parsed subset still resolve to their real node instead of `external::`.
   */
  getAllInternalNodes(): FunctionNode[] {
    return (
      this.db.prepare('SELECT * FROM nodes WHERE is_external = 0 AND is_test = 0').all() as unknown as RawNode[]
    ).map(rawToFunctionNode);
  }

  /** Case-insensitive substring search on node name. FTS5 trigram for ≥3 chars, LIKE fallback otherwise. */
  searchNodes(pattern: string, limit = 50): FunctionNode[] {
    if (pattern.length >= 3) {
      // Wrap as an FTS5 phrase so special characters in the symbol are literal —
      // IaC resource names contain ':' (e.g. "Bucket:logs") and '.' which FTS5
      // would otherwise read as column filters / operators (spec-17).
      const phrase = `"${pattern.replace(/"/g, '""')}"`;
      return (
        this.db
          .prepare(`
            SELECT n.* FROM nodes_fts f
            JOIN nodes n ON n.id = f.node_id
            WHERE nodes_fts MATCH ? AND n.is_external = 0 AND n.is_test = 0
            LIMIT ?
          `)
          .all(phrase, limit) as unknown as RawNode[]
      ).map(rawToFunctionNode);
    }
    return (
      this.db
        .prepare('SELECT * FROM nodes WHERE name LIKE ? AND is_external = 0 AND is_test = 0 LIMIT ?')
        .all(`%${pattern}%`, limit) as unknown as RawNode[]
    ).map(rawToFunctionNode);
  }

  getHubs(limit = 25): FunctionNode[] {
    return (
      this.db
        .prepare('SELECT * FROM nodes WHERE is_hub = 1 AND is_external = 0 AND is_test = 0 ORDER BY fan_in DESC LIMIT ?')
        .all(limit) as unknown as RawNode[]
    ).map(rawToFunctionNode);
  }

  getEntryPoints(limit = 50): FunctionNode[] {
    return (
      this.db
        .prepare('SELECT * FROM nodes WHERE is_entry_point = 1 AND is_external = 0 AND is_test = 0 ORDER BY fan_out DESC LIMIT ?')
        .all(limit) as unknown as RawNode[]
    ).map(rawToFunctionNode);
  }

  countNodes(): number {
    const row = this.db.prepare('SELECT COUNT(*) as n FROM nodes WHERE is_external = 0 AND is_test = 0').get() as { n: number };
    return row.n;
  }

  /**
   * Distinct production file paths — the input to source-root inference.
   *
   * Exposed as a method so its caller can reach the graph through the shared,
   * perimeter-aware opener instead of running `new DatabaseSync(dbPath)` itself:
   * that bare constructor opens for WRITING, which is how a purely read-shaped
   * helper ended up modifying a repository this server may only read.
   */
  sourceRootRows(): Array<{ file_path: string }> {
    return this.db
      .prepare('SELECT DISTINCT file_path FROM nodes WHERE is_external = 0 AND is_test = 0')
      .all() as unknown as Array<{ file_path: string }>;
  }

  // ── Node mutations ────────────────────────────────────────────────────────────

  deleteNodesForFile(file: string): void {
    const ids = (
      this.db.prepare('SELECT id FROM nodes WHERE file_path = ?').all(file) as unknown as Array<{ id: string }>
    ).map(r => r.id);
    this.db.prepare('DELETE FROM nodes WHERE file_path = ?').run(file);
    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      this.db.prepare(`DELETE FROM nodes_fts WHERE node_id IN (${placeholders})`).run(...ids);
    }
  }

  /**
   * Swap one file's nodes for a freshly re-parsed set, KEEPING the rankings a
   * full analyze assigned: hub / entry-point membership (and the positions that
   * order those two arrays), plus each node's position in the graph.
   *
   * Those rankings are global properties — whether a function is a hub depends on
   * the whole repository — so an incremental re-parse of ONE file cannot recompute
   * them. A plain delete+insert therefore silently drops every edited file's
   * functions out of `hubFunctions` / `entryPoints` until the next full analyze.
   * That did not happen before the graph moved into this store, because those
   * arrays lived in llm-context.json and the incremental path never rewrote them.
   *
   * Nodes that are new in this parse are appended after the current maximum.
   */
  replaceFileNodes(file: string, nodes: FunctionNode[]): void {
    runTransaction(this.db, () => {
      const previous = new Map(
        (this.db
          .prepare('SELECT id, ord, hub_ord, entry_ord FROM nodes WHERE file_path = ?')
          .all(file) as unknown as Array<{ id: string; ord: number; hub_ord: number | null; entry_ord: number | null }>)
          .map(r => [r.id, r]),
      );
      this.deleteNodesForFile(file);
      let nextOrd = this.maxOrd('nodes');
      const hubIds = new Set<string>();
      const entryIds = new Set<string>();
      for (const n of nodes) {
        const prev = previous.get(n.id);
        if (prev?.hub_ord !== null && prev?.hub_ord !== undefined) hubIds.add(n.id);
        if (prev?.entry_ord !== null && prev?.entry_ord !== undefined) entryIds.add(n.id);
      }
      this.insertNodes(nodes, hubIds, entryIds, {
        nodeOrd:  id => previous.get(id)?.ord ?? ++nextOrd,
        hubOrd:   id => previous.get(id)?.hub_ord ?? null,
        entryOrd: id => previous.get(id)?.entry_ord ?? null,
      });
    });
  }

  /**
   * Bulk-insert nodes. hubIds/entryIds are optional sets used to mark flags;
   * omit them during incremental watcher updates (flags preserved from last analyze).
   *
   * `order` carries the positions the serialized graph had — the index in its
   * `nodes` array and in the ranked `hubFunctions` / `entryPoints` arrays — so
   * {@link materializeCallGraph} reproduces those arrays exactly rather than
   * re-deriving an order whose tie-breaks we would only be guessing at. Omitted
   * by the watcher's incremental path, which appends after the current maximum.
   */
  insertNodes(
    nodes: FunctionNode[],
    hubIds?: Set<string>,
    entryIds?: Set<string>,
    order?: { nodeOrd?: (id: string) => number; hubOrd?: (id: string) => number | null; entryOrd?: (id: string) => number | null },
  ): void {
    const stmt: StatementSync = this.db.prepare(`
      INSERT OR REPLACE INTO nodes
        (id, name, file_path, class_name, is_async, language, start_index, end_index,
         fan_in, fan_out, docstring, signature, is_external, external_kind, is_hub, is_entry_point, stable_id,
         is_test, start_line, end_line, community_id, community_label, cyclomatic_complexity, ord, hub_ord, entry_ord)
      VALUES
        (@id, @name, @filePath, @className, @isAsync, @language, @startIndex, @endIndex,
         @fanIn, @fanOut, @docstring, @signature, @isExternal, @externalKind, @isHub, @isEntryPoint, @stableId,
         @isTest, @startLine, @endLine, @communityId, @communityLabel, @cyclomaticComplexity, @ord, @hubOrd, @entryOrd)
    `);
    const ftsStmt: StatementSync = this.db.prepare('INSERT OR REPLACE INTO nodes_fts (node_id, name) VALUES (?, ?)');
    let nextOrd = order?.nodeOrd ? 0 : this.maxOrd('nodes');
    runTransaction(this.db, () => {
      for (const n of nodes) {
        stmt.run({
          '@id':           n.id,
          '@name':         n.name,
          '@filePath':     n.filePath,
          '@className':    n.className ?? null,
          '@isAsync':      n.isAsync ? 1 : 0,
          '@language':     n.language,
          '@startIndex':   n.startIndex,
          '@endIndex':     n.endIndex,
          '@fanIn':        n.fanIn,
          '@fanOut':       n.fanOut,
          '@docstring':    n.docstring ?? null,
          '@signature':    n.signature ?? null,
          '@isExternal':   n.isExternal ? 1 : 0,
          '@externalKind': n.externalKind ?? null,
          '@isHub':        hubIds ? (hubIds.has(n.id) ? 1 : 0) : 0,
          '@isEntryPoint': entryIds ? (entryIds.has(n.id) ? 1 : 0) : 0,
          '@stableId':     n.stableId ?? null,
          '@isTest':       n.isTest ? 1 : 0,
          '@startLine':    n.startLine ?? null,
          '@endLine':      n.endLine ?? null,
          '@communityId':  n.communityId ?? null,
          '@communityLabel': n.communityLabel ?? null,
          '@cyclomaticComplexity': n.cyclomaticComplexity ?? null,
          '@ord':          order?.nodeOrd ? order.nodeOrd(n.id) : ++nextOrd,
          '@hubOrd':       order?.hubOrd ? order.hubOrd(n.id) : null,
          '@entryOrd':     order?.entryOrd ? order.entryOrd(n.id) : null,
        });
        // Test nodes stay out of the search index: search_code and every
        // production query it feeds were production-only before the graph moved
        // into this store, and must remain so.
        if (!n.isExternal && !n.isTest) ftsStmt.run(n.id, n.name);
      }
    });
  }

  /** Current maximum `ord` in a table — the append point for incremental inserts. */
  private maxOrd(table: 'nodes' | 'edges' | 'classes' | 'inheritance_edges'): number {
    const row = this.db.prepare(`SELECT MAX(ord) as m FROM ${table}`).get() as { m: number | null };
    return row.m ?? 0;
  }

  // ── CFG / data-flow overlay (spec: add-intraprocedural-cfg-dataflow-overlay) ──

  /**
   * Lazily load one function's control-flow + reaching-definitions overlay.
   * Returns null when the function has no overlay (unsupported language, a parse
   * that produced no CFG, or a pre-overlay store). DB-only — never resident.
   */
  getCfg(functionId: string): FunctionCfg | null {
    const row = this.db.prepare('SELECT cfg FROM cfg_overlay WHERE function_id = ?').get(functionId) as { cfg: string } | undefined;
    if (!row) return null;
    try { return JSON.parse(row.cfg) as FunctionCfg; } catch { return null; }
  }

  /** True when any overlay rows exist (used to tell "no overlay" from "absent feature"). */
  hasCfgOverlay(): boolean {
    const row = this.db.prepare('SELECT 1 FROM cfg_overlay LIMIT 1').get() as { 1: number } | undefined;
    return row !== undefined;
  }

  /** Delete every overlay row for a file (per-file incremental recompute). */
  deleteCfgForFile(file: string): void {
    this.db.prepare('DELETE FROM cfg_overlay WHERE file_path = ?').run(file);
  }

  /** Bulk-insert per-function overlays in a single transaction. */
  insertCfgs(cfgs: Array<{ functionId: string; filePath: string; cfg: FunctionCfg }>): void {
    if (cfgs.length === 0) return;
    const stmt: StatementSync = this.db.prepare(
      'INSERT OR REPLACE INTO cfg_overlay (function_id, file_path, cfg) VALUES (@functionId, @filePath, @cfg)'
    );
    runTransaction(this.db, () => {
      for (const c of cfgs) {
        stmt.run({ '@functionId': c.functionId, '@filePath': c.filePath, '@cfg': JSON.stringify(c.cfg) });
      }
    });
  }

  // ── Class queries ─────────────────────────────────────────────────────────────

  getClass(id: string): ClassNode | null {
    const row = this.db.prepare('SELECT * FROM classes WHERE id = ?').get(id) as RawClass | undefined;
    return row ? rawToClassNode(row) : null;
  }

  getClassesForFile(file: string): ClassNode[] {
    return (
      this.db.prepare('SELECT * FROM classes WHERE file_path = ?').all(file) as unknown as RawClass[]
    ).map(rawToClassNode);
  }

  // ── Class mutations ───────────────────────────────────────────────────────────

  deleteClassesForFile(file: string): void {
    this.db.prepare('DELETE FROM classes WHERE file_path = ?').run(file);
  }

  insertClasses(classes: ClassNode[]): void {
    const stmt: StatementSync = this.db.prepare(`
      INSERT OR REPLACE INTO classes
        (id, name, file_path, language, parent_classes, interfaces, method_ids, fan_in, fan_out, is_module, stable_id, ord)
      VALUES
        (@id, @name, @filePath, @language, @parentClasses, @interfaces, @methodIds, @fanIn, @fanOut, @isModule, @stableId, @ord)
    `);
    let ord = this.maxOrd('classes');
    runTransaction(this.db, () => {
      for (const c of classes) {
        stmt.run({
          '@id':            c.id,
          '@name':          c.name,
          '@filePath':      c.filePath,
          '@language':      c.language,
          '@parentClasses': JSON.stringify(c.parentClasses),
          '@interfaces':    JSON.stringify(c.interfaces),
          '@methodIds':     JSON.stringify(c.methodIds),
          '@fanIn':         c.fanIn,
          '@fanOut':        c.fanOut,
          '@isModule':      c.isModule ? 1 : 0,
          '@stableId':      c.stableId ?? null,
          '@ord':           ++ord,
        });
      }
    });
  }

  // ── Decision queries / mutations (spec-16) ─────────────────────────────────────

  /** Replace the projected decision graph wholesale (idempotent re-projection). */
  insertDecisions(nodes: DecisionNode[], edges: DecisionAffectsEdge[]): void {
    const nodeStmt: StatementSync = this.db.prepare(`
      INSERT OR REPLACE INTO decisions
        (id, decision_id, title, status, rationale, consequences, affected_domains, affected_files, confidence, supersedes)
      VALUES
        (@id, @decisionId, @title, @status, @rationale, @consequences, @affectedDomains, @affectedFiles, @confidence, @supersedes)
    `);
    const edgeStmt: StatementSync = this.db.prepare(
      'INSERT INTO decision_edges (decision_id, file_path) VALUES (?, ?)'
    );
    runTransaction(this.db, () => {
      this.db.exec('DELETE FROM decisions; DELETE FROM decision_edges;');
      for (const n of nodes) {
        nodeStmt.run({
          '@id':              n.id,
          '@decisionId':      n.decisionId,
          '@title':           n.title,
          '@status':          n.status,
          '@rationale':       n.rationale,
          '@consequences':    n.consequences,
          '@affectedDomains': JSON.stringify(n.affectedDomains),
          '@affectedFiles':   JSON.stringify(n.affectedFiles),
          '@confidence':      n.confidence ?? null,
          '@supersedes':      n.supersedes ?? null,
        });
      }
      for (const e of edges) edgeStmt.run(e.decisionNodeId, e.filePath);
    });
  }

  /** Every projected decision node (deterministic order). */
  getAllDecisions(): DecisionNode[] {
    return (
      this.db.prepare('SELECT * FROM decisions ORDER BY id').all() as unknown as RawDecision[]
    ).map(rawToDecisionNode);
  }

  countDecisions(): number {
    const row = this.db.prepare('SELECT COUNT(*) as n FROM decisions').get() as { n: number };
    return row.n;
  }

  /**
   * Governing decisions for a set of files — the deterministic graph join that
   * replaces orient's runtime affectedFiles set-membership filter (spec-16).
   *
   * Path forms differ across callers (edge-store nodes are repo-relative; some
   * callers pass absolute paths), and decisions are few, so we match in JS with a
   * tolerant suffix comparator rather than relying on exact SQL equality.
   */
  getDecisionsForFiles(files: string[]): DecisionNode[] {
    if (files.length === 0) return [];
    const edgeRows = this.db
      .prepare('SELECT decision_id, file_path FROM decision_edges')
      .all() as unknown as Array<{ decision_id: string; file_path: string }>;
    if (edgeRows.length === 0) return [];

    const wanted = files.filter(Boolean);
    const matchedIds = new Set<string>();
    for (const row of edgeRows) {
      if (wanted.some(f => pathsMatch(f, row.file_path))) matchedIds.add(row.decision_id);
    }
    if (matchedIds.size === 0) return [];

    return this.getAllDecisions().filter(d => matchedIds.has(d.id));
  }

  // ── Provenance queries / mutations (spec-18) ───────────────────────────────────

  /** Replace the per-file provenance wholesale (idempotent re-extraction). */
  insertProvenance(records: FileProvenance[]): void {
    const stmt: StatementSync = this.db.prepare(`
      INSERT OR REPLACE INTO provenance
        (file_path, last_author, last_date, last_commit, last_subject, recent_authors, prs)
      VALUES
        (@filePath, @lastAuthor, @lastDate, @lastCommit, @lastSubject, @recentAuthors, @prs)
    `);
    runTransaction(this.db, () => {
      this.db.exec('DELETE FROM provenance;');
      for (const r of records) {
        stmt.run({
          '@filePath':      r.filePath,
          '@lastAuthor':    JSON.stringify(r.lastAuthor),
          '@lastDate':      r.lastDate ?? null,
          '@lastCommit':    r.lastCommit ?? null,
          '@lastSubject':   r.lastSubject ?? null,
          '@recentAuthors': JSON.stringify(r.recentAuthors),
          '@prs':           JSON.stringify(r.prs),
        });
      }
    });
  }

  countProvenance(): number {
    const row = this.db.prepare('SELECT COUNT(*) as n FROM provenance').get() as { n: number };
    return row.n;
  }

  /**
   * Provenance for a set of files. Path forms differ across callers (edge-store
   * nodes are repo-relative; some callers pass absolute paths), so match with the
   * same tolerant comparator used for decisions (spec-18).
   */
  getProvenanceForFiles(files: string[]): FileProvenance[] {
    if (files.length === 0) return [];
    const rows = this.db.prepare('SELECT * FROM provenance').all() as unknown as RawProvenance[];
    if (rows.length === 0) return [];
    const wanted = files.filter(Boolean);
    return rows
      .filter(r => wanted.some(f => pathsMatch(f, r.file_path)))
      .map(rawToProvenance);
  }

  // ── Change coupling & volatility (spec-22) ─────────────────────────────────────

  /** Replace the per-file change-coupling snapshot wholesale (idempotent re-mine). */
  insertChangeCoupling(result: ChangeCouplingResult): void {
    const stmt: StatementSync = this.db.prepare(
      'INSERT OR REPLACE INTO change_coupling (file_path, churn, coupled_with) VALUES (@filePath, @churn, @coupledWith)'
    );
    runTransaction(this.db, () => {
      this.db.exec('DELETE FROM change_coupling;');
      // Persist every file that has churn (coupling may be empty for some).
      for (const [filePath, churn] of result.churn) {
        stmt.run({
          '@filePath':    filePath,
          '@churn':       churn,
          '@coupledWith': JSON.stringify(result.coupling.get(filePath) ?? []),
        });
      }
    });
  }

  countChangeCoupling(): number {
    const row = this.db.prepare('SELECT COUNT(*) as n FROM change_coupling').get() as { n: number };
    return row.n;
  }

  /** Change-coupling records for a set of files (tolerant path match, spec-22). */
  getChangeCouplingForFiles(files: string[]): FileChangeCoupling[] {
    if (files.length === 0) return [];
    const rows = this.db.prepare('SELECT * FROM change_coupling').all() as unknown as RawCoupling[];
    if (rows.length === 0) return [];
    const wanted = files.filter(Boolean);
    return rows.filter(r => wanted.some(f => pathsMatch(f, r.file_path))).map(rawToCoupling);
  }

  /** Top-churn (most volatile) files, descending. */
  getTopVolatile(limit = 20): FileChangeCoupling[] {
    return (
      this.db.prepare('SELECT * FROM change_coupling ORDER BY churn DESC, file_path ASC LIMIT ?')
        .all(limit) as unknown as RawCoupling[]
    ).map(rawToCoupling);
  }

  // ── Content-hash cache ────────────────────────────────────────────────────────

  getFileHash(filePath: string): string | null {
    const row = this.db
      .prepare('SELECT content_hash FROM file_hashes WHERE file_path = ?')
      .get(filePath) as { content_hash: string } | undefined;
    return row?.content_hash ?? null;
  }

  setFileHash(filePath: string, hash: string): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO file_hashes (file_path, content_hash, updated_at) VALUES (?, ?, ?)'
      )
      .run(filePath, hash, Date.now());
  }

  // ── Whole-graph access (the store replaced llm-context.json's copy) ───────────

  /**
   * Every node, test nodes included, in the serialized graph's original order.
   * Unlike the per-query getters this does NOT filter the test side: it exists to
   * rebuild the full `SerializedCallGraph` that used to live in llm-context.json.
   */
  getAllNodes(): FunctionNode[] {
    return (
      this.db.prepare('SELECT * FROM nodes ORDER BY ord').all() as unknown as RawNode[]
    ).map(rawToFunctionNode);
  }

  /** Every edge, test edges included, in the serialized graph's original order. */
  getAllEdges(): CallEdge[] {
    return (
      this.db.prepare('SELECT * FROM edges ORDER BY ord').all() as unknown as RawEdge[]
    ).map(rawToCallEdge);
  }

  getAllClasses(): ClassNode[] {
    return (
      this.db.prepare('SELECT * FROM classes ORDER BY ord').all() as unknown as RawClass[]
    ).map(rawToClassNode);
  }

  getAllInheritanceEdges(): InheritanceEdge[] {
    const rows = this.db
      .prepare('SELECT id, parent_id, child_id, kind FROM inheritance_edges ORDER BY ord')
      .all() as unknown as Array<{ id: string | null; parent_id: string; child_id: string; kind: string | null }>;
    return rows.map(r => ({
      id:       r.id ?? `${r.parent_id}->${r.child_id}`,
      parentId: r.parent_id,
      childId:  r.child_id,
      kind:     (r.kind ?? 'extends') as InheritanceEdge['kind'],
    }));
  }

  /** Read one graph_meta value (`stats`, `layerViolations`), or null when absent. */
  getGraphMeta<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value FROM graph_meta WHERE key = ?').get(key) as { value: string } | undefined;
    if (!row) return null;
    try { return JSON.parse(row.value) as T; } catch { return null; }
  }

  setGraphMeta(key: string, value: unknown): void {
    this.db
      .prepare('INSERT OR REPLACE INTO graph_meta (key, value) VALUES (?, ?)')
      .run(key, JSON.stringify(value));
  }

  /**
   * Rebuild the whole `SerializedCallGraph` from the store — the object that used
   * to be persisted inside llm-context.json (86–91% of that artifact).
   *
   * Returns null for an EMPTY store, so callers can tell "no graph built yet"
   * from "graph present" and say so out loud instead of serving an empty graph
   * that reads identically to "no analysis".
   */
  materializeCallGraph(): SerializedCallGraph | null {
    const nodes = this.getAllNodes();
    if (nodes.length === 0) return null;
    const hubRows = this.db.prepare('SELECT id FROM nodes WHERE hub_ord IS NOT NULL ORDER BY hub_ord').all() as unknown as Array<{ id: string }>;
    const entryRows = this.db.prepare('SELECT id FROM nodes WHERE entry_ord IS NOT NULL ORDER BY entry_ord').all() as unknown as Array<{ id: string }>;
    const byId = new Map(nodes.map(n => [n.id, n]));
    const pick = (rows: Array<{ id: string }>): FunctionNode[] =>
      rows.map(r => byId.get(r.id)).filter((n): n is FunctionNode => n !== undefined);
    return {
      nodes,
      edges: this.getAllEdges(),
      classes: this.getAllClasses(),
      inheritanceEdges: this.getAllInheritanceEdges(),
      hubFunctions: pick(hubRows),
      entryPoints: pick(entryRows),
      layerViolations: this.getGraphMeta<SerializedCallGraph['layerViolations']>('layerViolations') ?? [],
      stats: this.getGraphMeta<SerializedCallGraph['stats']>('stats')
        ?? { totalNodes: 0, totalEdges: 0, avgFanIn: 0, avgFanOut: 0 },
    };
  }

  /** Drop all graph data — used by full analyze rebuild. */
  clearAll(): void {
    this.db.exec('DELETE FROM edges; DELETE FROM inheritance_edges; DELETE FROM nodes; DELETE FROM classes; DELETE FROM nodes_fts; DELETE FROM file_hashes; DELETE FROM decisions; DELETE FROM decision_edges; DELETE FROM provenance; DELETE FROM change_coupling; DELETE FROM cfg_overlay; DELETE FROM graph_meta;');
  }

  /** Run fn inside a single SQLite transaction. */
  transaction(fn: () => void): void {
    runTransaction(this.db, fn);
  }

  close(): void {
    this.db.close();
  }

  // ── Factory ───────────────────────────────────────────────────────────────────

  static open(dbPath: string): EdgeStore {
    return new EdgeStore(openDatabase(dbPath));
  }

  /**
   * Open the index leaving NOTHING behind — for a repository this process may read
   * but not write.
   *
   * `readOnly: true` alone is not enough, and the difference is the whole point.
   * The index is a WAL database, and a WAL reader needs the shared-memory index: a
   * plain read-only connection materializes `call-graph.db-shm` AND `call-graph.db-wal`
   * inside the other repository and leaves them there. Measured, not assumed. The
   * `immutable=1` URI tells SQLite the file cannot change underneath it, which is
   * exactly the promise a non-writer can make, and skips the sidecars entirely —
   * zero bytes written.
   *
   * The cost of that promise, stated plainly: if the owning repository runs its own
   * `openlore analyze` concurrently, this reader may see the pre-commit state (or,
   * in the worst case, an inconsistent one). That is the honest trade for consulting
   * an index we do not own; the alternative is no cross-repo graph at all.
   *
   * Throws when the database cannot be served this way — the caller degrades and says so.
   */
  static openReadOnly(dbPath: string): EdgeStore {
    const uri = `${pathToFileURL(dbPath).href}?immutable=1`;
    return new EdgeStore(new DatabaseSync(uri, { readOnly: true }), true);
  }

  static exists(outputDir: string): boolean {
    return existsSync(join(outputDir, ARTIFACT_CALL_GRAPH_DB));
  }

  static dbPath(outputDir: string): string {
    return join(outputDir, ARTIFACT_CALL_GRAPH_DB);
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

interface RawEdge {
  caller_id:   string;
  caller_file: string;
  callee_id:   string;
  callee_file: string | null;
  callee_name: string;
  line:        number | null;
  confidence:  string;
  kind:        string | null;
  call_type:   string | null;
  synthesized_by: string | null;
}

interface RawNode {
  id:             string;
  name:           string;
  file_path:      string;
  class_name:     string | null;
  is_async:       number;
  language:       string;
  start_index:    number;
  end_index:      number;
  fan_in:         number;
  fan_out:        number;
  docstring:      string | null;
  signature:      string | null;
  is_external:    number;
  external_kind:  string | null;
  is_hub:         number;
  is_entry_point: number;
  stable_id:      string | null;
  is_test:        number;
  start_line:     number | null;
  end_line:       number | null;
  community_id:   string | null;
  community_label: string | null;
  cyclomatic_complexity: number | null;
  ord:            number;
  hub_ord:        number | null;
  entry_ord:      number | null;
}

interface RawClass {
  id:             string;
  name:           string;
  file_path:      string;
  language:       string;
  parent_classes: string;
  interfaces:     string;
  method_ids:     string;
  fan_in:         number;
  fan_out:        number;
  is_module:      number;
  stable_id:      string | null;
}

interface RawDecision {
  id:               string;
  decision_id:      string;
  title:            string;
  status:           string;
  rationale:        string;
  consequences:     string;
  affected_domains: string;
  affected_files:   string;
  confidence:       string | null;
  supersedes:       string | null;
}

interface RawProvenance {
  file_path:      string;
  last_author:    string;
  last_date:      string | null;
  last_commit:    string | null;
  last_subject:   string | null;
  recent_authors: string;
  prs:            string;
}

interface RawCoupling {
  file_path:    string;
  churn:        number;
  coupled_with: string;
}

function rawToCoupling(r: RawCoupling): FileChangeCoupling {
  return {
    filePath:    r.file_path,
    churn:       r.churn,
    coupledWith: JSON.parse(r.coupled_with) as CoupledFile[],
  };
}

function rawToProvenance(r: RawProvenance): FileProvenance {
  return {
    filePath:      r.file_path,
    lastAuthor:    JSON.parse(r.last_author) as FileProvenance['lastAuthor'],
    lastDate:      r.last_date ?? '',
    lastCommit:    r.last_commit ?? '',
    lastSubject:   r.last_subject ?? '',
    recentAuthors: JSON.parse(r.recent_authors) as FileProvenance['recentAuthors'],
    prs:           JSON.parse(r.prs) as FileProvenance['prs'],
  };
}

/** Tolerant path equality: exact, or one path is a suffix of the other. */
function pathsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const na = a.replace(/^\/+/, '');
  const nb = b.replace(/^\/+/, '');
  if (na === nb) return true;
  return na.endsWith('/' + nb) || nb.endsWith('/' + na);
}

function rawToDecisionNode(r: RawDecision): DecisionNode {
  return {
    id:              r.id,
    decisionId:      r.decision_id,
    kind:            'decision',
    title:           r.title,
    status:          r.status as DecisionStatus,
    rationale:       r.rationale,
    consequences:    r.consequences,
    affectedDomains: JSON.parse(r.affected_domains) as string[],
    affectedFiles:   JSON.parse(r.affected_files) as string[],
    confidence:      (r.confidence ?? 'medium') as DecisionNode['confidence'],
    ...(r.supersedes ? { supersedes: r.supersedes } : {}),
  };
}

function rawToCallEdge(r: RawEdge): CallEdge {
  return {
    callerId:   r.caller_id,
    calleeId:   r.callee_id,
    calleeName: r.callee_name,
    ...(r.line !== null && { line: r.line }),
    confidence: r.confidence as CallEdge['confidence'],
    ...(r.kind      && { kind:     r.kind     as CallEdge['kind'] }),
    ...(r.call_type && { callType: r.call_type as CallEdge['callType'] }),
    ...(r.synthesized_by && { synthesizedBy: r.synthesized_by }),
  };
}

function rawToFunctionNode(r: RawNode): FunctionNode {
  return {
    id:          r.id,
    name:        r.name,
    filePath:    r.file_path,
    ...(r.class_name && { className: r.class_name }),
    isAsync:     r.is_async === 1,
    language:    r.language,
    startIndex:  r.start_index,
    endIndex:    r.end_index,
    fanIn:       r.fan_in,
    fanOut:      r.fan_out,
    ...(r.docstring    && { docstring:    r.docstring }),
    ...(r.signature    && { signature:    r.signature }),
    ...(r.is_external  && { isExternal:   true }),
    ...(r.external_kind && { externalKind: r.external_kind as FunctionNode['externalKind'] }),
    ...(r.is_test      && { isTest:       true }),
    ...(r.start_line !== null && { startLine: r.start_line }),
    ...(r.end_line   !== null && { endLine:   r.end_line }),
    ...(r.community_id    && { communityId:    r.community_id }),
    ...(r.community_label && { communityLabel: r.community_label }),
    ...(r.cyclomatic_complexity !== null && { cyclomaticComplexity: r.cyclomatic_complexity }),
    ...(r.stable_id    && { stableId:     r.stable_id }),
  };
}

function rawToClassNode(r: RawClass): ClassNode {
  return {
    id:            r.id,
    name:          r.name,
    filePath:      r.file_path,
    language:      r.language,
    parentClasses: JSON.parse(r.parent_classes) as string[],
    interfaces:    JSON.parse(r.interfaces) as string[],
    methodIds:     JSON.parse(r.method_ids) as string[],
    fanIn:         r.fan_in,
    fanOut:        r.fan_out,
    ...(r.is_module && { isModule: true }),
    ...(r.stable_id && { stableId: r.stable_id }),
  };
}
