/**
 * The call graph lives in call-graph.db, not in llm-context.json (PDLC-156).
 *
 * These are the guards for that split: the artifact must not carry the graph, the
 * store must carry ALL of it (test side included, in the original order), readers
 * must see exactly what they saw before, an analysis taken by an older version must
 * keep working, and a missing/empty store must be LOUD rather than an anonymous
 * "no call graph".
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EdgeStore } from './edge-store.js';
import { loadCallGraph, attachCallGraphFromStore } from './call-graph-loader.js';
import { serializeCallGraph, CallGraphBuilder } from '../analyzer/call-graph.js';
import { writeEdgesToSQLite } from '../analyzer/artifact-generator.js';
import { readCachedContext, _resetContextCacheForTesting } from './mcp-handlers/utils.js';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_LLM_CONTEXT } from '../../constants.js';
import { logger } from '../../utils/logger.js';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'cg-split-'));
  _resetContextCacheForTesting();
});

afterEach(async () => {
  _resetContextCacheForTesting();
  await rm(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A graph with production code, a test file, and the tested_by edge between them. */
async function buildGraph() {
  return serializeCallGraph(
    await new CallGraphBuilder().build([
      {
        path: 'src/calc.ts',
        content: 'export function add(a: number, b: number): number { return helper(a) + b; }\nexport function helper(x: number): number { return x; }\n',
        language: 'TypeScript',
      },
      {
        // A NAMED function, so the test file contributes a real node: an anonymous
        // describe/it body yields only a synthetic tested_by target.
        path: 'src/calc.test.ts',
        content: 'import { add } from "./calc.js";\nexport function checkAdd(): number { return add(1, 2); }\n',
        language: 'TypeScript',
      },
    ]),
  );
}

