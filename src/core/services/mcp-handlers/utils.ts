/**
 * Shared utilities for MCP tool handlers.
 */

import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import type { LLMContext } from '../../analyzer/artifact-generator.js';
import { MAX_STRING_LENGTH } from '../../analyzer/artifact-json.js';
import { EdgeStore } from '../edge-store.js';
import { ANALYSIS_STALE_THRESHOLD_MS, ARTIFACT_FINGERPRINT, ARTIFACT_LLM_CONTEXT, MAX_QUERY_LENGTH, OPENLORE_ANALYSIS_SUBDIR, OPENLORE_DIR, OPENSPEC_DIR } from '../../../constants.js';

/** LLMContext with optional SQLite edge store attached (present when call-graph.db exists). */
export type CachedContext = LLMContext & { edgeStore?: EdgeStore };

/**
 * Attach the call graph to a context read from disk (PDLC-156).
 *
 * `llm-context.json` no longer carries `callGraph` — it lives in call-graph.db,
 * which is where it was already being written. The property is re-attached here
 * as a LAZY getter over the store: a tool that never touches the graph never pays
 * to materialize it, and one that does sees exactly the object the artifact used
 * to hold (same arrays, same order — the store keeps the serialized positions).
 *
 * Two things this deliberately does NOT do:
 *   • it does not fabricate an empty graph. An empty/absent store yields
 *     `undefined`, which every graph tool already reports as "re-run analyze";
 *   • it does not override a graph that IS present in the JSON. An analysis taken
 *     by an older version still carries one inline, and keeps working unchanged.
 */
export function attachCallGraph(ctx: CachedContext, store: EdgeStore | undefined): void {
  if (ctx.callGraph !== undefined || !store) return;
  let materialized: LLMContext['callGraph'] | undefined;
  let done = false;
  Object.defineProperty(ctx, 'callGraph', {
    configurable: true,
    enumerable: true,
    get() {
      if (!done) {
        done = true;
        try {
          materialized = store.materializeCallGraph() ?? undefined;
        } catch (err) {
          // The read used to be a plain property on a parsed object and could not
          // fail. Now it touches SQLite — and it is reached from handler code that
          // sits OUTSIDE readCachedContext's catch, so an evicted/closed handle
          // ("database is not open") would surface as a tool crash. Degrade to the
          // same "no call graph" every handler already reports, and say why.
          logger.warning(
            `Could not read the call graph from the store: ${err instanceof Error ? err.message : String(err)}. ` +
            `Re-run "openlore analyze --force" if this persists.`
          );
          materialized = undefined;
        }
      }
      return materialized;
    },
    set(v: LLMContext['callGraph']) {
      done = true;
      materialized = v;
    },
  });
}
import { logger } from '../../../utils/logger.js';
import { emit } from '../telemetry.js';
import { redactSecretString } from '../secret-redaction.js';

/**
 * Resolve and validate a user-supplied directory path.
 *
 * Ensures the path resolves to an existing directory, which prevents path
 * traversal attacks where a client supplies `"../../../../etc"` or a plain
 * file path instead of a project directory.
 */
export async function validateDirectory(directory: string, maxDepth?: number): Promise<string> {
  logger.debug(`Validating directory: ${directory}`);
  return validateDirectoryImpl(directory, maxDepth);
}

export async function validateDirectoryImpl(directory: string, maxDepth?: number): Promise<string> {
  if (!directory || typeof directory !== 'string') {
    logger.warning('Directory validation failed: directory parameter is required and must be a string');
    throw new Error('directory parameter is required and must be a string');
  }
  const absDir = resolve(directory);
  logger.debug(`Resolved directory path: ${absDir}`);

  // Validate directory traversal depth if maxDepth is specified
  if (maxDepth !== undefined) {
    validateDirectoryDepth(absDir, maxDepth);
  }

  let s: Awaited<ReturnType<typeof stat>>;
  try {
    s = await stat(absDir);
  } catch {
    logger.error(`Directory validation failed: Directory not found: ${absDir}`);
    throw new Error(`Directory not found: ${absDir}`);
  }
  if (!s.isDirectory()) {
    logger.error(`Directory validation failed: Not a directory: ${absDir}`);
    throw new Error(`Not a directory: ${absDir}`);
  }
  logger.success(`Successfully validated directory: ${absDir}`);
  return absDir;
}

