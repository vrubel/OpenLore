/**
 * Root allowlist — the MCP server's filesystem perimeter.
 *
 * An openlore MCP server is always started FOR something: one repository, or a
 * declared set of them. Nothing in the protocol said so, though — every one of
 * the 62 tools takes a `directory` argument, and the only check it ever met was
 * "does this resolve to an existing directory". A server raised for repo A
 * therefore answered, in full, about repo B, about `/etc`, about any absolute
 * path the agent cared to name. The perimeter was held by the agent not knowing
 * the neighbours' paths — and openlore itself hands those out (federation
 * registry), so it was not held at all.
 *
 * This module is the boundary. Roots are declared once at server start
 * (`--root` / `--write-root`, defaulting to the process working directory) and
 * every path is measured against them BEFORE anything touches the disk.
 *
 * Four properties are deliberate:
 *
 *   • CLOSED BY DEFAULT, AND READING NEVER IMPLIES WRITING. No flags ⇒ the single
 *     read root is `process.cwd()`, and the write set is `[cwd]` only when cwd is
 *     inside a read root (otherwise empty: a read-only server). Granting a
 *     neighbour with `--root` never makes it writable — that takes `--write-root`.
 *
 *   • IT GUARDS WHERE THE DISK IS TOUCHED, NOT ONLY WHERE THE REQUEST ARRIVES.
 *     Guarding the transport and `validateDirectory` was not enough, and each gap
 *     was a live hole: a path can arrive from `.openlore/config.json` (a file the
 *     agent writes) rather than from an argument; a WRITE can happen in the middle
 *     of a READ (opening the call-graph index rewrote it, and destroyed it on a
 *     schema bump); a background writer can fire on a tool nobody classified as a
 *     writer (panic state). Hence {@link assertPathAllowed}: judge the exact path,
 *     in the exact mode, at the moment of use.
 *
 *   • CONFINEMENT IS DECIDED — AND RETURNED — ON THE REAL PATH. A candidate is
 *     inside a root when its `realpath` is the root's `realpath` or lies under it;
 *     a symlink inside an allowed root pointing out of it is an escape a lexical
 *     `resolve()` would wave through. The CANONICAL path is what comes back, so
 *     callers operate on what was approved: handing back the lexical path let every
 *     later syscall re-traverse the links, and a swap after the check (an
 *     `analyze_codebase` run is minutes long) landed outside the root.
 *
 *   • UNCONFIGURED MEANS NO PERIMETER, ON PURPOSE. The allowlist is a property of
 *     the MCP SERVER, not of the handler library. CLI commands import the same
 *     handlers and legitimately act on paths outside the working directory —
 *     `openlore federation add /elsewhere/repo` is exactly that, and PDLC calls it
 *     when it registers a product's repository set. A CLI process never configures
 *     the allowlist, so it is never confined by it. Only `openlore mcp` configures.
 */

import { readlinkSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

export type RootAccessMode = 'read' | 'write';

export interface RootAllowlist {
  /** Canonical (realpath'd) roots this server may read. */
  readRoots: string[];
  /** Canonical (realpath'd) roots this server may write. Always ⊆ readRoots. */
  writeRoots: string[];
}

let _state: RootAllowlist | null = null;

/**
 * Tools that can write to the target directory, named EXPLICITLY rather than
 * derived from the MCP annotation table.
 *
 * The annotations are a hint published to clients, and they have already been
 * wrong: `change_impact_certificate` shipped as read-only while carrying a
 * `persist` parameter that writes a file, and the fork's own mutator gate listed
 * eight names while ten tools wrote. A perimeter that reads its rules from a
 * table that drifts is not a perimeter. This list is the rule; a test asserts the
 * annotation table agrees with it in BOTH directions, so the next divergence
 * fails CI instead of quietly opening a hole.
 *
 * `generate_tests` (default `dryRun: true`) and `change_impact_certificate`
 * (writes only with `persist: true`) are classified as writers UNCONDITIONALLY:
 * whether the call writes is decided by an argument the caller controls, and a
 * boundary must not depend on the caller's honesty about its own intent.
 */
export const WRITING_TOOLS: ReadonlySet<string> = new Set([
  'analyze_codebase',
  'annotate_story',
  'approve_decision',
  'change_impact_certificate',
  'generate_change_proposal',
  'generate_tests',
  'record_decision',
  'reject_decision',
  'remember',
  'sync_decisions',
]);

/** The access a tool needs on its `directory` argument. */
export function toolAccessMode(tool: string): RootAccessMode {
  return WRITING_TOOLS.has(tool) ? 'write' : 'read';
}

/** Raised when a path cannot be canonicalized. Always a REFUSAL, never a pass. */
class UncanonicalizablePath extends Error {}

/**
 * The canonical location `p` names — resolving symlinks even when the target does
 * not exist.
 *
 * Two rules here are load-bearing, and both were learned from a hole:
 *
 *   • FAIL CLOSED. Any `realpath` error other than ENOENT (Windows hands out
 *     EPERM/EACCES/EBUSY/EINVAL for junctions and locked entries that later calls
 *     then handle perfectly well) used to fall back to the LEXICAL path, which was
 *     judged as if it were canonical — an escape hatch out of the root on exactly
 *     the platform where junctions are common. Now it throws, and the caller
 *     refuses.
 *
 *   • A DANGLING SYMLINK IS RESOLVED, NOT SHRUGGED OFF. The old version fell back
 *     to the nearest existing ANCESTOR, so `<root>/link → /outside/missing` was
 *     judged as `<root>` (inside, then "Directory not found"), while
 *     `<root>/link → /outside/present` was judged as `/outside/present` (perimeter
 *     refusal). Three distinguishable answers — refusal / not-found / not-a-
 *     directory — turned the perimeter into an existence-and-type oracle for any
 *     absolute path, reachable with one symlink inside your own root. Following
 *     the link explicitly makes all three collapse into the same refusal.
 *
 * A genuinely absent path with no symlink in it (`<root>/ghost`) still resolves to
 * its canonical parent plus the missing tail — inside the root, refused later by
 * `stat` for the honest reason. That case leaks nothing: it is already inside.
 */
function canonical(p: string, depth = 0): string {
  if (depth > 40) throw new UncanonicalizablePath(`too many symlink hops resolving "${p}"`);
  const cur = resolve(p);
  try {
    return realpathSync(cur);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw new UncanonicalizablePath(`cannot canonicalize "${cur}" (${code ?? 'unknown error'})`);
    }
  }
  // ENOENT. Either `cur` is a dangling symlink (follow it — see above), or some
  // component of it simply does not exist (canonicalize the parent, keep the tail).
  let target: string | null = null;
  try {
    target = readlinkSync(cur);
  } catch {
    target = null;                                   // not a symlink (or unreadable)
  }
  if (target !== null) {
    return canonical(isAbsolute(target) ? target : resolve(dirname(cur), target), depth + 1);
  }
  const parent = dirname(cur);
  if (parent === cur) return cur;                    // filesystem root
  return join(canonical(parent, depth + 1), basename(cur));
}

/** True when `candidate` (already canonical) is `root` or lies inside it. */
function isWithin(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  if (rel === '') return true;
  if (isAbsolute(rel)) return false;               // different drive/volume
  return rel.split(/[\\/]/)[0] !== '..';           // not an escape upwards
}

function withinAny(candidate: string, roots: string[]): boolean {
  return roots.some(root => isWithin(candidate, root));
}

/**
 * Containment by the SAME rule the perimeter uses (canonical on both sides), but
 * usable BEFORE `configureRootAllowlist`: the caller has to decide the DEFAULT write
 * root ("is my cwd inside the roots I am about to declare?") at a moment when the
 * allowlist does not exist yet. Kept here so there is exactly one definition of
 * "inside a root" — a second, subtly different one over in the CLI is how perimeters rot.
 */
