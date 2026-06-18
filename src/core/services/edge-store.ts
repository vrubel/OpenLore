import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { CallEdge, FunctionNode, ClassNode, InheritanceEdge } from '../analyzer/call-graph.js';
import { ARTIFACT_CALL_GRAPH_DB } from '../../constants.js';

/**
 * EdgeStore — граф вызовов / инвентари / символы. ДВА бэкенда за единым АСИНХРОННЫМ интерфейсом (D7 ось C, PDLC §12):
 *   OPENLORE_PG_URL не задан → SQLite (standalone, как раньше: файл call-graph.db, синхронно под капотом).
 *   OPENLORE_PG_URL задан    → Postgres (distributed): таблицы ol_* с колонкой ws (= hash рабочего каталога),
 *                              мульти-воркспейс в одной БД; навигация (orient/search_code/BFS) читает Postgres.
 * Интерфейс АСИНХРОННЫЙ для обоих (SQLite-методы — async-обёртки над sync node:sqlite). Имена колонок PG совпадают
 * с SQLite (caller_id/file_path/...), поэтому rawTo*-хелперы переиспользуются. searchNodes в PG — ILIKE-подстрока
 * (семантика LIKE-фолбэка SQLite; без расширений). fail-loud: Postgres-ошибки пробрасываются.
 */

// ── SQLite helpers (standalone) ───────────────────────────────────────────────
function openDatabase(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  return db;
}

const txDepth = new WeakMap<DatabaseSync, number>();
function runTransaction(db: DatabaseSync, fn: () => void): void {
  const depth = txDepth.get(db) ?? 0;
  const sp = `sp${depth}`;
  if (depth === 0) db.exec('BEGIN'); else db.exec(`SAVEPOINT ${sp}`);
  txDepth.set(db, depth + 1);
  try {
    fn();
    if (depth === 0) db.exec('COMMIT'); else db.exec(`RELEASE ${sp}`);
  } catch (err) {
    if (depth === 0) db.exec('ROLLBACK'); else db.exec(`ROLLBACK TO ${sp}`);
    throw err;
  } finally {
    txDepth.set(db, depth);
  }
}

/** Bump when schema changes. Old DBs are dropped and rebuilt on next analyze --force. */
const SCHEMA_VERSION = 2;

// ── Public async interface (оба бэкенда реализуют) ────────────────────────────
export interface EdgeStore {
  getCallerFiles(calleeFile: string): Promise<string[]>;
  getEdgesForFile(file: string): Promise<{ outgoing: CallEdge[]; incoming: CallEdge[] }>;
  getCallees(nodeId: string): Promise<CallEdge[]>;
  getCallers(nodeId: string): Promise<CallEdge[]>;
  getCalleesForIds(callerIds: string[]): Promise<CallEdge[]>;
  getCallersForIds(calleeIds: string[]): Promise<CallEdge[]>;
  deleteEdgesForFile(file: string): Promise<void>;
  deleteOutgoingEdgesForFile(file: string): Promise<void>;
  insertEdges(edges: CallEdge[]): Promise<void>;
  insertInheritanceEdges(edges: InheritanceEdge[]): Promise<void>;
  getNode(id: string): Promise<FunctionNode | null>;
  getNodesForFile(file: string): Promise<FunctionNode[]>;
  searchNodes(pattern: string, limit?: number): Promise<FunctionNode[]>;
  getHubs(limit?: number): Promise<FunctionNode[]>;
  getEntryPoints(limit?: number): Promise<FunctionNode[]>;
  countNodes(): Promise<number>;
  deleteNodesForFile(file: string): Promise<void>;
  insertNodes(nodes: FunctionNode[], hubIds?: Set<string>, entryIds?: Set<string>): Promise<void>;
  getClass(id: string): Promise<ClassNode | null>;
  getClassesForFile(file: string): Promise<ClassNode[]>;
  deleteClassesForFile(file: string): Promise<void>;
  insertClasses(classes: ClassNode[]): Promise<void>;
  getFileHash(filePath: string): Promise<string | null>;
  setFileHash(filePath: string, hash: string): Promise<void>;
  clearAll(): Promise<void>;
  transaction(fn: () => void | Promise<void>): Promise<void>;
  close(): Promise<void>;
}

// ── SQLite backend (standalone, поведение прежнее, методы async-обёрнуты) ──────
class SqliteBackend implements EdgeStore {
  constructor(private readonly db: DatabaseSync) { this.initSchema(); }

