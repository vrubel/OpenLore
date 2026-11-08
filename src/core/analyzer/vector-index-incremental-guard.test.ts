/**
 * D2 (PDLC-2785): an incremental update never silently downgrades a semantic
 * function index. When the saved vectors cannot stay valid — an index written
 * by an older OpenLore without a publication generation (ru18), a different
 * embedding model, no embedder, a different vector dimension — updateFiles
 * publishes nothing and fails with a recovery hint; the published index stays
 * exactly as it was. Where the vectors stay valid it updates as before.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeQdrant } from './__tests__/fake-qdrant.test.helper.js';
import { VectorIndex, _resetVectorIndexCachesForTesting } from './vector-index.js';
import { openStoredVectorIndex, type VectorRecord } from './vector-store.js';
import type { FunctionNode } from './call-graph.js';
import type { EmbeddingService } from './embedding-service.js';

const DIM = 4;
const RECOVERY = /openlore analyze --embed --force/;

const embedder = (modelName: string, dim = DIM) =>
  ({ modelName, embed: vi.fn(async (texts: string[]) => texts.map(() => Array.from({ length: dim }, (_, i) => i + 1))) }) as unknown as EmbeddingService;
const node = (filePath: string, name: string) => ({
  id: `${filePath}::${name}`, name, filePath, language: 'TypeScript', isAsync: false,
  signature: `function ${name}()`, docstring: '', fanIn: 0, fanOut: 0, startIndex: 0, endIndex: 0,
}) as FunctionNode;
const legacyRow = (name: string): VectorRecord => ({
  id: `src/${name}.ts::${name}`, name, filePath: `src/${name}.ts`, className: '', language: 'TypeScript',
  signature: '', docstring: '', fanIn: 0, fanOut: 0, isHub: false, isEntryPoint: false, text: name, vector: [1, 0, 0, 0],
});

let out: string;
const db = () => join(out, 'vector-index');

/** Everything a publication would change: the files of the index folder and their bytes. */
async function published(): Promise<Record<string, string>> {
  const state: Record<string, string> = {};
  for (const name of (await readdir(db())).sort()) {
    state[name] = name.endsWith('.json') || name.startsWith('.qdrant-') ? await readFile(join(db(), name), 'utf8') : 'dir';
  }
  return state;
}

async function ru18Local(): Promise<void> {
  await mkdir(db(), { recursive: true });
  await writeFile(join(db(), 'functions.records.json'), [legacyRow('alpha'), legacyRow('beta')].map(r => JSON.stringify(r)).join('\n') + '\n');
  await writeFile(join(out, 'vector-index-meta.json'), JSON.stringify({ hasEmbeddings: true, dim: DIM, model: 'embed-model', builtAt: 'x', schemaVersion: 1 }));
}

const change = (svc: EmbeddingService | null | undefined) => VectorIndex.updateFiles(
  out, [node('src/beta.ts', 'gamma')], new Set(['src/beta.ts']), [], new Set(), new Set(), svc,
);
const deletion = () => VectorIndex.updateFiles(out, [], new Set(['src/beta.ts']), [], new Set(), new Set(), undefined);

beforeEach(async () => {
  vi.stubEnv('QDRANT_URL', undefined);
  vi.stubEnv('OPENLORE_PINNED_INDEX', undefined);
  out = await mkdtemp(join(tmpdir(), 'ol-incremental-guard-'));
  _resetVectorIndexCachesForTesting();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(out, { recursive: true, force: true });
});