function calculateDirectoryDepth(path: string): number {
  const normalizedPath = path.replace(/^\\|\\$/g, '');
  const segments = normalizedPath.split(/[\\/]/);
  return segments.length;
}

export function validateDirectoryDepth(absDir: string, maxDepth: number): void {
  const depth = calculateDirectoryDepth(absDir);
  if (depth > maxDepth) {
    logger.error(`Directory validation failed: Directory depth ${depth} exceeds maximum allowed depth of ${maxDepth}`);
    throw new Error(`Directory depth ${depth} exceeds maximum allowed depth of ${maxDepth}`);
  }
}

/**
 * Strip common API key and token patterns from an error message before
 * returning it to MCP clients, to prevent secret leakage via error responses.
 * 
 * @param err - The error to sanitize
 * @param format - Output format: "string" (default) or "json"
 * @returns Sanitized error as string or {message, code} object when format is "json"
 */
export function sanitizeMcpError(err: unknown, format: 'string' | 'json' = 'string'): string | { message: string; code: number } {
  const rawMessage = err instanceof Error ? err.message : String(err);
  // Shared credential-redaction patterns (see secret-redaction.ts) so error text
  // and every other output channel scrub the same set.
  const sanitized = redactSecretString(rawMessage);

  if (format === 'json') {
    const errCode = err instanceof Error ? (err as Error & { code?: unknown }).code : undefined;
    const code = typeof errCode === 'number' ? errCode : 500;
    return { message: sanitized, code };
  }
  
  return sanitized;
}

/**
 * The canonical (symlink-resolved) path of `p`, or — when `p` does not exist (a
 * write target) — the canonical path of its nearest existing ancestor. Used to
 * confine on the REAL filesystem location rather than the lexical path.
 */
function realPathOrNearestExisting(p: string): string {
  let cur = p;
  for (;;) {
    try {
      return realpathSync(cur);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const parent = dirname(cur);
      if (parent === cur) return cur; // reached filesystem root
      cur = parent;
    }
  }
}

/**
 * Resolve a user-supplied relative file path against a validated project root and
 * ensure the result stays within that root — by BOTH a lexical check (cheap, blocks
 * `../` traversal) AND a canonical, symlink-resolved check (mcp-security:
 * Symlink-Aware Path Confinement). The canonical check defeats an in-root symlink
 * that points outside the root: confinement is enforced on the real path of the
 * target where it exists, and on the real path of its nearest existing ancestor
 * where it does not (so a not-yet-created write target is confined too).
 */
export function safeJoin(absDir: string, filePath: string): string {
  const resolved = resolve(absDir, filePath);
  if (!resolved.startsWith(absDir + sep) && resolved !== absDir) {
    throw new Error(`Path traversal blocked: "${filePath}" resolves outside project directory`);
  }
  // Canonical (symlink-aware) confinement. realpath the root (it exists — it was
  // validated) and the target's real location; reject if the real target escapes.
  try {
    const realRoot = realpathSync(absDir);
    const realTarget = realPathOrNearestExisting(resolved);
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
      throw new Error(`Path escape blocked: "${filePath}" canonicalizes outside the project directory`);
    }
  } catch (err) {
    // A "Path escape blocked" error must propagate; only swallow realpath I/O errors
    // on the root itself (which would be unexpected for a validated root).
    if (err instanceof Error && err.message.startsWith('Path escape blocked')) throw err;
  }
  return resolved;
}

/**
 * Bound a free-text query/description argument before it drives an embedding call
 * or BM25 tokenization (mcp-security: Bounded Computation — a hostile caller could
 * otherwise send a multi-megabyte string and force unbounded work or a huge
 * provider request). Returns an `{ error }` object to return verbatim when the
 * input exceeds MAX_QUERY_LENGTH, or null when it is within bounds.
 */
export function queryTooLongError(query: unknown, field = 'query'): { error: string } | null {
  if (typeof query === 'string' && query.length > MAX_QUERY_LENGTH) {
    return { error: `${field} too long: ${query.length} characters (max ${MAX_QUERY_LENGTH}). Shorten the ${field}.` };
  }
  return null;
}

