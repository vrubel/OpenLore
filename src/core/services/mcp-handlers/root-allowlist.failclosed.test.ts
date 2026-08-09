/**
 * The refusal must be BYTE-IDENTICAL whatever the underlying cause, and the errno
 * must never reach the agent.
 *
 * The first attempt at "fail closed" said `cannot verify where "X" leads (ENOTDIR)`.
 * That handed the agent a better filesystem probe than the symlink trick it had
 * just replaced, and one that needs no write access anywhere:
 *
 *     /etc/passwd/x    → ENOTDIR   ⇒ "a file exists there"
 *     /root/x          → EACCES    ⇒ "a directory exists there, and it is closed"
 *     /etc/no-such/x   → plain refusal ⇒ "nothing there"
 *
 * Three distinguishable answers for any absolute path on the machine. The errno is
 * an OPERATOR fact and belongs on stderr; the agent gets one sentence.
 *
 * Its own file because EACCES/EPERM can only be produced here by making
 * `realpathSync` fail (CI runs as root, so chmod proves nothing), and ESM will not
 * let a named export be spied on in place — the module must be mocked before the
 * subject imports it. ENOTDIR needs no mock: a real file with a path below it does it.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

const state: { failOn: string | null; code: string } = { failOn: null, code: 'EPERM' };

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const patched = (p: unknown, ...rest: unknown[]): unknown => {
    if (state.failOn !== null && String(p) === state.failOn) {
      throw Object.assign(new Error(`${state.code}: simulated, realpath`), { code: state.code });
    }
    return (actual.realpathSync as unknown as (...a: unknown[]) => unknown)(p, ...rest);
  };
  (patched as unknown as { native: unknown }).native = actual.realpathSync.native;
  return { ...actual, realpathSync: patched };
});

const { mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const {
  configureRootAllowlist, assertRootAllowed, isRootAllowed, _resetRootAllowlistForTesting,
} = await import('./root-allowlist.js');

let root: string;
let outside: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ol-failclosed-')));
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'ol-failclosed-out-')));
  configureRootAllowlist({ readRoots: [root], writeRoots: [root] });
});
afterEach(() => {
  state.failOn = null;
  state.code = 'EPERM';
  _resetRootAllowlistForTesting();
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

/** The refusal text with the echoed input path removed — what must be constant. */
const refusalShape = (p: string): string => {
  try {
    assertRootAllowed(p);
    return 'NO REFUSAL';
  } catch (e) {
    return (e as Error).message.split(p).join('<PATH>');
  }
};

describe('root allowlist — fail closed, and fail identically', () => {
  it('refuses an uncanonicalizable path instead of judging its lexical form', () => {
    const probe = join(root, 'junction-like');
    mkdirSync(probe, { recursive: true });
    expect(assertRootAllowed(probe)).toBe(probe);          // sanity: plainly inside

    state.failOn = probe;
    expect(() => assertRootAllowed(probe)).toThrow(/Root allowlist/);
    expect(isRootAllowed(probe, 'read')).toBe(false);
    expect(isRootAllowed(probe, 'write')).toBe(false);
  });

  it('gives ONE answer for present / absent / not-a-directory / permission-denied', () => {
    // (a) exists and is a directory, outside the roots
    const present = outside;
    // (b) does not exist, outside the roots
    const absent = join(outside, 'never-existed');
    // (c) path THROUGH an existing file → real ENOTDIR from realpath
    const filePath = join(outside, 'secret.txt');
    writeFileSync(filePath, 'x', 'utf-8');
    const throughFile = join(filePath, 'x');
    // (d) permission denied — simulated, because CI runs as root
    const denied = join(outside, 'closed');
    mkdirSync(denied, { recursive: true });
    state.failOn = denied;
    state.code = 'EACCES';

    const shapes = [present, absent, throughFile, denied].map(refusalShape);
    for (const s of shapes) expect(s).not.toBe('NO REFUSAL');
    expect(new Set(shapes).size, `refusals differ by cause:\n${shapes.join('\n---\n')}`).toBe(1);
  });

  it('never leaks an errno to the agent', () => {
    const filePath = join(outside, 'f.txt');
    writeFileSync(filePath, 'x', 'utf-8');
    const denied = join(outside, 'closed2');
    mkdirSync(denied, { recursive: true });
    state.failOn = denied;
    state.code = 'EACCES';

    for (const p of [join(filePath, 'x'), denied]) {
      let msg = '';
      try { assertRootAllowed(p); } catch (e) { msg = (e as Error).message; }
      expect(msg).not.toMatch(/ENOTDIR|EACCES|EPERM|EBUSY|EINVAL|ENOENT|errno/i);
      expect(msg).not.toMatch(/cannot verify|realpath/i);
      expect(msg).toMatch(/Root allowlist/);
    }
  });
});
