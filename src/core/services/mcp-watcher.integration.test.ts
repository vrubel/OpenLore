/**
 * Integration tests for McpWatcher — real chokidar watcher + real filesystem.
 *
 * These tests start an actual FSWatcher, write files to a tmpdir, and verify
 * that llm-context.json is updated after the debounce fires.
 *
 * No embedding server required.  No mocks.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMContext } from '../analyzer/artifact-generator.js';
import { McpWatcher } from './mcp-watcher.js';
import * as utils from './mcp-handlers/utils.js';
import { readCachedContext, _resetContextCacheForTesting } from './mcp-handlers/utils.js';
import { configureRootAllowlist, _resetRootAllowlistForTesting } from './mcp-handlers/root-allowlist.js';

// ── Timing ────────────────────────────────────────────────────────────────────
//   stabilityThreshold 100ms  +  debounce 100ms  +  processing slack 200ms
const WAIT_MS = 500;
const DEBOUNCE_MS = 100;

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeContext(): LLMContext {
  return {
    phase1_survey:     { purpose: '', files: [], totalTokens: 0 },
    phase2_deep:       { purpose: '', files: [], totalTokens: 0 },
    phase3_validation: { purpose: '', files: [], totalTokens: 0 },
    signatures: [],
    callGraph: {
      nodes: [], edges: [], classes: [], inheritanceEdges: [],
      hubFunctions: [], entryPoints: [], layerViolations: [],
      stats: { totalNodes: 0, totalEdges: 0, avgFanIn: 0, avgFanOut: 0 },
    },
  };
}

async function setupProject(): Promise<{ rootPath: string; outputPath: string; contextPath: string }> {
  const rootPath   = await mkdtemp(join(tmpdir(), 'mcp-watcher-int-'));
  const outputPath = join(rootPath, '.openlore', 'analysis');
  await mkdir(outputPath, { recursive: true });
  const contextPath = join(outputPath, 'llm-context.json');
  await writeFile(contextPath, JSON.stringify(makeContext(), null, 2), 'utf-8');
  return { rootPath, outputPath, contextPath };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('McpWatcher — real fs watcher', () => {
  const watchers: McpWatcher[] = [];

  afterEach(async () => {
    for (const w of watchers) await w.stop();
    watchers.length = 0;
  });

  it('picks up a changed TypeScript file and updates llm-context.json', async () => {
    const { rootPath, outputPath, contextPath } = await setupProject();

    // Create the file BEFORE starting the watcher so the first write is a change, not an add
    const srcFile = join(rootPath, 'src', 'auth.ts');
    await mkdir(join(rootPath, 'src'), { recursive: true });
    await writeFile(srcFile, 'export function login() {}', 'utf-8');

    const watcher = new McpWatcher({ rootPath, outputPath, debounceMs: DEBOUNCE_MS });
    watchers.push(watcher);
    await watcher.start();

    // Modify the file — triggers chokidar 'change' event
    await writeFile(srcFile, 'export function login(user: string): boolean { return true; }', 'utf-8');

    await wait(WAIT_MS);

    const updated = JSON.parse(await readFile(contextPath, 'utf-8')) as LLMContext;
    const entry = updated.signatures?.find(s => s.path === 'src/auth.ts');
    expect(entry, 'signature entry for src/auth.ts should exist').toBeDefined();
    expect(entry!.language).toBe('TypeScript');
    expect(entry!.entries.some(e => e.name === 'login')).toBe(true);
  }, 10_000);

  it('preserves the callGraph after re-indexing', async () => {
    const { rootPath, outputPath, contextPath } = await setupProject();
    const original = JSON.parse(await readFile(contextPath, 'utf-8')) as LLMContext;

    const srcFile = join(rootPath, 'util.ts');
    await writeFile(srcFile, 'export function noop() {}', 'utf-8');

    const watcher = new McpWatcher({ rootPath, outputPath, debounceMs: DEBOUNCE_MS });
    watchers.push(watcher);
    await watcher.start();

    await writeFile(srcFile, 'export function noop() { /* updated */ }', 'utf-8');
    await wait(WAIT_MS);

    const updated = JSON.parse(await readFile(contextPath, 'utf-8')) as LLMContext;
    expect(updated.callGraph).toEqual(original.callGraph);
  }, 10_000);

  it('updates the entry when the same file is changed twice', async () => {
    const { rootPath, outputPath, contextPath } = await setupProject();

    const srcFile = join(rootPath, 'service.ts');
    await writeFile(srcFile, 'export function first() {}', 'utf-8');

    const watcher = new McpWatcher({ rootPath, outputPath, debounceMs: DEBOUNCE_MS });
    watchers.push(watcher);
    await watcher.start();

    // First change
    await writeFile(srcFile, 'export function second() {}', 'utf-8');
    await wait(WAIT_MS);

    const after1 = JSON.parse(await readFile(contextPath, 'utf-8')) as LLMContext;
    expect(after1.signatures?.find(s => s.path === 'service.ts')?.entries.some(e => e.name === 'second')).toBe(true);

    // Second change
    await writeFile(srcFile, 'export function third() {}', 'utf-8');
    await wait(WAIT_MS);

    const after2 = JSON.parse(await readFile(contextPath, 'utf-8')) as LLMContext;
    const entry = after2.signatures?.find(s => s.path === 'service.ts');
    expect(entry?.entries.some(e => e.name === 'third')).toBe(true);
    // No duplicate entries for the same file
    expect(after2.signatures?.filter(s => s.path === 'service.ts')).toHaveLength(1);
  }, 15_000);

  it('keeps dependency-graph.json import edges live when an import changes', async () => {
    const { rootPath, outputPath } = await setupProject();

    // a.ts imports ./b initially; b.ts and c.ts are resolvable targets.
    const aFile = join(rootPath, 'a.ts');
    const absA = aFile, absB = join(rootPath, 'b.ts'), absC = join(rootPath, 'c.ts');
    await writeFile(aFile, "import { x } from './b';\nexport const y = x;\n", 'utf-8');
    await writeFile(absB, 'export const x = 1;\n', 'utf-8');
    await writeFile(absC, 'export const x = 2;\n', 'utf-8');

    // Seed dependency-graph.json with the a → b edge (as a full analyze would).
    const graphPath = join(outputPath, 'dependency-graph.json');
    await writeFile(graphPath, JSON.stringify({
      nodes: [
        { id: absA, metrics: { inDegree: 0, outDegree: 1 } },
        { id: absB, metrics: { inDegree: 1, outDegree: 0 } },
        { id: absC, metrics: { inDegree: 0, outDegree: 0 } },
      ],
      edges: [{ source: absA, target: absB, importedNames: ['x'], isTypeOnly: false, weight: 1 }],
    }), 'utf-8');

    const watcher = new McpWatcher({ rootPath, outputPath, debounceMs: DEBOUNCE_MS });
    watchers.push(watcher);
    await watcher.start();

    // Re-point the import from ./b to ./c.
    await writeFile(aFile, "import { x } from './c';\nexport const y = x;\n", 'utf-8');
    await wait(WAIT_MS);

    const g = JSON.parse(await readFile(graphPath, 'utf-8')) as {
      nodes: Array<{ id: string; metrics: { inDegree: number; outDegree: number } }>;
      edges: Array<{ source: string; target: string }>;
    };
    // Old edge gone, new edge present.
    expect(g.edges.some(e => e.source === absA && e.target === absB)).toBe(false);
    expect(g.edges.some(e => e.source === absA && e.target === absC)).toBe(true);
    // Degrees recomputed: c now consumed, b no longer.
    expect(g.nodes.find(n => n.id === absC)!.metrics.inDegree).toBe(1);
    expect(g.nodes.find(n => n.id === absB)!.metrics.inDegree).toBe(0);
    expect(g.nodes.find(n => n.id === absA)!.metrics.outDegree).toBe(1);
  }, 15_000);

  it('preserves call-synthesized edges and drops all import edges when imports are removed', async () => {
    const { rootPath, outputPath } = await setupProject();
    const aFile = join(rootPath, 'a.ts');
    const absA = aFile, absB = join(rootPath, 'b.ts');
    await writeFile(aFile, "import { x } from './b';\nexport const y = x;\n", 'utf-8');
    await writeFile(absB, 'export const x = 1;\n', 'utf-8');

    const graphPath = join(outputPath, 'dependency-graph.json');
    await writeFile(graphPath, JSON.stringify({
      nodes: [
        { id: absA, metrics: { inDegree: 0, outDegree: 1 } },
        { id: absB, metrics: { inDegree: 1, outDegree: 0 } },
      ],
      edges: [
        { source: absA, target: absB, importedNames: ['x'], isTypeOnly: false, weight: 1 },
        // A call-synthesized edge from the same source — must survive the patch.
        { source: absA, target: absB, importedNames: [], isTypeOnly: false, weight: 1, isCallEdge: true },
      ],
    }), 'utf-8');

    const watcher = new McpWatcher({ rootPath, outputPath, debounceMs: DEBOUNCE_MS });
    watchers.push(watcher);
    await watcher.start();

    // Remove the import entirely.
    await writeFile(aFile, 'export const y = 42;\n', 'utf-8');
    await wait(WAIT_MS);

    const g = JSON.parse(await readFile(graphPath, 'utf-8')) as {
      nodes: Array<{ id: string; metrics: { outDegree: number } }>;
      edges: Array<{ source: string; target: string; isCallEdge?: boolean }>;
    };
    // The import edge is gone…
    expect(g.edges.some(e => e.source === absA && e.target === absB && !e.isCallEdge)).toBe(false);
    // …but the call-synthesized edge survives (watcher doesn't rebuild those).
    expect(g.edges.some(e => e.source === absA && e.isCallEdge === true)).toBe(true);
  }, 15_000);

  it('keeps HTML asset edges live when an inline <script src> changes', async () => {
    const { rootPath, outputPath } = await setupProject();
    const htmlFile = join(rootPath, 'index.html');
    const absHtml = htmlFile, absOld = join(rootPath, 'old.js'), absApp = join(rootPath, 'app.js');
    await writeFile(htmlFile, '<html><body><script src="old.js"></script></body></html>\n', 'utf-8');
    await writeFile(absOld, 'console.log(1);\n', 'utf-8');
    await writeFile(absApp, 'console.log(2);\n', 'utf-8');

    const graphPath = join(outputPath, 'dependency-graph.json');
    await writeFile(graphPath, JSON.stringify({
      nodes: [
        { id: absHtml, metrics: { inDegree: 0, outDegree: 1 } },
        { id: absOld, metrics: { inDegree: 1, outDegree: 0 } },
        { id: absApp, metrics: { inDegree: 0, outDegree: 0 } },
      ],
      edges: [{ source: absHtml, target: absOld, importedNames: [], isTypeOnly: false, weight: 1, assetKind: 'script' }],
    }), 'utf-8');

    const watcher = new McpWatcher({ rootPath, outputPath, debounceMs: DEBOUNCE_MS });
    watchers.push(watcher);
    await watcher.start();

    // Re-point the script from old.js to app.js.
    await writeFile(htmlFile, '<html><body><script src="app.js"></script></body></html>\n', 'utf-8');
    await wait(WAIT_MS);

    const g = JSON.parse(await readFile(graphPath, 'utf-8')) as {
      edges: Array<{ source: string; target: string; assetKind?: string }>;
    };
    expect(g.edges.some(e => e.source === absHtml && e.target === absOld)).toBe(false);
    const appEdge = g.edges.find(e => e.source === absHtml && e.target === absApp);
    expect(appEdge, 'index.html → app.js asset edge').toBeDefined();
    expect(appEdge!.assetKind).toBe('script');
  }, 15_000);

  it('adds a node for a file not yet in the graph (new file / first edit after analyze)', async () => {
    const { rootPath, outputPath } = await setupProject();
    const aFile = join(rootPath, 'a.ts');
    const absA = aFile, absOther = join(rootPath, 'other.ts');
    await writeFile(aFile, "import { z } from './other';\nexport const y = z;\n", 'utf-8');
    await writeFile(absOther, 'export const z = 1;\n', 'utf-8');

    const graphPath = join(outputPath, 'dependency-graph.json');
    // a.ts is NOT yet a node; other.ts is.
    await writeFile(graphPath, JSON.stringify({
      nodes: [{ id: absOther, file: { path: 'other.ts', absolutePath: absOther }, metrics: { inDegree: 0, outDegree: 0 } }],
      edges: [],
    }), 'utf-8');

    const watcher = new McpWatcher({ rootPath, outputPath, debounceMs: DEBOUNCE_MS });
    watchers.push(watcher);
    await watcher.start();
    await writeFile(aFile, "import { z } from './other';\nexport const y = z + 1;\n", 'utf-8');
    await wait(WAIT_MS);

    const g = JSON.parse(await readFile(graphPath, 'utf-8')) as {
      nodes: Array<{ id: string }>;
      edges: Array<{ source: string; target: string }>;
    };
    // a.ts is now a node, with its outgoing edge to other.ts.
    expect(g.nodes.some(n => n.id === absA)).toBe(true);
    expect(g.edges.some(e => e.source === absA && e.target === absOther)).toBe(true);
  }, 15_000);

  it('removes a deleted file node and its edges from the dependency graph', async () => {
    const { rootPath, outputPath } = await setupProject();
    const absA = join(rootPath, 'a.ts'), absB = join(rootPath, 'b.ts');
    await writeFile(absA, "import { x } from './b';\nexport const y = x;\n", 'utf-8');
    await writeFile(absB, 'export const x = 1;\n', 'utf-8');

    const graphPath = join(outputPath, 'dependency-graph.json');
    await writeFile(graphPath, JSON.stringify({
      nodes: [
        { id: absA, file: { path: 'a.ts', absolutePath: absA }, metrics: { inDegree: 0, outDegree: 1 } },
        { id: absB, file: { path: 'b.ts', absolutePath: absB }, metrics: { inDegree: 1, outDegree: 0 } },
      ],
      edges: [{ source: absA, target: absB, importedNames: ['x'], isTypeOnly: false, weight: 1 }],
    }), 'utf-8');

    const watcher = new McpWatcher({ rootPath, outputPath, debounceMs: DEBOUNCE_MS });
    watchers.push(watcher);
    await watcher.start();

    // Delete b.ts — fires chokidar 'unlink'.
    await rm(absB);
    await wait(WAIT_MS);

    const g = JSON.parse(await readFile(graphPath, 'utf-8')) as {
      nodes: Array<{ id: string }>;
      edges: Array<{ source: string; target: string }>;
    };
    expect(g.nodes.some(n => n.id === absB), 'b.ts node should be gone').toBe(false);
    expect(g.edges.some(e => e.target === absB), 'edges to b.ts should be gone').toBe(false);
    expect(g.nodes.some(n => n.id === absA), 'a.ts node should remain').toBe(true);
  }, 15_000);

  it('supersession: delete-then-recreate ends indexed; recreate-then-delete ends removed', async () => {
    const { rootPath, outputPath } = await setupProject();
    const absA = join(rootPath, 'a.ts'), absB = join(rootPath, 'b.ts');
    await writeFile(absA, "import { x } from './b';\nexport const y = x;\n", 'utf-8');
    await writeFile(absB, 'export const x = 1;\n', 'utf-8');
    const graphPath = join(outputPath, 'dependency-graph.json');
    const seed = () => writeFile(graphPath, JSON.stringify({
      nodes: [
        { id: absA, file: { path: 'a.ts', absolutePath: absA }, metrics: { inDegree: 0, outDegree: 1 } },
        { id: absB, file: { path: 'b.ts', absolutePath: absB }, metrics: { inDegree: 1, outDegree: 0 } },
      ],
      edges: [{ source: absA, target: absB, importedNames: ['x'], isTypeOnly: false, weight: 1 }],
    }), 'utf-8');
    const nodes = async () => (JSON.parse(await readFile(graphPath, 'utf-8')) as { nodes: Array<{ id: string }> }).nodes;

    await seed();
    const watcher = new McpWatcher({ rootPath, outputPath, debounceMs: DEBOUNCE_MS });
    watchers.push(watcher);
    await watcher.start();

    // delete → recreate (in event order) ends with a.ts present.
    await rm(absA);
    await writeFile(absA, "import { x } from './b';\nexport const y = x + 1;\n", 'utf-8');
    await wait(WAIT_MS);
    expect((await nodes()).some(n => n.id === absA), 'delete→recreate ⇒ present').toBe(true);

    // recreate (change) → delete ends with a.ts removed (deletion wins — the
    // supersession guard prevents a re-add after the delete in one flush).
    await seed();
    await writeFile(absA, "import { x } from './b';\nexport const y = x + 2;\n", 'utf-8');
    await rm(absA);
    await wait(WAIT_MS);
    expect((await nodes()).some(n => n.id === absA), 'recreate→delete ⇒ removed').toBe(false);
  }, 20_000);

  it('G1: a real save primes the read cache — the next tool-call read is a HIT, not a cold re-parse', async () => {
    // The root-cause #2 fix (Spec 13.1): the watcher's write used to bump
    // llm-context.json's mtime and force the NEXT MCP tool call to re-parse the
    // whole ~2 MB file cold. persistContext now hands the patched context to the
    // shared read cache (primeContextCache) so the next read is served from
    // memory. The unit tests prove primeContextCache→hit in isolation; this proves
    // the REAL chokidar → handleBatch → persistContext → primeContextCache chain,
    // then proves the next read returns that exact primed object (reference
    // identity ⇒ no disk re-parse).
    const { rootPath } = await setupProject(); // standard .openlore/analysis layout
    _resetContextCacheForTesting();
    const primeSpy = vi.spyOn(utils, 'primeContextCache');

    const srcFile = join(rootPath, 'svc.ts');
    await writeFile(srcFile, 'export function before() {}', 'utf-8');

    const watcher = new McpWatcher({ rootPath, debounceMs: DEBOUNCE_MS }); // no outputPath → standard layout
    watchers.push(watcher);
    await watcher.start();

    await writeFile(srcFile, 'export function after() {}', 'utf-8');
    await wait(WAIT_MS);

    // The real event path handed the patched context to the read cache.
    expect(primeSpy, 'watcher must prime the read cache after a save').toHaveBeenCalled();
    const primed = primeSpy.mock.calls.at(-1)![1] as LLMContext;
    // Freshness (G6) landed in the primed object itself.
    const entry = primed.signatures?.find((s) => s.path === 'svc.ts');
    expect(entry?.entries.some((e) => e.name === 'after'), 'primed context reflects the edit').toBe(true);

    // G1: the next tool-call read is served from that primed object — a cold
    // re-parse would return a different object reference.
    const afterRead = await readCachedContext(rootPath);
    expect(afterRead, 'post-save read must be the primed object, not a fresh disk parse').toBe(primed);
  }, 10_000);

  it('ignores .test.ts files', async () => {
    const { rootPath, outputPath, contextPath } = await setupProject();
    const before = await readFile(contextPath, 'utf-8');

    const testFile = join(rootPath, 'auth.test.ts');
    await writeFile(testFile, 'it("x", () => {})', 'utf-8');

    const watcher = new McpWatcher({ rootPath, outputPath, debounceMs: DEBOUNCE_MS });
    watchers.push(watcher);
    await watcher.start();

    await writeFile(testFile, 'it("y", () => {})', 'utf-8');
    await wait(WAIT_MS);

    const after = await readFile(contextPath, 'utf-8');
    expect(after).toBe(before);
  }, 10_000);
});