  private initSchema(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`);
    const row = this.db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined;
    if (row === undefined) {
      this.db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
    } else if (row.version !== SCHEMA_VERSION) {
      this.db.exec(`
        DROP TABLE IF EXISTS edges; DROP TABLE IF EXISTS inheritance_edges; DROP TABLE IF EXISTS nodes;
        DROP TABLE IF EXISTS classes; DROP TABLE IF EXISTS file_hashes; DROP TABLE IF EXISTS schema_version;
        CREATE TABLE schema_version (version INTEGER NOT NULL);
      `);
      this.db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS edges (
        caller_id TEXT NOT NULL, caller_file TEXT NOT NULL, callee_id TEXT NOT NULL, callee_file TEXT,
        callee_name TEXT NOT NULL, line INTEGER, confidence TEXT, kind TEXT, call_type TEXT );
      CREATE INDEX IF NOT EXISTS idx_caller_id ON edges(caller_id);
      CREATE INDEX IF NOT EXISTS idx_callee_id ON edges(callee_id);
      CREATE INDEX IF NOT EXISTS idx_caller_file ON edges(caller_file);
      CREATE INDEX IF NOT EXISTS idx_callee_file ON edges(callee_file);
      CREATE TABLE IF NOT EXISTS inheritance_edges ( parent_id TEXT NOT NULL, child_id TEXT NOT NULL, kind TEXT );
      CREATE INDEX IF NOT EXISTS idx_inh_parent ON inheritance_edges(parent_id);
      CREATE INDEX IF NOT EXISTS idx_inh_child ON inheritance_edges(child_id);
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, file_path TEXT NOT NULL, class_name TEXT,
        is_async INTEGER NOT NULL DEFAULT 0, language TEXT NOT NULL DEFAULT '', start_index INTEGER NOT NULL DEFAULT 0,
        end_index INTEGER NOT NULL DEFAULT 0, fan_in INTEGER NOT NULL DEFAULT 0, fan_out INTEGER NOT NULL DEFAULT 0,
        docstring TEXT, signature TEXT, is_external INTEGER NOT NULL DEFAULT 0, external_kind TEXT,
        is_hub INTEGER NOT NULL DEFAULT 0, is_entry_point INTEGER NOT NULL DEFAULT 0 );
      CREATE INDEX IF NOT EXISTS idx_node_file ON nodes(file_path);
      CREATE INDEX IF NOT EXISTS idx_node_name ON nodes(name);
      CREATE TABLE IF NOT EXISTS classes (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, file_path TEXT NOT NULL, language TEXT NOT NULL DEFAULT '',
        parent_classes TEXT NOT NULL DEFAULT '[]', interfaces TEXT NOT NULL DEFAULT '[]',
        method_ids TEXT NOT NULL DEFAULT '[]', fan_in INTEGER NOT NULL DEFAULT 0, fan_out INTEGER NOT NULL DEFAULT 0,
        is_module INTEGER NOT NULL DEFAULT 0 );
      CREATE INDEX IF NOT EXISTS idx_class_file ON classes(file_path);
      CREATE INDEX IF NOT EXISTS idx_class_name ON classes(name);
      CREATE TABLE IF NOT EXISTS file_hashes ( file_path TEXT PRIMARY KEY, content_hash TEXT NOT NULL, updated_at INTEGER NOT NULL );
      CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(node_id UNINDEXED, name, tokenize='trigram');
    `);
  }

  async getCallerFiles(calleeFile: string): Promise<string[]> {
    const rows = this.db.prepare('SELECT DISTINCT caller_file FROM edges WHERE callee_file = ?').all(calleeFile) as unknown as Array<{ caller_file: string }>;
    return rows.map(r => r.caller_file);
  }
  async getEdgesForFile(file: string): Promise<{ outgoing: CallEdge[]; incoming: CallEdge[] }> {
    const outgoing = (this.db.prepare('SELECT * FROM edges WHERE caller_file = ?').all(file) as unknown as RawEdge[]).map(rawToCallEdge);
    const incoming = (this.db.prepare('SELECT * FROM edges WHERE callee_file = ?').all(file) as unknown as RawEdge[]).map(rawToCallEdge);
    return { outgoing, incoming };
  }
  async getCallees(nodeId: string): Promise<CallEdge[]> {
    return (this.db.prepare('SELECT * FROM edges WHERE caller_id = ?').all(nodeId) as unknown as RawEdge[]).map(rawToCallEdge);
  }
  async getCallers(nodeId: string): Promise<CallEdge[]> {
    return (this.db.prepare('SELECT * FROM edges WHERE callee_id = ?').all(nodeId) as unknown as RawEdge[]).map(rawToCallEdge);
  }
  async getCalleesForIds(callerIds: string[]): Promise<CallEdge[]> {
    if (callerIds.length === 0) return [];
    const ph = callerIds.map(() => '?').join(',');
    return (this.db.prepare(`SELECT * FROM edges WHERE caller_id IN (${ph})`).all(...callerIds) as unknown as RawEdge[]).map(rawToCallEdge);
  }
  async getCallersForIds(calleeIds: string[]): Promise<CallEdge[]> {
    if (calleeIds.length === 0) return [];
    const ph = calleeIds.map(() => '?').join(',');
    return (this.db.prepare(`SELECT * FROM edges WHERE callee_id IN (${ph})`).all(...calleeIds) as unknown as RawEdge[]).map(rawToCallEdge);
  }
  async deleteEdgesForFile(file: string): Promise<void> { this.db.prepare('DELETE FROM edges WHERE caller_file = ? OR callee_file = ?').run(file, file); }
  async deleteOutgoingEdgesForFile(file: string): Promise<void> { this.db.prepare('DELETE FROM edges WHERE caller_file = ?').run(file); }
  async insertEdges(edges: CallEdge[]): Promise<void> {
    const stmt: StatementSync = this.db.prepare(`INSERT INTO edges (caller_id, caller_file, callee_id, callee_file, callee_name, line, confidence, kind, call_type)
      VALUES (@callerId, @callerFile, @calleeId, @calleeFile, @calleeName, @line, @confidence, @kind, @callType)`);
    runTransaction(this.db, () => {
      for (const e of edges) {
        const callerFile = e.callerId.includes('::') ? e.callerId.split('::')[0] : e.callerId;
        const calleeFile = e.calleeId.includes('::') ? e.calleeId.split('::')[0] : null;
        stmt.run({ '@callerId': e.callerId, '@callerFile': callerFile, '@calleeId': e.calleeId, '@calleeFile': calleeFile,
          '@calleeName': e.calleeName, '@line': e.line ?? null, '@confidence': e.confidence, '@kind': e.kind ?? null, '@callType': e.callType ?? null });
      }
    });
  }
  async insertInheritanceEdges(edges: InheritanceEdge[]): Promise<void> {
    const stmt = this.db.prepare('INSERT INTO inheritance_edges (parent_id, child_id, kind) VALUES (@parentId, @childId, @kind)');
    runTransaction(this.db, () => { for (const e of edges) stmt.run({ '@parentId': e.parentId, '@childId': e.childId, '@kind': e.kind ?? null }); });
  }
  async getNode(id: string): Promise<FunctionNode | null> {
    const row = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as RawNode | undefined;
    return row ? rawToFunctionNode(row) : null;
  }
  async getNodesForFile(file: string): Promise<FunctionNode[]> {
    return (this.db.prepare('SELECT * FROM nodes WHERE file_path = ?').all(file) as unknown as RawNode[]).map(rawToFunctionNode);
  }
  async searchNodes(pattern: string, limit = 50): Promise<FunctionNode[]> {
    if (pattern.length >= 3) {
      return (this.db.prepare(`SELECT n.* FROM nodes_fts f JOIN nodes n ON n.id = f.node_id WHERE nodes_fts MATCH ? AND n.is_external = 0 LIMIT ?`).all(pattern, limit) as unknown as RawNode[]).map(rawToFunctionNode);
    }
    return (this.db.prepare('SELECT * FROM nodes WHERE name LIKE ? AND is_external = 0 LIMIT ?').all(`%${pattern}%`, limit) as unknown as RawNode[]).map(rawToFunctionNode);
  }
  async getHubs(limit = 25): Promise<FunctionNode[]> {
    return (this.db.prepare('SELECT * FROM nodes WHERE is_hub = 1 AND is_external = 0 ORDER BY fan_in DESC LIMIT ?').all(limit) as unknown as RawNode[]).map(rawToFunctionNode);
  }
  async getEntryPoints(limit = 50): Promise<FunctionNode[]> {
    return (this.db.prepare('SELECT * FROM nodes WHERE is_entry_point = 1 AND is_external = 0 ORDER BY fan_out DESC LIMIT ?').all(limit) as unknown as RawNode[]).map(rawToFunctionNode);
  }
  async countNodes(): Promise<number> {
    return (this.db.prepare('SELECT COUNT(*) as n FROM nodes WHERE is_external = 0').get() as { n: number }).n;
  }
  async deleteNodesForFile(file: string): Promise<void> {
    const ids = (this.db.prepare('SELECT id FROM nodes WHERE file_path = ?').all(file) as unknown as Array<{ id: string }>).map(r => r.id);
    this.db.prepare('DELETE FROM nodes WHERE file_path = ?').run(file);
    if (ids.length > 0) { const ph = ids.map(() => '?').join(','); this.db.prepare(`DELETE FROM nodes_fts WHERE node_id IN (${ph})`).run(...ids); }
  }
  async insertNodes(nodes: FunctionNode[], hubIds?: Set<string>, entryIds?: Set<string>): Promise<void> {
    const stmt = this.db.prepare(`INSERT OR REPLACE INTO nodes (id, name, file_path, class_name, is_async, language, start_index, end_index, fan_in, fan_out, docstring, signature, is_external, external_kind, is_hub, is_entry_point)
      VALUES (@id, @name, @filePath, @className, @isAsync, @language, @startIndex, @endIndex, @fanIn, @fanOut, @docstring, @signature, @isExternal, @externalKind, @isHub, @isEntryPoint)`);
    const ftsStmt = this.db.prepare('INSERT OR REPLACE INTO nodes_fts (node_id, name) VALUES (?, ?)');
    runTransaction(this.db, () => {
      for (const n of nodes) {
        stmt.run({ '@id': n.id, '@name': n.name, '@filePath': n.filePath, '@className': n.className ?? null, '@isAsync': n.isAsync ? 1 : 0,
          '@language': n.language, '@startIndex': n.startIndex, '@endIndex': n.endIndex, '@fanIn': n.fanIn, '@fanOut': n.fanOut,
          '@docstring': n.docstring ?? null, '@signature': n.signature ?? null, '@isExternal': n.isExternal ? 1 : 0,
          '@externalKind': n.externalKind ?? null, '@isHub': hubIds ? (hubIds.has(n.id) ? 1 : 0) : 0, '@isEntryPoint': entryIds ? (entryIds.has(n.id) ? 1 : 0) : 0 });
        if (!n.isExternal) ftsStmt.run(n.id, n.name);
      }
    });
  }
  async getClass(id: string): Promise<ClassNode | null> {
    const row = this.db.prepare('SELECT * FROM classes WHERE id = ?').get(id) as RawClass | undefined;
    return row ? rawToClassNode(row) : null;
  }
  async getClassesForFile(file: string): Promise<ClassNode[]> {
    return (this.db.prepare('SELECT * FROM classes WHERE file_path = ?').all(file) as unknown as RawClass[]).map(rawToClassNode);
  }
  async deleteClassesForFile(file: string): Promise<void> { this.db.prepare('DELETE FROM classes WHERE file_path = ?').run(file); }
  async insertClasses(classes: ClassNode[]): Promise<void> {
    const stmt = this.db.prepare(`INSERT OR REPLACE INTO classes (id, name, file_path, language, parent_classes, interfaces, method_ids, fan_in, fan_out, is_module)
      VALUES (@id, @name, @filePath, @language, @parentClasses, @interfaces, @methodIds, @fanIn, @fanOut, @isModule)`);
    runTransaction(this.db, () => {
      for (const c of classes) stmt.run({ '@id': c.id, '@name': c.name, '@filePath': c.filePath, '@language': c.language,
        '@parentClasses': JSON.stringify(c.parentClasses), '@interfaces': JSON.stringify(c.interfaces), '@methodIds': JSON.stringify(c.methodIds),
        '@fanIn': c.fanIn, '@fanOut': c.fanOut, '@isModule': c.isModule ? 1 : 0 });
    });
  }
  async getFileHash(filePath: string): Promise<string | null> {
    const row = this.db.prepare('SELECT content_hash FROM file_hashes WHERE file_path = ?').get(filePath) as { content_hash: string } | undefined;
    return row?.content_hash ?? null;
  }
  async setFileHash(filePath: string, hash: string): Promise<void> {
    this.db.prepare('INSERT OR REPLACE INTO file_hashes (file_path, content_hash, updated_at) VALUES (?, ?, ?)').run(filePath, hash, Date.now());
  }
  async clearAll(): Promise<void> {
    this.db.exec('DELETE FROM edges; DELETE FROM inheritance_edges; DELETE FROM nodes; DELETE FROM classes; DELETE FROM nodes_fts; DELETE FROM file_hashes;');
  }
  async transaction(fn: () => void | Promise<void>): Promise<void> {
    // node:sqlite синхронен; fn может быть async, но его awaited-операции — методы этого же стора (sync под капотом),
    // поэтому BEGIN→await fn()→COMMIT не допускает реального чередования. runTransaction обёрнут для async fn.
    const depth = txDepth.get(this.db) ?? 0; const sp = `sp${depth}`;
    if (depth === 0) this.db.exec('BEGIN'); else this.db.exec(`SAVEPOINT ${sp}`);
    txDepth.set(this.db, depth + 1);
    try { await fn(); if (depth === 0) this.db.exec('COMMIT'); else this.db.exec(`RELEASE ${sp}`); }
    catch (err) { if (depth === 0) this.db.exec('ROLLBACK'); else this.db.exec(`ROLLBACK TO ${sp}`); throw err; }
    finally { txDepth.set(this.db, depth); }
  }
  async close(): Promise<void> { this.db.close(); }
}

