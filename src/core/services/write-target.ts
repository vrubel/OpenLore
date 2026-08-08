/**
 * The ONE way to name a path this server is about to WRITE.
 *
 * Every perimeter hole found so far had the same shape, and it was never the shape
 * anyone was looking for: the DIRECTORY was checked at the door, and then the path
 * actually written was built by a lexical `join` deeper in. `join` does not follow
 * symlinks, so `<root>/.openlore → /elsewhere` moved the bytes outside a perimeter
 * that had already said yes. That is not a hypothetical: `scratch/.openlore →
 * ws/.openlore` is the ordinary PDLC isolated layout, so under `--root scratch`
 * every `.openlore` write lands in a directory nobody granted.
 *
 * Gating the write CALLS one at a time does not close this. A census of `src/`
 * found 238 write primitives, 130 of them under a caller-supplied directory — a
 * list that cannot be kept correct by memory, and was not: three rounds of review
 * each found doors the previous round had not thought of.
 *
 * What IS tractable is that those 130 writes are reached through roughly a dozen
 * places where the target DIRECTORY is derived (`decisionsDir(root)`,
 * `certDir(root)`, the panic state file, the watcher's output dir…). Gate the
 * derivation and every write beneath it is covered at once, in the only place that
 * knows what is being written and why.
 *
 * The rule this module enforces:
 *
 *   • the FULL path is canonicalized, following symlinks in every component, so
 *     the decision is made about the location the bytes will actually reach;
 *   • the mode checked is WRITE, against the write roots, not read;
 *   • what comes back is the CANONICAL path, and callers must write to THAT —
 *     writing to the lexical path afterwards would re-traverse the links and
 *     re-open the hole the check just closed.
 *
 * A direct `join(dir, '.openlore', …)` on a write path is, after this, a defect by
 * construction — and `write-target.test.ts` enumerates the sources to make sure a
 * new one cannot be added quietly.
 */

import { join } from 'node:path';
import { OPENLORE_DIR } from '../../constants.js';
import { assertPathAllowed, isPathAllowed } from './mcp-handlers/root-allowlist.js';

/**
 * Canonical, perimeter-approved path for a write under `absDir`. Throws the
 * ordinary perimeter refusal when this server may not write there.
 */
export function writeTarget(absDir: string, ...segments: string[]): string {
  const target = join(absDir, ...segments);
  try {
    return assertPathAllowed(target, 'write');
  } catch (err) {
    // The round that moved the perimeter INWARD did not move the audit with it: the
    // door refusal printed to stderr, this one printed nowhere. An escape attempt
    // that gets further into the code should be more visible, not less.
    process.stderr.write(
      `openlore MCP: отказ периметра на записи — "${target}" (каталог "${absDir}")\n`
    );
    throw err;
  }
}

/**
 * Non-throwing {@link writeTarget}, for writers that must DEGRADE rather than
 * fail the caller's tool call (telemetry, panic state, background caches).
 *
 * Returning null obliges the caller to SAY it degraded — silently skipping a write
 * is indistinguishable from having had nothing to write, which is how a withheld
 * capability turns into a phantom bug hunt.
 */
export function tryWriteTarget(absDir: string, ...segments: string[]): string | null {
  const p = join(absDir, ...segments);
  return isPathAllowed(p, 'write') ? assertPathAllowed(p, 'write') : null;
}

/** {@link writeTarget} rooted at the project's `.openlore/` tree. */
export function openloreWriteTarget(absDir: string, ...segments: string[]): string {
  return writeTarget(absDir, OPENLORE_DIR, ...segments);
}

/** {@link tryWriteTarget} rooted at the project's `.openlore/` tree. */
export function tryOpenloreWriteTarget(absDir: string, ...segments: string[]): string | null {
  return tryWriteTarget(absDir, OPENLORE_DIR, ...segments);
}