async function analysisDirWith(graphWritten: boolean, ctxExtra: Record<string, unknown> = {}) {
  const dir = join(tmp, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
  await mkdir(dir, { recursive: true });
  const ctx = {
    phase1_survey: { purpose: '', files: [{ path: 'src/calc.ts', tokens: 1 }], estimatedTokens: 1 },
    phase2_deep: { purpose: '', files: [], totalTokens: 0 },
    phase3_validation: { purpose: '', files: [], totalTokens: 0 },
    signatures: [{ path: 'src/calc.ts', language: 'TypeScript', entries: [] }],
    ...ctxExtra,
  };
  await writeFile(join(dir, ARTIFACT_LLM_CONTEXT), JSON.stringify(ctx), 'utf-8');
  if (graphWritten) {
    await writeEdgesToSQLite(await buildGraph(), EdgeStore.dbPath(dir), tmp);
  }
  return dir;
}

describe('call graph round-trip through the store', () => {
  it('materializes the graph the artifact used to carry — same arrays, same order', async () => {
    const graph = await buildGraph();
    const dir = join(tmp, 'analysis');
    await mkdir(dir, { recursive: true });
    await writeEdgesToSQLite(graph, EdgeStore.dbPath(dir), tmp);

    const restored = loadCallGraph(dir)!;
    expect(restored).toBeTruthy();
    expect(restored.nodes.map(n => n.id)).toEqual(graph.nodes.map(n => n.id));
    expect(restored.edges.map(e => `${e.callerId}->${e.calleeId}`))
      .toEqual(graph.edges.map(e => `${e.callerId}->${e.calleeId}`));
    expect(restored.classes.map(c => c.id)).toEqual(graph.classes.map(c => c.id));
    expect(restored.hubFunctions.map(n => n.id)).toEqual(graph.hubFunctions.map(n => n.id));
    expect(restored.entryPoints.map(n => n.id)).toEqual(graph.entryPoints.map(n => n.id));
    expect(restored.stats).toEqual(graph.stats);
    expect(restored.layerViolations).toEqual(graph.layerViolations);
  });

  it('keeps the fields that used to survive only in the artifact', async () => {
    const graph = await buildGraph();
    const dir = join(tmp, 'analysis');
    await mkdir(dir, { recursive: true });
    await writeEdgesToSQLite(graph, EdgeStore.dbPath(dir), tmp);

    const restored = loadCallGraph(dir)!;
    for (const original of graph.nodes) {
      const back = restored.nodes.find(n => n.id === original.id)!;
      expect(back, `node ${original.id} must survive the store`).toBeTruthy();
      expect(back.startLine).toBe(original.startLine);
      expect(back.endLine).toBe(original.endLine);
      expect(back.communityId).toBe(original.communityId);
      expect(back.communityLabel).toBe(original.communityLabel);
      expect(back.cyclomaticComplexity).toBe(original.cyclomaticComplexity);
      expect(!!back.isTest).toBe(!!original.isTest);
    }
  });

  it('keeps the test side of the graph, which test-impact reads', async () => {
    const graph = await buildGraph();
    const dir = join(tmp, 'analysis');
    await mkdir(dir, { recursive: true });
    await writeEdgesToSQLite(graph, EdgeStore.dbPath(dir), tmp);

    const restored = loadCallGraph(dir)!;
    expect(restored.nodes.some(n => n.isTest), 'test nodes must be stored').toBe(true);
    expect(restored.edges.some(e => e.kind === 'tested_by'), 'tested_by edges must be stored').toBe(true);
  });

  it('hides the test side from every production query, exactly as before', async () => {
    const graph = await buildGraph();
    const dir = join(tmp, 'analysis');
    await mkdir(dir, { recursive: true });
    await writeEdgesToSQLite(graph, EdgeStore.dbPath(dir), tmp);

    const store = EdgeStore.open(EdgeStore.dbPath(dir));
    try {
      const testNode = graph.nodes.find(n => n.isTest)!;
      expect(testNode).toBeTruthy();
      expect(store.getNode(testNode.id)).toBeNull();
      expect(store.getAllInternalNodes().some(n => n.isTest)).toBe(false);
      expect(store.getNodesForFile('src/calc.test.ts')).toHaveLength(0);
      expect(store.searchNodes('add').some(n => n.isTest)).toBe(false);
      // tested_by edges are test-side: production callers/callees must not see them.
      const add = graph.nodes.find(n => n.name === 'add' && !n.isTest)!;
      expect(store.getCallers(add.id).some(e => e.kind === 'tested_by')).toBe(false);
      expect(store.countNodes()).toBe(graph.nodes.filter(n => !n.isExternal && !n.isTest).length);
    } finally {
      store.close();
    }
  });
});

describe('readCachedContext', () => {
  it('serves the graph from the store although the artifact carries none', async () => {
    await analysisDirWith(true);
    const ctx = await readCachedContext(tmp);
    expect(ctx).not.toBeNull();
    const onDisk = JSON.parse(
      await readFile(join(tmp, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_LLM_CONTEXT), 'utf-8'),
    ) as { callGraph?: unknown };
    expect(onDisk.callGraph, 'the artifact must not carry the graph').toBeUndefined();
    expect(ctx!.callGraph, 'but the reader must still see it').toBeDefined();
    expect(ctx!.callGraph!.nodes.length).toBeGreaterThan(0);
  });

  it('materializes the graph LAZILY — a tool that never reads it pays nothing', async () => {
    const dir = await analysisDirWith(true);
    const spy = vi.spyOn(EdgeStore.prototype, 'materializeCallGraph');
    _resetContextCacheForTesting();
    const ctx = await readCachedContext(tmp);
    expect(spy).not.toHaveBeenCalled();
    void ctx!.callGraph;
    expect(spy).toHaveBeenCalledTimes(1);
    void ctx!.callGraph;
    expect(spy, 'and only once per context').toHaveBeenCalledTimes(1);
    expect(dir).toBeTruthy();
  });

  it('says WHY the graph is unavailable when the store is missing next to a real analysis', async () => {
    const warn = vi.spyOn(logger, 'warning').mockImplementation(() => {});
    await analysisDirWith(false);
    const ctx = await readCachedContext(tmp);
    expect(ctx!.callGraph).toBeUndefined();
    // Silence here is the bug this guards: "no call graph" would otherwise read
    // exactly like "this repository was never analyzed".
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.map(c => String(c[0])).join('\n')).toMatch(/call graph|call-graph\.db/i);
  });

  it('still reads an analysis taken by an older version, which carries the graph inline', async () => {
    const legacy = {
      nodes: [{ id: 'src/a.ts::foo', name: 'foo', filePath: 'src/a.ts', isAsync: false, language: 'TypeScript', startIndex: 0, endIndex: 1, fanIn: 0, fanOut: 0 }],
      edges: [], classes: [], inheritanceEdges: [], hubFunctions: [], entryPoints: [], layerViolations: [],
      stats: { totalNodes: 1, totalEdges: 0, avgFanIn: 0, avgFanOut: 0 },
    };
    await analysisDirWith(false, { callGraph: legacy });
    const ctx = await readCachedContext(tmp);
    expect(ctx!.callGraph?.nodes.map(n => n.id)).toEqual(['src/a.ts::foo']);
  });
});

describe('attachCallGraphFromStore', () => {
  it('does not put the graph back into a context that gets written to disk', async () => {
    const dir = await analysisDirWith(true);
    const ctx = attachCallGraphFromStore({ signatures: [] } as Record<string, unknown>, dir, { enumerable: false });
    // Present to a reader...
    expect((ctx as { callGraph?: unknown }).callGraph).toBeDefined();
    // ...and absent from anything that serializes the context.
    expect(JSON.parse(JSON.stringify(ctx)).callGraph).toBeUndefined();
    expect(Object.keys({ ...(ctx as object) })).not.toContain('callGraph');
  });

  it('leaves an already-present (legacy) graph alone', () => {
    const legacy = { nodes: [], edges: [], classes: [], inheritanceEdges: [], hubFunctions: [], entryPoints: [], layerViolations: [], stats: { totalNodes: 0, totalEdges: 0, avgFanIn: 0, avgFanOut: 0 } };
    const ctx = attachCallGraphFromStore({ callGraph: legacy }, join(tmp, 'nowhere'))!;
    expect(ctx.callGraph).toBe(legacy);
  });
});