// ── Postgres backend (distributed, OPENLORE_PG_URL) ───────────────────────────
// Таблицы ol_* с колонкой ws (= hash рабочего каталога) — мульти-воркспейс в одной БД. Имена колонок совпадают
// с SQLite (rawTo* переиспользуются). is_* хранятся как int 0/1 (rawTo* сверяет ===1). search — ILIKE-подстрока.
/* eslint-disable @typescript-eslint/no-explicit-any */
class PgBackend implements EdgeStore {
  private constructor(private pool: any, private ws: string) {}

  private q(sql: string, params: unknown[] = []): Promise<{ rows: any[] }> { return this.pool.query(sql, params); }

  static async create(dbPath: string): Promise<PgBackend> {
    const pg = (await import('pg')).default as any;
    const pool = new pg.Pool({ connectionString: process.env.OPENLORE_PG_URL });
    const ws = createHash('sha1').update(dbPath).digest('hex').slice(0, 16);
    await PgBackend.ensureSchema(pool);
    return new PgBackend(pool, ws);
  }
  static async ensureSchema(pool: any): Promise<void> {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ol_edges ( ws text NOT NULL, caller_id text NOT NULL, caller_file text NOT NULL,
        callee_id text NOT NULL, callee_file text, callee_name text NOT NULL, line int, confidence text, kind text, call_type text );
      CREATE INDEX IF NOT EXISTS ol_edges_caller ON ol_edges(ws, caller_id);
      CREATE INDEX IF NOT EXISTS ol_edges_callee ON ol_edges(ws, callee_id);
      CREATE INDEX IF NOT EXISTS ol_edges_cfile  ON ol_edges(ws, caller_file);
      CREATE INDEX IF NOT EXISTS ol_edges_efile  ON ol_edges(ws, callee_file);
      CREATE TABLE IF NOT EXISTS ol_inheritance_edges ( ws text NOT NULL, parent_id text NOT NULL, child_id text NOT NULL, kind text );
      CREATE TABLE IF NOT EXISTS ol_nodes ( ws text NOT NULL, id text NOT NULL, name text NOT NULL, file_path text NOT NULL,
        class_name text, is_async int NOT NULL DEFAULT 0, language text NOT NULL DEFAULT '', start_index int NOT NULL DEFAULT 0,
        end_index int NOT NULL DEFAULT 0, fan_in int NOT NULL DEFAULT 0, fan_out int NOT NULL DEFAULT 0, docstring text, signature text,
        is_external int NOT NULL DEFAULT 0, external_kind text, is_hub int NOT NULL DEFAULT 0, is_entry_point int NOT NULL DEFAULT 0,
        PRIMARY KEY (ws, id) );
      CREATE INDEX IF NOT EXISTS ol_nodes_file ON ol_nodes(ws, file_path);
      CREATE INDEX IF NOT EXISTS ol_nodes_name ON ol_nodes(ws, name);
      CREATE TABLE IF NOT EXISTS ol_classes ( ws text NOT NULL, id text NOT NULL, name text NOT NULL, file_path text NOT NULL,
        language text NOT NULL DEFAULT '', parent_classes text NOT NULL DEFAULT '[]', interfaces text NOT NULL DEFAULT '[]',
        method_ids text NOT NULL DEFAULT '[]', fan_in int NOT NULL DEFAULT 0, fan_out int NOT NULL DEFAULT 0, is_module int NOT NULL DEFAULT 0,
        PRIMARY KEY (ws, id) );
      CREATE INDEX IF NOT EXISTS ol_classes_file ON ol_classes(ws, file_path);
      CREATE TABLE IF NOT EXISTS ol_file_hashes ( ws text NOT NULL, file_path text NOT NULL, content_hash text NOT NULL, updated_at bigint NOT NULL, PRIMARY KEY (ws, file_path) );
    `);
  }

  async getCallerFiles(calleeFile: string): Promise<string[]> {
    const { rows } = await this.q('SELECT DISTINCT caller_file FROM ol_edges WHERE ws=$1 AND callee_file=$2', [this.ws, calleeFile]);
    return rows.map(r => r.caller_file);
  }
  async getEdgesForFile(file: string): Promise<{ outgoing: CallEdge[]; incoming: CallEdge[] }> {
    const out = await this.q('SELECT * FROM ol_edges WHERE ws=$1 AND caller_file=$2', [this.ws, file]);
    const inc = await this.q('SELECT * FROM ol_edges WHERE ws=$1 AND callee_file=$2', [this.ws, file]);
    return { outgoing: out.rows.map(rawToCallEdge), incoming: inc.rows.map(rawToCallEdge) };
  }
  async getCallees(nodeId: string): Promise<CallEdge[]> {
    return (await this.q('SELECT * FROM ol_edges WHERE ws=$1 AND caller_id=$2', [this.ws, nodeId])).rows.map(rawToCallEdge);
  }
  async getCallers(nodeId: string): Promise<CallEdge[]> {
    return (await this.q('SELECT * FROM ol_edges WHERE ws=$1 AND callee_id=$2', [this.ws, nodeId])).rows.map(rawToCallEdge);
  }
  async getCalleesForIds(callerIds: string[]): Promise<CallEdge[]> {
    if (callerIds.length === 0) return [];
    return (await this.q('SELECT * FROM ol_edges WHERE ws=$1 AND caller_id = ANY($2)', [this.ws, callerIds])).rows.map(rawToCallEdge);
  }
  async getCallersForIds(calleeIds: string[]): Promise<CallEdge[]> {
    if (calleeIds.length === 0) return [];
    return (await this.q('SELECT * FROM ol_edges WHERE ws=$1 AND callee_id = ANY($2)', [this.ws, calleeIds])).rows.map(rawToCallEdge);
  }
  async deleteEdgesForFile(file: string): Promise<void> { await this.q('DELETE FROM ol_edges WHERE ws=$1 AND (caller_file=$2 OR callee_file=$2)', [this.ws, file]); }
  async deleteOutgoingEdgesForFile(file: string): Promise<void> { await this.q('DELETE FROM ol_edges WHERE ws=$1 AND caller_file=$2', [this.ws, file]); }
  async insertEdges(edges: CallEdge[]): Promise<void> {
    for (let i = 0; i < edges.length; i += 500) await this.insertEdgesBatch(edges.slice(i, i + 500));
  }
  private async insertEdgesBatch(edges: CallEdge[]): Promise<void> {
    if (edges.length === 0) return;
    const cols = 10;
    const vals: unknown[] = []; const tuples: string[] = [];
    edges.forEach((e, j) => {
      const callerFile = e.callerId.includes('::') ? e.callerId.split('::')[0] : e.callerId;
      const calleeFile = e.calleeId.includes('::') ? e.calleeId.split('::')[0] : null;
      const b = j * cols;
      tuples.push(`(${Array.from({ length: cols }, (_, k) => '$' + (b + k + 1)).join(',')})`);
      vals.push(this.ws, e.callerId, callerFile, e.calleeId, calleeFile, e.calleeName, e.line ?? null, e.confidence, e.kind ?? null, e.callType ?? null);
    });
    await this.q(`INSERT INTO ol_edges (ws, caller_id, caller_file, callee_id, callee_file, callee_name, line, confidence, kind, call_type) VALUES ${tuples.join(',')}`, vals);
  }
  async insertInheritanceEdges(edges: InheritanceEdge[]): Promise<void> {
    for (let i = 0; i < edges.length; i += 500) {
      const batch = edges.slice(i, i + 500); if (batch.length === 0) continue;
      const vals: unknown[] = []; const tuples: string[] = [];
      batch.forEach((e, j) => { const b = j * 4; tuples.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4})`); vals.push(this.ws, e.parentId, e.childId, e.kind ?? null); });
      await this.q(`INSERT INTO ol_inheritance_edges (ws, parent_id, child_id, kind) VALUES ${tuples.join(',')}`, vals);
    }
  }
  async getNode(id: string): Promise<FunctionNode | null> {
    const { rows } = await this.q('SELECT * FROM ol_nodes WHERE ws=$1 AND id=$2', [this.ws, id]);
    return rows[0] ? rawToFunctionNode(rows[0] as RawNode) : null;
  }
  async getNodesForFile(file: string): Promise<FunctionNode[]> {
    return (await this.q('SELECT * FROM ol_nodes WHERE ws=$1 AND file_path=$2', [this.ws, file])).rows.map(r => rawToFunctionNode(r as RawNode));
  }
  async searchNodes(pattern: string, limit = 50): Promise<FunctionNode[]> {
    return (await this.q('SELECT * FROM ol_nodes WHERE ws=$1 AND is_external=0 AND name ILIKE $2 LIMIT $3', [this.ws, `%${pattern}%`, limit])).rows.map(r => rawToFunctionNode(r as RawNode));
  }
  async getHubs(limit = 25): Promise<FunctionNode[]> {
    return (await this.q('SELECT * FROM ol_nodes WHERE ws=$1 AND is_hub=1 AND is_external=0 ORDER BY fan_in DESC LIMIT $2', [this.ws, limit])).rows.map(r => rawToFunctionNode(r as RawNode));
  }
  async getEntryPoints(limit = 50): Promise<FunctionNode[]> {
    return (await this.q('SELECT * FROM ol_nodes WHERE ws=$1 AND is_entry_point=1 AND is_external=0 ORDER BY fan_out DESC LIMIT $2', [this.ws, limit])).rows.map(r => rawToFunctionNode(r as RawNode));
  }
  async countNodes(): Promise<number> {
    return Number((await this.q('SELECT COUNT(*)::int AS n FROM ol_nodes WHERE ws=$1 AND is_external=0', [this.ws])).rows[0].n);
  }
  async deleteNodesForFile(file: string): Promise<void> { await this.q('DELETE FROM ol_nodes WHERE ws=$1 AND file_path=$2', [this.ws, file]); }
  async insertNodes(nodes: FunctionNode[], hubIds?: Set<string>, entryIds?: Set<string>): Promise<void> {
    const cols = 17;
    for (let i = 0; i < nodes.length; i += 300) {
      const batch = nodes.slice(i, i + 300); if (batch.length === 0) continue;
      const vals: unknown[] = []; const tuples: string[] = [];
      batch.forEach((n, j) => {
        const b = j * cols;
        tuples.push(`(${Array.from({ length: cols }, (_, k) => '$' + (b + k + 1)).join(',')})`);
        vals.push(this.ws, n.id, n.name, n.filePath, n.className ?? null, n.isAsync ? 1 : 0, n.language, n.startIndex, n.endIndex,
          n.fanIn, n.fanOut, n.docstring ?? null, n.signature ?? null, n.isExternal ? 1 : 0, n.externalKind ?? null,
          hubIds ? (hubIds.has(n.id) ? 1 : 0) : 0, entryIds ? (entryIds.has(n.id) ? 1 : 0) : 0);
      });
      await this.q(`INSERT INTO ol_nodes (ws, id, name, file_path, class_name, is_async, language, start_index, end_index, fan_in, fan_out, docstring, signature, is_external, external_kind, is_hub, is_entry_point)
        VALUES ${tuples.join(',')} ON CONFLICT (ws, id) DO UPDATE SET
          name=EXCLUDED.name, file_path=EXCLUDED.file_path, class_name=EXCLUDED.class_name, is_async=EXCLUDED.is_async,
          language=EXCLUDED.language, start_index=EXCLUDED.start_index, end_index=EXCLUDED.end_index, fan_in=EXCLUDED.fan_in,
          fan_out=EXCLUDED.fan_out, docstring=EXCLUDED.docstring, signature=EXCLUDED.signature, is_external=EXCLUDED.is_external,
          external_kind=EXCLUDED.external_kind, is_hub=EXCLUDED.is_hub, is_entry_point=EXCLUDED.is_entry_point`, vals);
    }
  }
  async getClass(id: string): Promise<ClassNode | null> {
    const { rows } = await this.q('SELECT * FROM ol_classes WHERE ws=$1 AND id=$2', [this.ws, id]);
    return rows[0] ? rawToClassNode(rows[0] as RawClass) : null;
  }
  async getClassesForFile(file: string): Promise<ClassNode[]> {
    return (await this.q('SELECT * FROM ol_classes WHERE ws=$1 AND file_path=$2', [this.ws, file])).rows.map(r => rawToClassNode(r as RawClass));
  }
  async deleteClassesForFile(file: string): Promise<void> { await this.q('DELETE FROM ol_classes WHERE ws=$1 AND file_path=$2', [this.ws, file]); }
  async insertClasses(classes: ClassNode[]): Promise<void> {
    const cols = 11;
    for (let i = 0; i < classes.length; i += 300) {
      const batch = classes.slice(i, i + 300); if (batch.length === 0) continue;
      const vals: unknown[] = []; const tuples: string[] = [];
      batch.forEach((c, j) => {
        const b = j * cols;
        tuples.push(`(${Array.from({ length: cols }, (_, k) => '$' + (b + k + 1)).join(',')})`);
        vals.push(this.ws, c.id, c.name, c.filePath, c.language, JSON.stringify(c.parentClasses), JSON.stringify(c.interfaces), JSON.stringify(c.methodIds), c.fanIn, c.fanOut, c.isModule ? 1 : 0);
      });
      await this.q(`INSERT INTO ol_classes (ws, id, name, file_path, language, parent_classes, interfaces, method_ids, fan_in, fan_out, is_module)
        VALUES ${tuples.join(',')} ON CONFLICT (ws, id) DO UPDATE SET
          name=EXCLUDED.name, file_path=EXCLUDED.file_path, language=EXCLUDED.language, parent_classes=EXCLUDED.parent_classes,
          interfaces=EXCLUDED.interfaces, method_ids=EXCLUDED.method_ids, fan_in=EXCLUDED.fan_in, fan_out=EXCLUDED.fan_out, is_module=EXCLUDED.is_module`, vals);
    }
  }
  async getFileHash(filePath: string): Promise<string | null> {
    const { rows } = await this.q('SELECT content_hash FROM ol_file_hashes WHERE ws=$1 AND file_path=$2', [this.ws, filePath]);
    return rows[0]?.content_hash ?? null;
  }
  async setFileHash(filePath: string, hash: string): Promise<void> {
    await this.q('INSERT INTO ol_file_hashes (ws, file_path, content_hash, updated_at) VALUES ($1,$2,$3,$4) ON CONFLICT (ws, file_path) DO UPDATE SET content_hash=EXCLUDED.content_hash, updated_at=EXCLUDED.updated_at', [this.ws, filePath, hash, Date.now()]);
  }
  async clearAll(): Promise<void> {
    for (const t of ['ol_edges', 'ol_inheritance_edges', 'ol_nodes', 'ol_classes', 'ol_file_hashes']) await this.q(`DELETE FROM ${t} WHERE ws=$1`, [this.ws]);
  }
  async transaction(fn: () => void | Promise<void>): Promise<void> {
    // Каждый insert*-метод атомарен (один multi-row INSERT). Кросс-методная атомарность watcher'а не критична —
    // инкрементальное обновление; сбой бросит и оставит частично применённым предыдущий метод (допустимо, fail-loud).
    await fn();
  }
  async close(): Promise<void> { await this.pool.end(); }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ── Public facade (тип EdgeStore выше; здесь — статики open/exists/dbPath) ─────
