/**
 * THE APPROVAL IS NOT THE WRITE — exploitation tests for the window between them.
 *
 * Everything in this file reproduces something that WORKED against the previous
 * revision, on purpose. A test that exercises a helper proves the helper; only a test
 * that performs the attack proves the hole is shut. Each `it` therefore names the
 * escape it replays, and each one is checked by mutation: undo the fix and it fails.
 *
 * 1. THE ANALYZER'S ONE APPROVAL. `analyze_codebase` resolved its output directory
 *    once and then wrote for minutes. Deleting `<root>/.openlore` and putting a
 *    symlink there while the run was still scanning sent 12 artifacts — 8.9 MB — into
 *    a directory outside every declared root, and the tool returned success.
 *
 * 2. READING THROUGH A SYMLINKED `.openlore`. Three artifact readers built their path
 *    with a lexical `join`, so `<root>/.openlore -> /elsewhere` made them answer with
 *    a neighbouring repository's dependency graph, mapping index and call graph. The
 *    door check on `directory` had already passed: the served root was genuine, only
 *    what lived inside it was not.
 *
 * 3. THE TWO LAYERS UNDER `ensureWriteDir`. `assertNoSymlinkComponents` and
 *    `materializeUnderApprovedRoot` were both removable one at a time without a single
 *    test turning red — the suite only noticed when BOTH went. Both exist for the same
 *    race, so both are exercised here through that race, at the two different instants
 *    where each is the only thing looking.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * A swap performed by the filesystem itself, at a named instant inside the code under
 * test. `lstatSync` is the seam because it is what BOTH layers of `ensureWriteDir`
 * walk the path with, so counting its calls addresses each layer separately instead of
 * racing a timer and hoping.
 */
const swap: { on: number | null; count: number; run: (() => void) | null; path: string | null } = {
  on: null, count: 0, run: null, path: null,
};

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const patched = (p: unknown, ...rest: unknown[]): unknown => {
    if (swap.on !== null && (swap.path === null || String(p) === swap.path)) {
      swap.count += 1;
      if (swap.count === swap.on) {
        swap.on = null;
        swap.run?.();
      }
    }
    return (actual.lstatSync as unknown as (...a: unknown[]) => unknown)(p, ...rest);
  };
  return { ...actual, lstatSync: patched };
});

const {
  mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync, symlinkSync, readdirSync, existsSync,
} = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { configureRootAllowlist, _resetRootAllowlistForTesting, PERIMETER_REFUSAL_MARKER } =
  await import('./mcp-handlers/root-allowlist.js');
const { ensureWriteDir, openloreWriteTarget } = await import('./write-target.js');

let parent: string;
let root: string;
let neighbour: string;
let outside: string;

/** Delete the real `.openlore` and point its name somewhere else, as the exploit does. */
function hijackOpenloreDir(at: string): void {
  rmSync(join(root, '.openlore'), { recursive: true, force: true });
  symlinkSync(at, join(root, '.openlore'), 'dir');
}

/** Every file under `dir`, recursively — "did anything at all land here". */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) out.push(e.name);
  }
  return out;
}

beforeEach(() => {
  parent = realpathSync(mkdtempSync(join(tmpdir(), 'ol-toctou-')));
  root = join(parent, 'repo');
  neighbour = join(parent, 'neighbour');
  mkdirSync(root); mkdirSync(neighbour);
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'ol-toctou-out-')));
  swap.on = null; swap.count = 0; swap.run = null; swap.path = null;
});