export function isPathWithinRoots(candidate: string, roots: string[]): boolean {
  try {
    return withinAny(canonical(candidate), roots.map(r => canonical(r)));
  } catch {
    return false;                                    // fail closed, like the perimeter itself
  }
}

/**
 * Declare the perimeter. Called ONCE, at MCP server start, before any request is
 * served. Fails loudly rather than degrading: a root that does not exist, or a
 * write root outside every read root, is an operator mistake that must surface at
 * launch — not on the first tool call, half an hour into a run.
 */
export function configureRootAllowlist(config: { readRoots: string[]; writeRoots: string[] }): void {
  const readRoots = canonicalizeRoots(config.readRoots, '--root');
  if (readRoots.length === 0) {
    throw new Error('openlore mcp: список корней чтения пуст — сервер без единого корня не может обслужить ни один вызов.');
  }
  const writeRoots = canonicalizeRoots(config.writeRoots, '--write-root');
  for (const w of writeRoots) {
    if (!withinAny(w, readRoots)) {
      throw new Error(
        `openlore mcp --write-root ${w}: корень записи обязан быть подмножеством корней чтения, ` +
        `а он не лежит ни в одном из них (${readRoots.join(', ')}). ` +
        'Добавьте его в --root или уберите из --write-root.'
      );
    }
  }
  _state = { readRoots, writeRoots };
}

function canonicalizeRoots(roots: string[], flag: string): string[] {
  const out: string[] = [];
  for (const raw of roots) {
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new Error(`openlore mcp ${flag}: пустое значение — укажите путь к каталогу.`);
    }
    const abs = resolve(raw.trim());
    let st;
    try {
      st = statSync(abs);
    } catch {
      throw new Error(`openlore mcp ${flag} ${abs}: каталог не существует. Лучше упасть на старте, чем на первом вызове агента.`);
    }
    if (!st.isDirectory()) {
      throw new Error(`openlore mcp ${flag} ${abs}: это не каталог.`);
    }
    const real = realpathSync(abs);
    if (!out.includes(real)) out.push(real);
  }
  return out;
}

/** The configured perimeter, or null when this process never declared one. */
export function getRootAllowlist(): RootAllowlist | null {
  return _state;
}

/** True when a perimeter has been declared in this process (i.e. we are an MCP server). */
export function isRootAllowlistConfigured(): boolean {
  return _state !== null;
}

/** Test-only: drop the perimeter so the next test can declare its own. */
export function _resetRootAllowlistForTesting(): void {
  _state = null;
}

/**
 * The refusal an agent reads. It has to do three things at once: make clear this
 * is a BOUNDARY and not a malfunction (so the agent stops retrying), say what IS
 * reachable (so it can carry on doing useful work instead of probing), and reveal
 * nothing about the path it asked for — in particular not whether it exists.
 */
function denialMessage(requested: string, mode: RootAccessMode, state: RootAllowlist, readable: boolean): string {
  const verb = mode === 'write' ? 'write to' : 'read';
  const scoped = mode === 'write' && readable;
  return [
    `Root allowlist: this openlore MCP server may not ${verb} "${requested}".`,
    scoped
      ? 'That location is readable but not writable by this server.'
      : 'That location is outside every root this server was started for.',
    'This is a deliberate boundary, not a transient failure. The server serves a fixed set of ' +
      'repositories for the duration of this run; no retry, and no variation of the path, will widen it.',
    `Readable roots: ${state.readRoots.join(', ') || '(none)'}`,
    `Writable roots: ${state.writeRoots.join(', ') || '(none)'}`,
    `Use a "directory" inside ${mode === 'write' ? 'a writable' : 'a readable'} root. If you genuinely need ` +
      'another repository, that is an operator decision — the server must be restarted with it declared.',
  ].join('\n');
}