/**
 * Resolve the project's openspec directory, confined to the validated root.
 *
 * `config.openspecPath` is read from `.openlore/config.json` — an untrusted on-disk
 * artifact (mcp-security threat model). A poisoned value (`../../etc`, an absolute
 * escape) must not redirect the reads/writes that derive from it (spec/manifest
 * reads, decision ADR reads, decision sync writes) outside the project root. We
 * confine via safeJoin; a value that escapes the root falls back to the default
 * `openspec/` dir — a legitimate in-root path (default or custom) passes through
 * unchanged, so only an escaping value is neutralized.
 */
export function safeOpenspecDir(absRoot: string, configuredPath: string | undefined): string {
  try {
    return safeJoin(absRoot, configuredPath && configuredPath.length > 0 ? configuredPath : OPENSPEC_DIR);
  } catch {
    return safeJoin(absRoot, OPENSPEC_DIR);
  }
}

interface ContextCacheEntry {
  ctx: CachedContext;
  mtime: number;
}

/** One entry per project directory. Invalidated by llm-context.json mtime change. */
const _contextCache = new Map<string, ContextCacheEntry>();

/** Grace period before closing an evicted EdgeStore so concurrent in-flight
 * requests holding the old handle across an await can drain first. */
const STALE_STORE_CLOSE_DELAY_MS = 30_000;

/** Hard ceiling on the analysis artifact (.openlore/analysis/llm-context.json)
 * before we deserialize it. Real contexts are single-digit MB; this generous cap
 * exists only to fail closed on a poisoned/oversized artifact rather than OOM.
 *
 * Pinned to the V8 string ceiling rather than a round 512 MiB, which sat 24 bytes
 * ABOVE the longest string this runtime can hold. A file in that window passed
 * the size check and then blew up inside readFile — a RangeError that the outer
 * catch swallowed into an anonymous miss, after spending ~1.3 s and ~590 MB RSS
 * reading a file it could never turn into a string. Pinning the cap makes that
 * case a named miss, decided from `stat` alone.
 *
 * Direction of the guarantee: byte length is never BELOW character count, so a
 * file within the cap provably fits in a string — which is what closes the hole.
 * The converse does not hold: a file over the cap may still be short enough in
 * characters (multi-byte UTF-8), so this rejects fail-closed. Hitting that window
 * requires landing in those same 24 bytes. */
const ARTIFACT_MAX_BYTES = MAX_STRING_LENGTH;

/** Test-only: clear in-memory context cache to force cold path. */
export function _resetContextCacheForTesting(): void {
  for (const entry of _contextCache.values()) entry.ctx.edgeStore?.close();
  _contextCache.clear();
}

/**
 * Watch-mode handoff (Spec 13.1). Push an updated context into the in-memory
 * read cache so the next tool call is a cache HIT — no 2.1 MB disk re-parse —
 * even though the watcher only patched a few signatures. Keyed identically to
 * {@link readCachedContext} (resolved project directory).
 *
 * The cached `mtime` is set to the current on-disk `llm-context.json` mtime so
 * the entry stays valid until the file genuinely changes on disk again:
 *   • watcher patches in memory but defers the disk write → disk mtime is
 *     unchanged → this entry matches → hit returns the patched context;
 *   • watcher writes the file then primes → disk mtime is the just-written one
 *     → this entry matches → hit, no cold re-parse of what we just wrote;
 *   • some other process (e.g. `openlore analyze`) rewrites the file → its mtime
 *     differs from this entry → next read MISSes and re-reads disk → correct.
 */
