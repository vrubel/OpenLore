/**
 * D13 (PDLC-2785): the distributed embedder (`EMBEDDER_URL` without
 * `EMBED_MODEL`) carries its own model, so the configured model name is
 * unknown — and an index built that way records no model either. "Unknown" is
 * not "different": the reader keeps semantic search and the writer keeps the
 * vectors. A really different model still downgrades the reader to text.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VectorIndex, _resetVectorIndexCachesForTesting } from './vector-index.js';
import { EmbeddingService } from './embedding-service.js';
import { openStoredVectorIndex } from './vector-store.js';
import type { IndexCapability } from './index-capabilities.js';
import type { FunctionNode } from './call-graph.js';

const DIM = 4;
const vectorFor = (text: string) => [text.length % 7 + 1, text.includes('alpha') ? 3 : 1, text.includes('beta') ? 3 : 1, 1];

function node(filePath: string, name: string): FunctionNode {
  return {
    id: `${filePath}::${name}`, name, filePath, language: 'TypeScript', isAsync: false,
    signature: `function ${name}()`, docstring: '', fanIn: 0, fanOut: 0, startIndex: 0, endIndex: 0,
  } as FunctionNode;
}

function named(modelName: string): EmbeddingService {
  return { modelName, embed: vi.fn(async (texts: string[]) => texts.map(vectorFor)) } as unknown as EmbeddingService;
}

let outputDir: string;

beforeEach(async () => {
  outputDir = await mkdtemp(join(tmpdir(), 'ol-embed-model-'));
  vi.stubEnv('QDRANT_URL', undefined);
  vi.stubEnv('OPENLORE_PINNED_INDEX', undefined);
  vi.stubEnv('EMBED_BASE_URL', undefined);
  vi.stubEnv('EMBED_MODEL', undefined);
  vi.stubEnv('EMBEDDER_URL', 'http://embedder.test');
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (String(url) !== 'http://embedder.test/embed') throw new TypeError('fetch failed');
    const { chunks } = JSON.parse(String(init.body)) as { chunks: string[] };
    return new Response(JSON.stringify({ vectors: chunks.map(vectorFor), dimension: DIM }));
  }));
  _resetVectorIndexCachesForTesting();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  _resetVectorIndexCachesForTesting();
  await rm(outputDir, { recursive: true, force: true });
});

async function searchMode(embedder: EmbeddingService, query = 'alpha'): Promise<IndexCapability | undefined> {
  let capability: IndexCapability | undefined;
  _resetVectorIndexCachesForTesting();
  await VectorIndex.search(outputDir, query, embedder, { limit: 5, status: value => { capability = value; } });
  return capability;
}

describe('D13: an unknown embedding model is not a different model', () => {
  it('EMBEDDER_URL without EMBED_MODEL reads its own semantic index as semantic', async () => {
    const embedder = EmbeddingService.fromEnv();
    expect(embedder.modelName).toBe('');
    await VectorIndex.build(outputDir, [node('src/a.ts', 'alpha'), node('src/b.ts', 'beta')], [], new Set(), new Set(), embedder);

    const capability = await searchMode(embedder);
    expect(capability).toMatchObject({ mode: 'semantic', reason: null, identity: { model: null, dim: DIM } });
  });

  it('EMBEDDER_URL without EMBED_MODEL keeps the vectors on an incremental update', async () => {
    const embedder = EmbeddingService.fromEnv();
    await VectorIndex.build(outputDir, [node('src/a.ts', 'alpha'), node('src/b.ts', 'beta')], [], new Set(), new Set(), embedder);

    const result = await VectorIndex.updateFiles(
      outputDir, [node('src/b.ts', 'betaRenamed')], new Set(['src/b.ts']), [], new Set(), new Set(), embedder,
    );
    expect(result.hasEmbeddings).toBe(true);
    expect((await openStoredVectorIndex(join(outputDir, 'vector-index'), 'functions')).identity.dim).toBe(DIM);
    expect(await searchMode(embedder, 'betaRenamed')).toMatchObject({ mode: 'semantic', reason: null });
  });

  it('a known, different model still downgrades the reader to keyword search', async () => {
    await VectorIndex.build(outputDir, [node('src/a.ts', 'alpha')], [], new Set(), new Set(), named('model-a'));

    expect(await searchMode(named('model-a'))).toMatchObject({ mode: 'semantic', reason: null });
    expect(await searchMode(named('model-b'))).toMatchObject({ mode: 'text', reason: { code: 'embedding-mismatch' } });
  });
});

describe('D13 writer: stored vectors are reused only from the same model, or when neither side names one', () => {
  const RECOVERY = /openlore analyze --embed --force/;
  const nodes = () => [node('src/a.ts', 'alpha'), node('src/b.ts', 'beta')];
  const descriptor = async () => (await openStoredVectorIndex(join(outputDir, 'vector-index'), 'functions')).identity;

  it('build(incremental) over an unnamed-model index with a named model re-embeds everything', async () => {
    await VectorIndex.build(outputDir, nodes(), [], new Set(), new Set(), named(''));
    expect((await descriptor()).model).toBeNull();

    const svc = named('model-b');
    const result = await VectorIndex.build(outputDir, nodes(), [], new Set(), new Set(), svc, undefined, true);

    expect(result.reused).toBe(0);
    expect(svc.embed).toHaveBeenCalledWith(expect.arrayContaining([expect.stringContaining('alpha'), expect.stringContaining('beta')]));
    expect((await descriptor()).model).toBe('model-b');
  });

  it('build(incremental) with the same unnamed embedder reuses the vectors', async () => {
    await VectorIndex.build(outputDir, nodes(), [], new Set(), new Set(), named(''));
    const svc = named('');
    const result = await VectorIndex.build(outputDir, nodes(), [], new Set(), new Set(), svc, undefined, true);

    expect(result.reused).toBe(2);
    expect(svc.embed).not.toHaveBeenCalled();
  });

  it('updateFiles() on a named-model index with an unnamed embedder refuses and publishes nothing', async () => {
    await VectorIndex.build(outputDir, nodes(), [], new Set(), new Set(), named('model-a'));
    const before = await descriptor();

    await expect(VectorIndex.updateFiles(
      outputDir, [node('src/b.ts', 'betaRenamed')], new Set(['src/b.ts']), [], new Set(), new Set(), named(''),
    )).rejects.toThrow(RECOVERY);
    expect(await descriptor()).toEqual(before);
  });

  it('updateFiles() on an unnamed-model index with a named embedder refuses and publishes nothing', async () => {
    await VectorIndex.build(outputDir, nodes(), [], new Set(), new Set(), named(''));
    const before = await descriptor();

    await expect(VectorIndex.updateFiles(
      outputDir, [node('src/b.ts', 'betaRenamed')], new Set(['src/b.ts']), [], new Set(), new Set(), named('model-b'),
    )).rejects.toThrow(RECOVERY);
    expect(await descriptor()).toEqual(before);
  });

  it('the reader still treats an unnamed model as unknown, not different', async () => {
    await VectorIndex.build(outputDir, nodes(), [], new Set(), new Set(), named(''));
    expect(await searchMode(named('model-b'))).toMatchObject({ mode: 'semantic', reason: null });
  });
});