/**
 * Gate ANY filesystem path the server is about to touch, in the mode it is about
 * to touch it in. Returns the CANONICAL absolute path, or throws a refusal.
 *
 * Use this — not `assertRootAllowed` — for a path that did not arrive as the
 * caller's `directory`: one read out of `.openlore/config.json`, one built by
 * joining inside a handler, one a background writer is about to create. "Where the
 * request comes in" and "where the disk is touched" are different places, and the
 * perimeter has to stand at the second one. A config value is still caller input:
 * the config lives inside a root the agent can write.
 *
 * Returning the CANONICAL path is deliberate and is the fix for a TOCTOU window:
 * checking the canonical path and then handing back the lexical one lets every
 * subsequent syscall re-traverse the symlinks, so a link swapped inside your own
 * root after the check (an `analyze_codebase` run is minutes long) lands outside.
 * Callers must operate on what was actually approved.
 */
export function assertPathAllowed(fsPath: string, mode: RootAccessMode = 'read'): string {
  if (!fsPath || typeof fsPath !== 'string') {
    throw new Error('path is required and must be a string');
  }
  const state = _state;
  if (!state) return resolve(fsPath);           // not an MCP server — no perimeter (see file header)
  let cand: string;
  try {
    cand = canonical(fsPath);
  } catch (err) {
    // Fail CLOSED — and fail IDENTICALLY. The first version said "cannot verify
    // where X leads (ENOTDIR)", which handed the agent a filesystem probe far
    // better than the symlink trick it replaced: `/etc/passwd/x` answered
    // ENOTDIR (a file is there), `/root/x` answered EACCES (a directory is there,
    // closed), `/etc/no-such/x` answered with the ordinary refusal. Three
    // distinguishable replies, no write access needed, the whole machine
    // enumerable. The errno is an OPERATOR fact: it goes to stderr, and the agent
    // gets the same sentence it would get for any other path outside the roots.
    process.stderr.write(
      `openlore MCP: не удалось канонизировать "${resolve(fsPath)}" ` +
      `(${err instanceof Error ? err.message : String(err)}) — отказ по периметру (fail closed)\n`
    );
    throw new Error(denialMessage(resolve(fsPath), 'read', state, false));
  }
  const readable = withinAny(cand, state.readRoots);
  if (!readable) throw new Error(denialMessage(resolve(fsPath), 'read', state, false));
  if (mode === 'write' && !withinAny(cand, state.writeRoots)) {
    throw new Error(denialMessage(resolve(fsPath), 'write', state, true));
  }
  return cand;
}

/**
 * Gate a caller-supplied `directory` argument. Thin wrapper over
 * {@link assertPathAllowed} that exists for the call sites where the thing being
 * judged really is the project root, so the intent reads at the call site.
 *
 * Order matters wherever this is used: it runs BEFORE `stat`, before telemetry,
 * before daemon resolution, before spawning git. Anything that touches the path
 * first turns the refusal into an oracle.
 */
export function assertRootAllowed(directory: string, mode: RootAccessMode = 'read'): string {
  if (!directory || typeof directory !== 'string') {
    throw new Error('directory parameter is required and must be a string');
  }
  return assertPathAllowed(directory, mode);
}

/**
 * Non-throwing form, for the places that must WITHHOLD rather than refuse:
 * enumerating responses (the federation registry) must not hand out the addresses
 * of repositories the caller would be refused on — otherwise the refusal above
 * merely turns a listing into a probing exercise.
 */
export function isRootAllowed(directory: string, mode: RootAccessMode = 'read'): boolean {
  return isPathAllowed(directory, mode);
}

/**
 * Non-throwing {@link assertPathAllowed}, for the writers that must DEGRADE rather
 * than throw: telemetry ("never crash the hot path"), the read-only cache open, the
 * panic-state writer. Every one of them must still SAY that it degraded — a silent
 * skip is indistinguishable from "there was nothing to write".
 */
export function isPathAllowed(fsPath: string, mode: RootAccessMode = 'read'): boolean {
  try {
    assertPathAllowed(fsPath, mode);
    return true;
  } catch {
    return false;
  }
}