export async function primeContextCache(directory: string, ctx: CachedContext): Promise<void> {
  const analysisDir = join(directory, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
  const filePath = join(analysisDir, ARTIFACT_LLM_CONTEXT);
  let mtime: number;
  try {
    mtime = (await stat(filePath)).mtimeMs;
  } catch {
    return; // no artifact on disk yet — nothing to stay fresh against
  }
  const existing = _contextCache.get(directory);
  // Preserve an already-open EdgeStore handle if the new ctx doesn't carry one.
  if (existing?.ctx.edgeStore && !ctx.edgeStore) {
    ctx.edgeStore = existing.ctx.edgeStore;
  }
  _contextCache.set(directory, { ctx, mtime });
}

export async function readCachedContext(directory: string, timeout?: number): Promise<CachedContext | null> {
  const analysisDir = join(directory, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
  const filePath = join(analysisDir, ARTIFACT_LLM_CONTEXT);

  async function load(): Promise<CachedContext | null> {
    try {
      const st = await stat(filePath);
      const mtime = st.mtimeMs;
      const cached = _contextCache.get(directory);
      if (cached && cached.mtime === mtime) {
        emit(directory, 'cache', { event: 'cache_read', hit: true });
        return cached.ctx;
      }
      // mcp-security (Untrusted Artifact Deserialization): the analysis artifact
      // lives under .openlore/ and is treated as untrusted input. Bound its size
      // before reading so a poisoned/oversized file can't OOM the server; legit
      // contexts are single-digit MB, far below this ceiling.
      if (st.size > ARTIFACT_MAX_BYTES) {
        emit(directory, 'cache', { event: 'cache_read', hit: false, reason: 'artifact_too_large', size: st.size });
        // `emit` is a no-op without OPENLORE_TELEMETRY=1, and callers only see a
        // null context — indistinguishable from "no analysis yet", which is what
        // every graph tool then tells the operator to fix by re-running analyze.
        // Say the real reason out loud, or this branch is invisible.
        logger.warning(
          `${ARTIFACT_LLM_CONTEXT} is ${st.size.toLocaleString('en-US')} bytes — over the ` +
          `${ARTIFACT_MAX_BYTES.toLocaleString('en-US')} byte ceiling (the longest string this ` +
          `runtime can hold), so it cannot be loaded. Re-run analyze with a narrower surface ` +
          `(analysis.excludePatterns / --exclude); graph tools stay unavailable until then.`
        );
        return null;
      }
      // Cache miss — read 3.7MB JSON and open EdgeStore connection
      const raw = await readFile(filePath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      // Validate top-level shape before use: a valid context is a non-null,
      // non-array object. Fail closed on null/scalar/array so a malformed or
      // schema-mismatched artifact yields a clean "re-run analyze" result
      // downstream instead of propagating attacker-shaped values.
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        emit(directory, 'cache', { event: 'cache_read', hit: false, reason: 'artifact_shape_invalid' });
        return null;
      }
      const ctx = parsed as CachedContext;
      // Normalize a present callGraph so `nodes`/`edges` are always arrays. A truncated
      // or hand-edited artifact (`{"callGraph": {}}`) — or a minimal one carrying only
      // entryPoints/hubFunctions — would otherwise throw when a handler does
      // `cg.nodes.map(...)`. Coerce the missing/invalid arrays to [] (graceful empty)
      // rather than dropping the whole graph: other handlers (architecture overview)
      // legitimately read entryPoints/hubFunctions without touching nodes/edges. A
      // callGraph that isn't even an object is unusable, so drop that.
      if (ctx.callGraph !== undefined) {
        if (typeof ctx.callGraph === 'object' && ctx.callGraph !== null) {
          const cg = ctx.callGraph as { nodes?: unknown; edges?: unknown };
          if (!Array.isArray(cg.nodes)) cg.nodes = [];
          if (!Array.isArray(cg.edges)) cg.edges = [];
        } else {
          ctx.callGraph = undefined;
        }
      }
      // The call graph now lives ONLY in call-graph.db, so an analysis whose
      // artifact carries no graph is normal — and an analysis whose STORE carries
      // no graph is a real fault that must be audible. `hasAnalysis` is the test
      // for "there is an analysis here at all": if the artifact has content but
      // the graph is missing on both sides, the two are out of sync (interrupted
      // analyze, deleted db, schema bump) and every graph tool is about to answer
      // "no call graph" with no explanation of why.
      const jsonProdNodes = Array.isArray(ctx.callGraph?.nodes)
        ? ctx.callGraph.nodes.filter(n => !n.isExternal && !n.isTest).length
        : 0;
      // "There is an analysis here at all" — used to tell a fresh, empty project
      // apart from an analysis whose graph went missing.
      const hasAnalysis = (ctx.signatures?.length ?? 0) > 0 || (ctx.phase1_survey?.files?.length ?? 0) > 0;
      if (EdgeStore.exists(analysisDir)) {
        const es = EdgeStore.open(EdgeStore.dbPath(analysisDir));
        // Schema-bump guard, for an analysis taken BEFORE the graph moved into the
        // store: opening a DB whose SCHEMA_VERSION is stale wipes it, and serving
        // the empty store next to a JSON that still has production nodes would give
        // silent empty results. Withhold it, as before, so edge-store tools say
        // "re-run analyze_codebase" while the inline graph still answers the rest.
        if ((es.wasReset || jsonProdNodes > 0) && es.countNodes() === 0 && jsonProdNodes > 0) {
          es.close();
        } else {
          // Attach the store — it also carries decisions, provenance and change
          // coupling, which are useful even when the graph is empty — and hang the
          // lazy call graph off it.
          ctx.edgeStore = es;
          attachCallGraph(ctx, es);
          // The graph now lives ONLY here. An empty store next to a real analysis
          // means the two are out of sync (interrupted analyze, deleted db, schema
          // bump): every graph tool is about to answer "no call graph", and without
          // this line that answer is indistinguishable from "no analysis yet".
          if (hasAnalysis && jsonProdNodes === 0 && es.countNodes() === 0) {
            logger.warning(
              es.wasReset
                ? `The call graph index (${EdgeStore.dbPath(analysisDir)}) was reset by a version upgrade and is ` +
                  `empty. Graph tools stay unavailable until "openlore analyze --force" rebuilds it.`
                : `The analysis in ${analysisDir} has no call graph: ${EdgeStore.dbPath(analysisDir)} is empty, ` +
                  `and llm-context.json does not carry one (the graph lives in that database). ` +
                  `Re-run "openlore analyze --force" to rebuild it.`
            );
          }
        }
      } else if (hasAnalysis && jsonProdNodes === 0) {
        logger.warning(
          `The analysis in ${analysisDir} has no call graph: ${EdgeStore.dbPath(analysisDir)} is missing, ` +
          `and llm-context.json does not carry one (the graph lives in that database). ` +
          `Re-run "openlore analyze --force" to rebuild it.`
        );
      }
      // Evict + close the previous entry's EdgeStore — otherwise each cache miss
      // (every `analyze` rewrites llm-context.json's mtime) leaks an open SQLite
      // connection + its WAL fd for the life of a long-lived daemon. The close is
      // DEFERRED: serve dispatches requests concurrently, and a handler may hold
      // the old handle across an await (e.g. get_subgraph awaits a vector search
      // between edgeStore reads). A grace delay lets in-flight requests drain
      // before release, bounding live handles to ~grace/reanalyze-interval.
      const prev = _contextCache.get(directory);
      _contextCache.set(directory, { ctx, mtime });
      if (prev?.ctx.edgeStore && prev.ctx.edgeStore !== ctx.edgeStore) {
        const stale = prev.ctx.edgeStore;
        const t = setTimeout(() => { try { stale.close(); } catch { /* already closed */ } }, STALE_STORE_CLOSE_DELAY_MS);
        t.unref?.();
      }
      emit(directory, 'cache', { event: 'cache_read', hit: true });
      return ctx;
    } catch {
      emit(directory, 'cache', { event: 'cache_read', hit: false });
      return null;
    }
  }

  if (timeout !== undefined && timeout > 0) {
    return Promise.race([
      load(),
      new Promise<null>((_, reject) =>
        setTimeout(() => reject(new Error(`readCachedContext timed out after ${timeout}ms`)), timeout)
      ),
    ]);
  }

  return load();
}

/**
 * Wait for graph rebuild to complete after schema mismatch.
 *
 * When a schema version change is detected, EdgeStore resets itself and
 * McpWatcher spawns a background `openlore analyze --force`. This helper
 * polls until the rebuild completes (edgeStore is populated) or timeout.
 *
 * Used by graph tools (analyze_impact, trace_execution_path) to auto-heal
 * after version upgrades instead of failing immediately.
 *
 * @returns true if rebuild completed (edgeStore now available), false on timeout
 */
export async function waitForGraphRebuild(
  directory: string,
  timeoutMs = 60_000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const pollIntervalMs = 2000;

  while (Date.now() < deadline) {
    const ctx = await readCachedContext(directory);
    // POPULATED, not merely attached. The old test — "is there an edgeStore?" —
    // relied on readCachedContext withholding an empty store, which it could only
    // decide by comparing against the graph inside llm-context.json. That copy is
    // gone (PDLC-156), so an empty post-reset store now attaches like any other
    // and a bare presence check would report "rebuild finished" the instant the
    // reset wiped it — exactly the silent empty graph this helper exists to avoid.
    if (ctx?.edgeStore && ctx.edgeStore.countNodes() > 0) {
      logger.debug(`[waitForGraphRebuild] Graph rebuild completed after ${Date.now() - (deadline - timeoutMs)}ms`);
      return true;
    }

    const remaining = deadline - Date.now();
    if (remaining > 0) {
      await new Promise(r => setTimeout(r, Math.min(pollIntervalMs, remaining)));
    }
  }

  logger.warning(
    `[waitForGraphRebuild] Graph rebuild did not complete within ${timeoutMs}ms timeout. ` +
    'Run "openlore analyze --force" manually to rebuild the call graph.'
  );
  return false;
}

// ============================================================================
// PROJECT FINGERPRINT — content-hash based cache invalidation
// ============================================================================

const FINGERPRINT_SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', '.next', '.openlore',
  'coverage', '.cache', '__pycache__', '.venv', 'venv', 'target',
  '.dart_tool', '.pub-cache',
]);