// ── The watcher re-derives its target every cycle, not once per process ──────
//
// This was the worse half of the TOCTOU finding: approval happened in the
// constructor, so one check at startup licensed every write for the lifetime of a
// server that runs for hours. Swapping `.openlore` for a symlink thirty seconds in
// sent the whole subsequent stream of re-indexing outside the root, while the real
// index stopped moving — and nothing complained.
//
// A mutation matrix then showed the fix had no lock on it at all: the existing
// watcher tests all pass an explicit `outputPath`, which pins it and skips
// re-derivation entirely, so removing the re-derivation broke nothing.
describe('McpWatcher — a mid-session symlink swap does not redirect the index', () => {
  const wait = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
  let root = '';
  let honeypot = '';

  afterEach(async () => {
    _resetRootAllowlistForTesting();
    _resetContextCacheForTesting();
    for (const d of [root, honeypot]) if (d) await rm(d, { recursive: true, force: true });
    root = honeypot = '';
  });

  it('keeps writing nowhere rather than into the swapped-in target', async () => {
    const { realpathSync, symlinkSync, rmSync, cpSync, statSync, existsSync } = await import('node:fs');
    root = realpathSync(await mkdtemp(join(tmpdir(), 'ol-wswap-root-')));
    honeypot = realpathSync(await mkdtemp(join(tmpdir(), 'ol-wswap-pot-')));
    // Seed an index the way setupProject does: the watcher UPDATES an analysis, it
    // does not create one from nothing — without this the first cycle writes nothing
    // and the non-vacuity guard below (correctly) refuses to let the test proceed.
    await mkdir(join(root, '.openlore', 'analysis'), { recursive: true });
    await writeFile(join(root, '.openlore', 'analysis', 'llm-context.json'),
      JSON.stringify(makeContext(), null, 2), 'utf-8');
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'export function a(): number { return 1; }\n', 'utf-8');

    configureRootAllowlist({ readRoots: [root], writeRoots: [root] });

    // NOTE: no explicit outputPath — pinning it skips the re-derivation this test exists to pin.
    const seededAt = statSync(join(root, '.openlore', 'analysis', 'llm-context.json')).mtimeMs;
    await wait(20);
    const watcher = new McpWatcher({ rootPath: root, debounceMs: DEBOUNCE_MS, embed: false });
    await watcher.start();
    try {
      await writeFile(join(root, 'src', 'a.ts'), 'export function a(): number { return 2; }\n', 'utf-8');
      await wait(WAIT_MS * 4);
      const realCtx = join(root, '.openlore', 'analysis', 'llm-context.json');
      // Non-vacuity: a cycle really ran and really WROTE (mtime moved), not merely
      // that the seeded file exists.
      expect(existsSync(realCtx)).toBe(true);
      expect(statSync(realCtx).mtimeMs,
        'the watcher never updated the index — the test would be vacuous').toBeGreaterThan(seededAt);

      // The swap, mid-session. The honeypot is SEEDED with the current index, so the
      // watcher can keep working after the swap — otherwise the cycle dies for want of
      // a context and the test passes for the wrong reason.
      cpSync(join(root, '.openlore'), join(honeypot, '.openlore'), { recursive: true });
      rmSync(join(root, '.openlore'), { recursive: true, force: true });
      symlinkSync(join(honeypot, '.openlore'), join(root, '.openlore'));
      const potCtx = join(honeypot, '.openlore', 'analysis', 'llm-context.json');
      const before = statSync(potCtx).mtimeMs;

      await writeFile(join(root, 'src', 'a.ts'), 'export function a(): number { return 3; }\n', 'utf-8');
      await wait(WAIT_MS * 6);

      expect(statSync(potCtx).mtimeMs,
        'the watcher followed the swapped link and re-indexed into the honeypot').toBe(before);
    } finally {
      await watcher.stop();
    }
  }, 120_000);
});