describe('D2: no publication when the saved vectors cannot stay valid', () => {
  it('ru18 local index, same model: refuses with a recovery hint and leaves the index as it was', async () => {
    await ru18Local();
    expect((await openStoredVectorIndex(db(), 'functions')).identity).toMatchObject({ generation: null, model: 'embed-model', dim: DIM });
    const before = await published();

    await expect(change(embedder('embed-model'))).rejects.toThrow(RECOVERY);
    expect(await published()).toEqual(before);
    expect((await openStoredVectorIndex(db(), 'functions')).identity).toMatchObject({ generation: null, dim: DIM });
  });

  it('ru18 local index, deletion only: refuses and leaves the index as it was', async () => {
    await ru18Local();
    const before = await published();

    await expect(deletion()).rejects.toThrow(RECOVERY);
    expect(await published()).toEqual(before);
  });

  it('ru18 Qdrant index: refuses without creating a collection or a descriptor', async () => {
    const qdrant = new FakeQdrant();
    vi.stubEnv('QDRANT_URL', qdrant.url);
    vi.stubGlobal('fetch', qdrant.fetch);
    await mkdir(db(), { recursive: true });
    const name = 'openlore_functions_' + createHash('sha1').update(db()).digest('hex').slice(0, 12);
    await writeFile(join(db(), '.qdrant-functions'), name + '\n');
    await writeFile(join(out, 'vector-index-meta.json'), JSON.stringify({ hasEmbeddings: true, dim: DIM, model: 'embed-model', builtAt: 'x', schemaVersion: 1 }));
    qdrant.seed(name, DIM, [legacyRow('alpha'), legacyRow('beta')].map(({ vector, ...payload }) => ({ id: 'p-' + payload.name, vector, payload })));
    const before = await published();

    await expect(change(embedder('embed-model'))).rejects.toThrow(RECOVERY);
    expect(await published()).toEqual(before);
    expect([...qdrant.collections.keys()]).toEqual([name]);
    expect(qdrant.callsTo('PUT', '')).toEqual([]);
  });

  it('index with a generation, different model: refuses and keeps the published generation', async () => {
    await VectorIndex.build(out, [node('src/alpha.ts', 'alpha'), node('src/beta.ts', 'beta')], [], new Set(), new Set(), embedder('model-a'));
    const before = await published();

    await expect(change(embedder('model-b'))).rejects.toThrow(RECOVERY);
    expect(await published()).toEqual(before);
  });

  it('index with a generation and vectors, no embedder: refuses and keeps the published generation', async () => {
    await VectorIndex.build(out, [node('src/alpha.ts', 'alpha'), node('src/beta.ts', 'beta')], [], new Set(), new Set(), embedder('model-a'));
    const before = await published();

    await expect(change(null)).rejects.toThrow(RECOVERY);
    expect(await published()).toEqual(before);
  });

  it('same model, different vector dimension: refuses and keeps the published generation', async () => {
    await VectorIndex.build(out, [node('src/alpha.ts', 'alpha'), node('src/beta.ts', 'beta')], [], new Set(), new Set(), embedder('model-a'));
    const before = await published();

    await expect(change(embedder('model-a', 3))).rejects.toThrow(RECOVERY);
    expect(await published()).toEqual(before);
  });
});

describe('D2 controls: the update proceeds where the saved vectors stay valid', () => {
  it('index with a generation, same model: publishes a new semantic generation', async () => {
    await VectorIndex.build(out, [node('src/alpha.ts', 'alpha'), node('src/beta.ts', 'beta')], [], new Set(), new Set(), embedder('model-a'));
    const generation = (await openStoredVectorIndex(db(), 'functions')).identity.generation;

    const result = await change(embedder('model-a'));
    expect(result.hasEmbeddings).toBe(true);
    const stored = await openStoredVectorIndex(db(), 'functions');
    expect(stored.identity.dim).toBe(DIM);
    expect(stored.identity.generation).not.toBe(generation);
    expect((await stored.backend.loadAll()).map(row => row.id).sort()).toEqual(['src/alpha.ts::alpha', 'src/beta.ts::gamma']);
  });

  it('index with a generation, deletion only without an embedder: keeps the surviving vectors', async () => {
    await VectorIndex.build(out, [node('src/alpha.ts', 'alpha'), node('src/beta.ts', 'beta')], [], new Set(), new Set(), embedder('model-a'));

    const result = await deletion();
    expect(result.hasEmbeddings).toBe(true);
    const stored = await openStoredVectorIndex(db(), 'functions');
    expect(stored.identity.dim).toBe(DIM);
    expect((await stored.backend.loadAll()).map(row => row.id)).toEqual(['src/alpha.ts::alpha']);
  });

  it('keyword-only index without an embedder: stays a keyword index', async () => {
    await VectorIndex.build(out, [node('src/alpha.ts', 'alpha'), node('src/beta.ts', 'beta')], [], new Set(), new Set(), null);

    const result = await change(null);
    expect(result.hasEmbeddings).toBe(false);
    expect((await openStoredVectorIndex(db(), 'functions')).identity.dim).toBe(0);
  });
});
