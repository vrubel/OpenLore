/**
 * The ONE way to open the call-graph index, at the access this process actually
 * holds over the repository it belongs to.
 *
 * `EdgeStore.open` is a WRITE, and not an obvious one: it runs
 * `PRAGMA journal_mode = WAL` (rewriting the file header and dropping `-wal`/`-shm`
 * beside the database), `CREATE TABLE IF NOT EXISTS` on every open, and — when
 * `SCHEMA_VERSION` has moved — `DROP TABLE` over every table in the index.
 *
 * That matters because the index is opened from READ paths. `readCachedContext`
 * reaches it for every read-only tool, and `AnchorContext.open` reaches it from
 * `recall`, `verify_claim`, `record_decision` and the impact certificate — so
 * "a repository granted for reading is never modified" was false at two doors, and
 * fixing one of them (as the first attempt did) left the other wide open: a
 * neighbour with an older schema lost its whole index to a `recall`.
 *
 * Hence a single entry point rather than a check per call site. A perimeter made of
 * individually-remembered doors is not a perimeter; it is a list, and lists go stale.
 */

import { EdgeStore } from './edge-store.js';
import { isPathAllowed } from './mcp-handlers/root-allowlist.js';
import { logger } from '../../utils/logger.js';

/** Why the index could not be served, when it could not. Empty when it was. */
export type EdgeStoreWithheldReason =
  | 'schema-needs-rebuild'   // read-only handle, schema predates this version
  | 'unopenable-read-only';  // read-only handle could not be established at all

export interface EdgeStoreOpenResult {
  store: EdgeStore | null;
  /** Set when `store` is null BECAUSE of the perimeter, not because there is no index. */
  withheld?: EdgeStoreWithheldReason;
  /** Operator-facing explanation for `withheld`. */
  reason?: string;
}

/**
 * Open the index under `analysisDir` for whatever access the perimeter grants.
 *
 * Writable repository → the ordinary read-write handle, byte-for-byte as before.
 * Read-only repository → an `immutable` handle that leaves NOTHING behind (a plain
 * `readOnly: true` connection still materializes `-shm` and `-wal` inside the other
 * repository — measured, not assumed).
 *
 * Never throws. Returns `store: null` with a `withheld` reason when the index
 * exists but cannot be served, so the CALLER can tell the agent why instead of
 * returning an empty graph that reads as "this repository was never analyzed".
 */
export function openEdgeStoreForPerimeter(analysisDir: string): EdgeStoreOpenResult {
  if (!EdgeStore.exists(analysisDir)) return { store: null };
  const dbPath = EdgeStore.dbPath(analysisDir);

  if (isPathAllowed(dbPath, 'write')) {
    try {
      return { store: EdgeStore.open(dbPath) };
    } catch (err) {
      return {
        store: null,
        withheld: 'unopenable-read-only',
        reason: `${dbPath} could not be opened: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  try {
    const ro = EdgeStore.openReadOnly(dbPath);
    if (!ro.readOnlyUnusable) return { store: ro };
    ro.close();
    const reason =
      `${dbPath} cannot be served read-only: its schema predates this version, and rebuilding it would ` +
      `be a write into a repository this server may only read. Re-run "openlore analyze --force" there, ` +
      `or start the server with --write-root for it.`;
    logger.warning(reason);
    return { store: null, withheld: 'schema-needs-rebuild', reason };
  } catch (err) {
    const reason =
      `${dbPath} could not be opened read-only (${err instanceof Error ? err.message : String(err)}). ` +
      `That repository is inside the read perimeter but not the write perimeter, so its index is not ` +
      `opened for writing.`;
    logger.warning(reason);
    return { store: null, withheld: 'unopenable-read-only', reason };
  }
}
