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
import {
  assertPathAllowed,
  canonicalPath,
  isPathAllowed,
  isRootAllowlistConfigured,
} from './mcp-handlers/root-allowlist.js';

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
 * first.
 *
 * That is ALL it removes. One approval does not survive a long run, and callers that
 * write repeatedly over one must re-derive — see {@link reassertWriteDir} for the
 * cheap re-derivation and for the honest statement of what is left after it.
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
 * Re-derive an ALREADY-APPROVED directory, for a caller that will keep writing into
 * it long after the approval was granted.
 *
 * WHY THIS EXISTS, precisely. `ensureWriteDir` is one decision at one instant. The
 * analyzer then writes for minutes: `rm -rf <root>/.openlore && ln -s /outside
 * <root>/.openlore` three seconds into the run sent 12 artifacts / 8.9 MB out of the
 * root and the call still reported success. The approval had not been re-examined
 * once. Two rounds of comments in this file and in `root-allowlist.ts` asserted that
 * the analyzer re-derived; it did not, and the assertion is what kept anyone from
 * looking. Call this before each write step, so an approval is worth one step and
 * not one run.
 *
 * Three distinct escapes are refused here, which is why all three checks are made:
 *   • the swapped link leads OUT of the write roots → `assertPathAllowed` refuses;
 *   • it leads back INSIDE them → the canonical path differs from the approved one;
 *   • the leaf itself became a link to a sibling inside the same root → the
 *     symlink-component scan refuses.
 *
 * WHAT REMAINS, stated so nobody has to discover it a fourth time: a swap performed
 * BETWEEN this check and the very next write still redirects that write. The window
 * is one write step, not one run — narrowed, not abolished. Node has no `openat`,
 * and nothing in this module can change that.
 *
 * A process with no perimeter (every CLI/library entry point — see the boundary note
 * in `root-allowlist.ts`) is returned unchanged: `openlore analyze` on a layout whose
 * `.openlore` is deliberately a symlink is a supported, ordinary use.
 */
export function reassertWriteDir(approvedDir: string): string {
  if (!isRootAllowlistConfigured()) return approvedDir;
  const again = assertPathAllowed(approvedDir, 'write');
  assertNoSymlinkComponents(again);
  if (again !== approvedDir) {
    throw new Error(
      `Root allowlist: "${approvedDir}" now resolves to "${again}"; the approved location changed ` +
      'under an in-flight write. Refusing to continue writing there.',
    );
  }
  return again;
}

/** {@link reassertWriteDir} for a path under an approved directory. */
export function writeUnderApprovedDir(approvedDir: string, ...segments: string[]): string {
  return join(reassertWriteDir(approvedDir), ...segments);
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
  // The WHOLE chain is created, leaf included — `ensureWriteDir` is the "make me this
  // DIRECTORY" caller, and its leaf is a directory. (The previous comment here said
  // "only the PARENT chain is created … the leaf is left to its writer", which the
  // loop below plainly does not do: it walks from `target` itself. The true statement
  // is the one about the other function: `writeTarget` also names FILES, cannot tell
  // them apart, and so materializes nothing — creating the leaf there turned
  // `federation.json` into a directory and broke every registry write with EISDIR.)
  // What matters for the race is that every component is a real directory that
  // existed, or was created here, rather than a name resolved later by `mkdir -p`.
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
 * Resolves and judges ONLY — it creates nothing. An earlier version of this comment
 * said the opposite ("MATERIALIZES the directory chain before resolving it, and that
 * is the point"), which described {@link ensureWriteDir}; naming FILES is the whole
 * reason the two are separate (materializing here turned `federation.json` into a
 * directory). A caller that needs the chain to exist out of real directories asks
 * for it by name.
 *
 * Consequence worth stating: for a path whose components do not exist yet,
 * `canonicalPath` can only canonicalize the existing prefix and keep the lexical
 * tail, so approval covers names a later `mkdir -p` will resolve afresh.
 * {@link ensureWriteDir} is what removes that; and neither abolishes the race —
 * see {@link reassertWriteDir}.
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