const FINGERPRINT_SOURCE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.rb', '.java', '.kt', '.swift',
  '.cpp', '.cc', '.cxx', '.c', '.h', '.hpp', '.cs',
]);

async function walkForFingerprint(
  dir: string,
  root: string,
  out: Array<{ path: string; mtime: number; size: number }>
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      // Skip the static skip set AND every OpenLore-managed dir (any `.openlore`
      // prefix: `.openlore` analysis output, `.openlore-live-cache` cloned
      // fixtures, …). These churn independently of the user's source — including
      // them makes the content-hash flap, so isCacheFresh would force needless
      // re-analysis whenever the live-data fixture cache is refreshed.
      if (!FINGERPRINT_SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.openlore')) {
        await walkForFingerprint(join(dir, entry.name), root, out);
      }
    } else if (entry.isFile() && FINGERPRINT_SOURCE_EXTS.has(extname(entry.name))) {
      try {
        const s = await stat(join(dir, entry.name));
        out.push({ path: relative(root, join(dir, entry.name)), mtime: s.mtimeMs, size: s.size });
      } catch {
        // skip unreadable
      }
    }
  }
}

/** Compute a SHA-256 fingerprint of all source file mtimes+sizes under rootDir. */
export async function computeProjectFingerprint(rootDir: string): Promise<string> {
  const files: Array<{ path: string; mtime: number; size: number }> = [];
  await walkForFingerprint(rootDir, rootDir, files);
  files.sort((a, b) => a.path.localeCompare(b.path));
  const payload = files.map(f => `${f.path}:${f.mtime}:${f.size}`).join('\n');
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Returns true if the cached analysis matches the current source files.
 * Uses content-hash fingerprint when available; falls back to TTL check.
 */
export async function isCacheFresh(directory: string): Promise<boolean> {
  const fingerprintPath = join(directory, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_FINGERPRINT);
  try {
    const stored = JSON.parse(await readFile(fingerprintPath, 'utf-8')) as { hash: string };
    const current = await computeProjectFingerprint(directory);
    return current === stored.hash;
  } catch {
    // No fingerprint yet — fall back to TTL
    try {
      const s = await stat(join(directory, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_LLM_CONTEXT));
      return Date.now() - s.mtimeMs < ANALYSIS_STALE_THRESHOLD_MS;
    } catch {
      return false;
    }
  }
}

// ============================================================================
// BIDIRECTIONAL CODE ↔ SPEC LINKING (#4)
// ============================================================================

export interface MappingEntry {
  requirement: string;
  service: string;
  domain: string;
  specFile: string;
  functions: Array<{ name: string; file: string; line: number; kind: string; confidence: string }>;
}

export interface MappingIndex {
  /** filePath → list of mapping entries that reference it */
  byFile: Map<string, MappingEntry[]>;
  /** domain → list of mapping entries for that domain */
  byDomain: Map<string, MappingEntry[]>;
  entries: MappingEntry[];
}

/** Cache for mapping indices, keyed by directory path */
const mappingCache = new Map<string, MappingIndex>();

/** Load and index mapping.json for bidirectional lookup. Returns null if not found. */
export async function loadMappingIndex(absDir: string, retryCount: number = 1): Promise<MappingIndex | null> {
  // Check cache first
  const cacheKey = absDir;
  const cached = mappingCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  
  const loadAttempt = async (attempt: number): Promise<MappingIndex | null> => {
    try {
      const mappingPath = join(absDir, '.openlore', 'analysis', 'mapping.json');
      // mcp-security: "Parsing SHALL bound input size" covers mapping.json too, not
      // just llm-context.json. Without this, an oversized artifact spends the read
      // before failing — and past the string ceiling it cannot be read at all.
      const st = await stat(mappingPath);
      if (st.size > ARTIFACT_MAX_BYTES) {
        logger.warning(
          `mapping.json is ${st.size.toLocaleString('en-US')} bytes — over the ` +
          `${ARTIFACT_MAX_BYTES.toLocaleString('en-US')} byte ceiling, so it cannot be loaded. ` +
          `Re-run analyze with a narrower surface (analysis.excludePatterns / --exclude).`
        );
        return null;
      }
      const raw = await readFile(mappingPath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      // Untrusted artifact: validate top-level shape before use. A malformed
      // mapping.json (non-object, or no `mappings` array) fails closed — retrying
      // can't fix a shape mismatch, so return null directly.
      if (parsed === null || typeof parsed !== 'object' || !Array.isArray((parsed as { mappings?: unknown }).mappings)) {
        return null;
      }
      const data = parsed as { mappings: MappingEntry[] };
      const entries = data.mappings ?? [];
      
      const byFile = new Map<string, MappingEntry[]>();
      const byDomain = new Map<string, MappingEntry[]>();
      
      for (const entry of entries) {
        // index by domain
        const domainList = byDomain.get(entry.domain) ?? [];
        domainList.push(entry);
        byDomain.set(entry.domain, domainList);
        
        // index by each referenced file
        for (const fn of entry.functions) {
          if (!fn.file || fn.file === '*') continue;
          const fileList = byFile.get(fn.file) ?? [];
          // avoid duplicates (same requirement may appear multiple times per file)
          if (!fileList.includes(entry)) fileList.push(entry);
          byFile.set(fn.file, fileList);
        }
      }
      
      const result = { byFile, byDomain, entries };
      // Cache the result
      mappingCache.set(cacheKey, result);
      return result;
    } catch (error) {
      if (attempt < retryCount && error instanceof Error) {
        const delay = Math.pow(2, attempt) * 100; // Exponential backoff: 200ms, 400ms, 800ms...
        await new Promise(resolve => setTimeout(resolve, delay));
        return loadAttempt(attempt + 1);
      }
      return null;
    }
  };
  
  return loadAttempt(1);
}

/** Clear the mapping cache. Useful for tests to reset state. */
export function clearMappingCache(): void {
  mappingCache.clear();
}

/** Summarise which specs cover a given file path (for search_code enrichment). */
export function specsForFile(index: MappingIndex, filePath: string): Array<{ requirement: string; domain: string; specFile: string }> {
  const entries = index.byFile.get(filePath) ?? [];
  // deduplicate by requirement
  const seen = new Set<string>();
  return entries
    .filter(e => { const k = `${e.domain}::${e.requirement}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .map(e => ({ requirement: e.requirement, domain: e.domain, specFile: e.specFile }));
}

/** Return functions that implement a given domain/specFile (for search_specs enrichment). */
export function functionsForDomain(index: MappingIndex, domain: string): Array<{ name: string; file: string; line: number; kind: string; confidence: string; requirement: string }> {
  const entries = index.byDomain.get(domain) ?? [];
  const result: Array<{ name: string; file: string; line: number; kind: string; confidence: string; requirement: string }> = [];
  for (const entry of entries) {
    for (const fn of entry.functions) {
      if (fn.name === '*') continue;
      result.push({ ...fn, requirement: entry.requirement });
    }
  }
  return result;
}
