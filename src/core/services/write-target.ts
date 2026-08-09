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

import { lstatSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { OPENLORE_DIR } from '../../constants.js';
import { assertPathAllowed, canonicalPath, isPathAllowed } from './mcp-handlers/root-allowlist.js';

/**
 * Create `dir` and its missing ancestors WITHOUT following a symlink at any step,
 * so the approved path is built out of real directories rather than out of names
 * something else may redefine later.
 *
 * THE RESIDUAL RACE, stated plainly because the previous version of this file
 * claimed the opposite and the claim was false:
 *
 * Node has no `openat`, so every write re-walks the path by name. An attacker who
 * can swap a component BETWEEN this resolution and the syscall still redirects that
 * syscall — demonstrated: replacing `.openlore` with a symlink five seconds into an
 * `analyze_codebase` run put 5.7 MB of artifacts outside the root. What this
 * function removes is the much wider window where the component did not exist at
 * approval time at all, and it makes the swap require deleting a real directory
 * first. Callers that write repeatedly over a long period (the analyzer, the
 * watcher) RE-DERIVE their target rather than trusting one approval for the whole
 * run — that is where the remaining exposure is actually bounded.
 */
/**
 * Approve a DIRECTORY for writing and create it, chain and all, out of real
 * directories — the stronger form, for callers that will write into it repeatedly
 * over a long run (the analyzer, the watcher).
 *
 * Kept separate from {@link writeTarget} because creating is a side effect and
 * `writeTarget` also names FILES: materializing there turned `federation.json` into
 * a directory (EISDIR on every registry write) and tried to mkdir under virtual
 * roots that exist only in tests. Deriving a path must stay free of consequences;
 * only a caller that means "make me this directory" says so.
 */
export function ensureWriteDir(absDir: string, ...segments: string[]): string {
  const approved = writeTarget(absDir, ...segments);
  materializeUnderApprovedRoot(approved);
  return approved;
}

/**
 * Refuse if any EXISTING component of `target` is a symlink. Cheap, no side effects,
 * and it is what makes an approved path mean "resolved through real directories"
 * rather than "these names looked fine once".
 */
function assertNoSymlinkComponents(target: string): void {
  for (let cur = target; ; cur = dirname(cur)) {
    try {
      if (lstatSync(cur).isSymbolicLink()) {
        throw new Error(`Root allowlist: "${cur}" is a symbolic link; refusing to write through it.`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Root allowlist:')) throw err;
      /* component does not exist yet — nothing to impersonate */
    }
    if (dirname(cur) === cur) return;
  }
}

function materializeUnderApprovedRoot(target: string): void {
  // Only the PARENT chain is created. `writeTarget` names both directories (the
  // analysis dir) and FILES (`federation.json`), and it cannot tell them apart —
  // materializing the leaf turned `federation.json` into a directory and broke every
  // registry write with EISDIR. The leaf is left to its writer; what matters for the
  // race is that everything ABOVE it is a real directory, verified here.
  const parts: string[] = [];
  for (let cur = target; ; cur = dirname(cur)) {
    let st;
    try { st = lstatSync(cur); } catch { parts.unshift(cur); if (dirname(cur) === cur) break; continue; }
    if (st.isSymbolicLink()) {
      // Approval was computed over the RESOLVED path; a symlink surviving here means
      // the tree changed under us between resolution and now.
      throw new Error(
        `Root allowlist: "${cur}" became a symbolic link after it was approved; refusing to write through it.`,
      );
    }
    break;                                     // deepest existing, non-link ancestor
  }
  for (const p of parts) {
    try { mkdirSync(p); } catch { /* raced or exists — the lstat below decides */ }
    const st = lstatSync(p);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error(`Root allowlist: "${p}" is not a real directory; refusing to write through it.`);
    }
  }
  // Final agreement check: the parent chain we just built must still canonicalize to
  // itself, and the leaf — if it already exists — must not be a symlink.
  if (canonicalPath(target) !== target) {
    throw new Error(`Root allowlist: "${target}" no longer resolves to itself; refusing to write through it.`);
  }
}

/**
 * Canonical, perimeter-approved path for a write under `absDir`.
 *
 * MATERIALIZES the directory chain before resolving it, and that is the point, not
 * a convenience. A path whose components do not exist yet cannot be canonicalized —
 * `canonicalPath` returns the lexical tail — so the approval is granted over names
 * that a later `mkdir -p` will resolve afresh. Creating the chain ourselves, one
 * component at a time and refusing any component that is a symlink, means the
 * approved path is made of directories that really existed at approval time.
 *
 * READ THE HONEST LIMIT in `assertNoSymlinkChain` below: this narrows the race, it
 * does not abolish it.
 */
export function writeTarget(absDir: string, ...segments: string[]): string {
  const target = join(absDir, ...segments);
  try {
    const approved = assertPathAllowed(target, 'write');
    assertNoSymlinkComponents(approved);
    return approved;
  } catch (err) {
    // The round that moved the perimeter INWARD did not move the audit with it: the
    // door refusal printed to stderr, this one printed nowhere. An escape attempt
    // that gets further into the code should be more visible, not less.
    // The RESOLVED location, not the lexical one: `<root>/.openlore/x` says nothing
    // when `.openlore` is the link that carries the write out — the operator needs to
    // see where it would actually have landed.
    let resolved = target;
    try { resolved = canonicalPath(target); } catch { /* unresolvable — show the lexical form */ }
    process.stderr.write(
      `openlore MCP: отказ периметра на записи — "${target}" → "${resolved}" (каталог "${absDir}")\n`
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
  if (isPathAllowed(p, 'write')) return assertPathAllowed(p, 'write');
  // Say it. The rule at the top of this file obliges a withheld write to be audible,
  // and this path — telemetry, panic state — was the one place still returning null
  // in silence. Once per target, so a hot loop cannot turn the log into noise.
  if (!_degradedOnce.has(p)) {
    _degradedOnce.add(p);
    process.stderr.write(`openlore MCP: запись пропущена (вне корней записи) — "${p}"\n`);
  }
  return null;
}

/** Targets already reported as skipped, so a hot path logs once, not per call. */
const _degradedOnce = new Set<string>();

/** {@link writeTarget} rooted at the project's `.openlore/` tree. */
export function openloreWriteTarget(absDir: string, ...segments: string[]): string {
  return writeTarget(absDir, OPENLORE_DIR, ...segments);
}

/**
 * Canonical, perimeter-approved path for a READ under `absDir`.
 *
 * Reads need this too: a `.openlore` that is a symlink out of the served root makes
 * `join(root, '.openlore', …)` read someone else's repository, and the door check on
 * `directory` says nothing about it. Same rule, mode `'read'`.
 */
export function readTarget(absDir: string, ...segments: string[]): string {
  return assertPathAllowed(join(absDir, ...segments), 'read');
}

/** {@link readTarget} rooted at the project's `.openlore/` tree. */
export function openloreReadTarget(absDir: string, ...segments: string[]): string {
  return readTarget(absDir, OPENLORE_DIR, ...segments);
}

/** {@link tryWriteTarget} rooted at the project's `.openlore/` tree. */
export function tryOpenloreWriteTarget(absDir: string, ...segments: string[]): string | null {
  return tryWriteTarget(absDir, OPENLORE_DIR, ...segments);
}