export const EdgeStore = {
  /** Открыть стор. OPENLORE_PG_URL → Postgres-бэкенд, иначе SQLite (как раньше). async (Postgres-connect). */
  async open(dbPath: string): Promise<EdgeStore> {
    if (process.env.OPENLORE_PG_URL) return PgBackend.create(dbPath);
    return new SqliteBackend(openDatabase(dbPath));
  },
  /** Построен ли граф. SQLite: файл существует. Postgres: есть строки ol_nodes для этого ws. async. */
  async exists(outputDir: string): Promise<boolean> {
    if (process.env.OPENLORE_PG_URL) {
      try {
        const pg = (await import('pg')).default as any;
        const pool = new pg.Pool({ connectionString: process.env.OPENLORE_PG_URL });
        try {
          await PgBackend.ensureSchema(pool);
          const ws = createHash('sha1').update(EdgeStore.dbPath(outputDir)).digest('hex').slice(0, 16);
          const { rows } = await pool.query('SELECT 1 FROM ol_nodes WHERE ws=$1 LIMIT 1', [ws]);
          return rows.length > 0;
        } finally { await pool.end(); }
      } catch { return false; }
    }
    return existsSync(join(outputDir, ARTIFACT_CALL_GRAPH_DB));
  },
  dbPath(outputDir: string): string { return join(outputDir, ARTIFACT_CALL_GRAPH_DB); },
};

