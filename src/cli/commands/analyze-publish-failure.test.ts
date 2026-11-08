/**
 * D3 (PDLC-2785): when publishing the semantic index fails, `analyze` must say
 * so — not report an embedding failure. Real VectorIndex and vector store, a
 * real EmbeddingService from the environment, a fake Qdrant that rejects the
 * point upload; the rest of the analysis pipeline is mocked as in
 * analyze-no-embed.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeQdrant } from '../../core/analyzer/__tests__/fake-qdrant.test.helper.js';

vi.mock('../../utils/logger.js', () => ({
  logger: {
    section: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn(),
    success: vi.fn(), discovery: vi.fn(), analysis: vi.fn(), blank: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    access:    vi.fn().mockResolvedValue(undefined),
    stat:      vi.fn().mockResolvedValue({ mtime: new Date() }),
    mkdir:     vi.fn().mockResolvedValue(undefined),
    readFile:  vi.fn().mockResolvedValue('{}'),
    writeFile: vi.fn().mockResolvedValue(undefined),
  };
});

// fileExists(false) → getAnalysisAge null (fresh analysis) AND spec indexing skipped.
vi.mock('../../utils/command-helpers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/command-helpers.js')>();
  return {
    ...actual,
    fileExists: vi.fn().mockResolvedValue(false),
    getAnalysisAge: vi.fn().mockResolvedValue(null),
  };
});

vi.mock('../../core/analyzer/repository-mapper.js', () => ({
  RepositoryMapper: vi.fn().mockImplementation(function (this: unknown) {
    Object.assign(this as object, {
      map: vi.fn().mockResolvedValue({
        allFiles: [], highValueFiles: [], metadata: { projectName: 'proj' },
        summary: { totalFiles: 1, analyzedFiles: 1, skippedFiles: 0, languages: [] },
      }),
    });
  }),
}));

vi.mock('../../core/analyzer/dependency-graph.js', () => ({
  DependencyGraphBuilder: vi.fn().mockImplementation(function (this: unknown) {
    Object.assign(this as object, {
      build: vi.fn().mockResolvedValue({
        statistics: { nodeCount: 2, edgeCount: 1, clusterCount: 0, cycleCount: 0, avgDegree: 1 },
      }),
    });
  }),
}));

// callGraph WITH nodes so runEmbedStep reaches VectorIndex.build.
const CALL_GRAPH = {
  nodes: [{ id: 'a.ts::f', name: 'f', filePath: 'a.ts', line: 1, kind: 'function', calls: [] }],
  hubFunctions: [], entryPoints: [],
  stats: { totalNodes: 1, totalEdges: 0 },
};

vi.mock('../../core/analyzer/artifact-generator.js', () => ({
  AnalysisArtifactGenerator: vi.fn().mockImplementation(function (this: unknown) {
    Object.assign(this as object, {
      generateAndSave: vi.fn().mockResolvedValue({
        repoStructure: {
          architecture: { pattern: 'unknown' }, domains: [], uiComponents: [],
          schemas: [], routeInventory: { total: 0, byMethod: {}, byFramework: {}, routes: [] },
          middleware: [], envVars: [],
        },
        llmContext: { callGraph: CALL_GRAPH, signatures: [] },
      }),
    });
  }),
  repoStructureToRepoMap: vi.fn().mockReturnValue({}),
}));

vi.mock('../../core/analyzer/architecture-writer.js', () => ({
  buildArchitectureOverview: vi.fn().mockReturnValue({}),
  writeArchitectureMd: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../core/analyzer/codebase-digest.js', () => ({
  generateCodebaseDigest: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../core/analyzer/ui-component-extractor.js', () => ({ extractUIComponents: vi.fn().mockResolvedValue([]) }));
vi.mock('../../core/analyzer/schema-extractor.js', () => ({ extractSchemas: vi.fn().mockResolvedValue([]) }));
vi.mock('../../core/analyzer/http-route-parser.js', () => ({
  buildRouteInventory: vi.fn().mockResolvedValue({ total: 0, byMethod: {}, byFramework: {}, routes: [] }),
  extractAllHttpEdges: vi.fn().mockResolvedValue({ calls: [], routes: [], edges: [] }),
}));
vi.mock('../../core/analyzer/middleware-extractor.js', () => ({ extractMiddleware: vi.fn().mockResolvedValue([]) }));
vi.mock('../../core/analyzer/env-extractor.js', () => ({ extractEnvVars: vi.fn().mockResolvedValue([]) }));
vi.mock('../../core/analyzer/ai-config-generator.js', () => ({
  generateAiConfigs: vi.fn().mockResolvedValue([]), AI_TOOL_TARGETS: [],
}));

vi.mock('../../core/services/config-manager.js', () => ({ readOpenLoreConfig: vi.fn() }));

vi.mock('../../core/analyzer/spec-vector-index.js', () => ({
  SpecVectorIndex: { build: vi.fn().mockResolvedValue({ recordCount: 0, hasEmbeddings: false }), exists: vi.fn().mockReturnValue(false) },
}));

import { analyzeCommand } from './analyze.js';

const FAKE_CONFIG = {
  version: '1.0.0', projectType: 'nodejs' as const, openspecPath: './openspec',
  analysis: { maxFiles: 100000, includePatterns: [], excludePatterns: [] },
  generation: { provider: 'openai' as const, model: 'gpt-4', domains: 'auto' as const },
  createdAt: new Date().toISOString(), lastRun: null,
};

describe('analyze --embed: a failed index publication is reported as a publication failure', () => {
  let root: string;
  let qdrant: FakeQdrant;
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    const { mkdtemp: realMkdtemp } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    root = await realMkdtemp(join(tmpdir(), 'ol-analyze-publish-'));
    qdrant = new FakeQdrant();
    qdrant.fallback = async (url, init) => {
      // OpenAI-compatible /embeddings: one 4-dim vector per input.
      if (url.pathname !== '/v1/embeddings') throw new TypeError('fetch failed');
      const { input } = JSON.parse(String(init.body)) as { input: string[] };
      return new Response(JSON.stringify({ data: input.map((_, index) => ({ index, embedding: [1, 0.5, 0.25, index + 1] })) }));
    };
    // Qdrant accepts the new collection but rejects the point upload.
    qdrant.intercept = call => call.method === 'PUT' && call.suffix === '/points'
      ? new Response('{"status":{"error":"service unavailable"}}', { status: 503 })
      : undefined;
    vi.stubGlobal('fetch', qdrant.fetch);
    vi.stubEnv('QDRANT_URL', qdrant.url);
    vi.stubEnv('EMBED_BASE_URL', 'http://embed.test/v1');
    vi.stubEnv('EMBED_MODEL', 'embed-model');
    vi.stubEnv('EMBEDDER_URL', '');
    vi.stubEnv('OPENLORE_PINNED_INDEX', '');
    const cfgMod = await import('../../core/services/config-manager.js');
    vi.mocked(cfgMod.readOpenLoreConfig).mockResolvedValue(FAKE_CONFIG);
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(root);
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    process.exitCode = undefined;
    analyzeCommand.setOptionValue('embed', true);
  });

  afterEach(async () => {
    cwdSpy.mockRestore();
    consoleSpy.mockRestore();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    process.exitCode = undefined;
    const { rm: realRm } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    await realRm(root, { recursive: true, force: true });
  });

  it('names the publication, not the embedding, and still builds the keyword index', async () => {
    await analyzeCommand.parseAsync(['--embed'], { from: 'user' });

    const printed = consoleSpy.mock.calls.map((args: unknown[]) => args.join(' ')).join('\n');
    expect(qdrant.callsTo('PUT', '/points').length).toBeGreaterThan(0);
    expect(printed).not.toMatch(/Embedding failed/);
    expect(printed).toMatch(/Publishing the semantic search index failed/);
    expect(printed).toMatch(/Built keyword \(BM25\) search index/);
  });
});