afterEach(() => {
  swap.on = null; swap.count = 0; swap.run = null; swap.path = null;
  _resetRootAllowlistForTesting();
  rmSync(parent, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

// ============================================================================
// 1. THE ANALYZER: ONE APPROVAL, A WHOLE PHASE OF WRITES
// ============================================================================

describe('analyze_codebase: the output directory is re-derived, not approved once', () => {
  /** A repository small enough to analyse in a test, real enough to produce artifacts. */
  function plantRepo(): void {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'victim', version: '1.0.0' }));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'a.ts'), 'export function alpha(): number { return beta() + 1; }\nfunction beta(): number { return 1; }\n');
    writeFileSync(join(root, 'src', 'b.ts'), "import { alpha } from './a.js';\nexport const twice = (): number => alpha() * 2;\n");
  }

  it('refuses every artifact when the approved directory is swapped for one it may read but not write', async () => {
    // THIS is the case that measures the analyzer's own guard, and the comment says so
    // because the obvious version of this test does not.
    //
    // Send `.openlore` somewhere the server may READ (a sibling inside the read root)
    // but may not WRITE. The run then proceeds exactly as a normal run does — the
    // config read at the top of runAnalysis succeeds, the scan succeeds — and the very
    // first write is the moment the perimeter is consulted again. Remove the
    // re-derivation and the artifacts land in the neighbour: proven by mutation.
    plantRepo();
    configureRootAllowlist({ readRoots: [parent], writeRoots: [root] });

    const approved = ensureWriteDir(root, '.openlore', 'analysis');
    expect(approved).toBe(join(root, '.openlore', 'analysis'));

    // …and then the tree changes under the approval, which is all the exploit ever did.
    // Placed here rather than on a timer: the demonstrated attack swapped the directory
    // three seconds in, while the analyzer was still scanning and before it had written
    // anything, and that is the same instant — without depending on how fast the machine
    // running the test happens to be.
    hijackOpenloreDir(neighbour);

    const { runAnalysis } = await import('../../cli/commands/analyze.js');
    await expect(
      runAnalysis(root, approved, { maxFiles: 50, include: [], exclude: [] }),
    ).rejects.toThrow(PERIMETER_REFUSAL_MARKER);

    expect(
      filesUnder(neighbour),
      'the analyzer wrote through the swapped symlink — this is the original escape, unchanged',
    ).toEqual([]);
    // Not even the DIRECTORY: `mkdir` is the analyzer's first syscall on that path, so
    // this is what separates "the analyzer refused" from "something further downstream
    // happened to refuse afterwards".
    expect(
      existsSync(join(neighbour, 'analysis')),
      'the analyzer created its output directory through the swapped symlink before anything refused',
    ).toBe(false);
  }, 120_000);

  it('refuses when the approved directory is swapped for one outside every root', async () => {
    // The literal PoC layout. Stated honestly: here the run stops at the FIRST
    // perimeter-crossing read — `.openlore/config.json`, one line into runAnalysis —
    // and never reaches the writes at all. That is a refusal, and the artifacts stay
    // out of `outside`, but it is the config gate doing the work, not the analyzer's
    // re-derivation. The test above is the one that proves the write path.
    plantRepo();
    configureRootAllowlist({ readRoots: [root], writeRoots: [root] });
    const approved = ensureWriteDir(root, '.openlore', 'analysis');
    hijackOpenloreDir(outside);

    const { runAnalysis } = await import('../../cli/commands/analyze.js');
    await expect(
      runAnalysis(root, approved, { maxFiles: 50, include: [], exclude: [] }),
    ).rejects.toThrow(PERIMETER_REFUSAL_MARKER);
    expect(filesUnder(outside)).toEqual([]);
  }, 120_000);

  it('writes normally when nobody moves anything (the guard is not a blanket refusal)', async () => {
    plantRepo();
    configureRootAllowlist({ readRoots: [parent], writeRoots: [root] });
    const approved = ensureWriteDir(root, '.openlore', 'analysis');

    const { runAnalysis } = await import('../../cli/commands/analyze.js');
    await runAnalysis(root, approved, { maxFiles: 50, include: [], exclude: [] });

    expect(filesUnder(approved).length).toBeGreaterThan(0);
    expect(filesUnder(neighbour)).toEqual([]);
    expect(filesUnder(outside)).toEqual([]);
  }, 120_000);
});

// ============================================================================
// 2. THE TWO LAYERS OF `ensureWriteDir`, LOCKED SEPARATELY
// ============================================================================

describe('ensureWriteDir: each layer is load-bearing on its own', () => {
  it('refuses a component that becomes a symlink between the perimeter check and the path walk', () => {
    // LOCKS `assertNoSymlinkComponents`. `writeTarget` does not materialize, so this
    // walk is the only thing standing between the perimeter's answer and the caller
    // using the path. The swap is planted on the first `lstatSync` of the run — i.e.
    // after `assertPathAllowed` has already said yes.
    mkdirSync(join(root, '.openlore'), { recursive: true });
    configureRootAllowlist({ readRoots: [root], writeRoots: [root] });

    swap.on = 1;
    swap.run = () => hijackOpenloreDir(outside);

    expect(() => openloreWriteTarget(root, 'analysis', 'llm-context.json'))
      .toThrow(PERIMETER_REFUSAL_MARKER);
  });

  it('refuses a component that becomes a symlink while the chain is being materialized', () => {
    // LOCKS `materializeUnderApprovedRoot`. The previous check has already walked the
    // path and found it clean (that is `lstatSync` call #1 on the target); the swap
    // lands on call #2, which is materialization's own walk. Replacing this function
    // with a plain recursive `mkdirSync` makes the directory appear under `outside`
    // and this expectation fail — which is the point: the two layers look at the same
    // path at two different instants, and neither covers the other's instant.
    mkdirSync(join(root, '.openlore'), { recursive: true });
    configureRootAllowlist({ readRoots: [root], writeRoots: [root] });

    const target = join(root, '.openlore', 'analysis');
    swap.path = target;
    swap.on = 2;
    swap.run = () => hijackOpenloreDir(outside);

    expect(() => ensureWriteDir(root, '.openlore', 'analysis')).toThrow(PERIMETER_REFUSAL_MARKER);
    expect(filesUnder(outside)).toEqual([]);
    expect(existsSync(join(outside, 'analysis')), 'materialization created the chain through the symlink').toBe(false);
  });
});