// ── Internal raw types + mappers (переиспользуются обоими бэкендами) ───────────
interface RawEdge { caller_id: string; caller_file: string; callee_id: string; callee_file: string | null; callee_name: string; line: number | null; confidence: string; kind: string | null; call_type: string | null; }
interface RawNode { id: string; name: string; file_path: string; class_name: string | null; is_async: number; language: string; start_index: number; end_index: number; fan_in: number; fan_out: number; docstring: string | null; signature: string | null; is_external: number; external_kind: string | null; is_hub: number; is_entry_point: number; }
interface RawClass { id: string; name: string; file_path: string; language: string; parent_classes: string; interfaces: string; method_ids: string; fan_in: number; fan_out: number; is_module: number; }

function rawToCallEdge(r: RawEdge): CallEdge {
  return { callerId: r.caller_id, calleeId: r.callee_id, calleeName: r.callee_name, ...(r.line !== null && { line: r.line }),
    confidence: r.confidence as CallEdge['confidence'], ...(r.kind && { kind: r.kind as CallEdge['kind'] }), ...(r.call_type && { callType: r.call_type as CallEdge['callType'] }) };
}
function rawToFunctionNode(r: RawNode): FunctionNode {
  return { id: r.id, name: r.name, filePath: r.file_path, ...(r.class_name && { className: r.class_name }), isAsync: r.is_async === 1,
    language: r.language, startIndex: r.start_index, endIndex: r.end_index, fanIn: r.fan_in, fanOut: r.fan_out,
    ...(r.docstring && { docstring: r.docstring }), ...(r.signature && { signature: r.signature }),
    ...(r.is_external && { isExternal: true }), ...(r.external_kind && { externalKind: r.external_kind as FunctionNode['externalKind'] }) };
}
function rawToClassNode(r: RawClass): ClassNode {
  return { id: r.id, name: r.name, filePath: r.file_path, language: r.language, parentClasses: JSON.parse(r.parent_classes) as string[],
    interfaces: JSON.parse(r.interfaces) as string[], methodIds: JSON.parse(r.method_ids) as string[], fanIn: r.fan_in, fanOut: r.fan_out, ...(r.is_module && { isModule: true }) };
}
