/**
 * Публикация и чтение поколений поискового индекса в Qdrant — на поддельном
 * Qdrant (`__tests__/fake-qdrant.ts`), без сети.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeQdrant } from './__tests__/fake-qdrant.js';
import { VectorIndex, _resetVectorIndexCachesForTesting } from './vector-index.js';
import { openStoredVectorIndex, publishVectorIndex, type VectorRecord } from './vector-store.js';
import { extractSignatures } from './signature-extractor.js';
import type { FunctionNode } from './call-graph.js';
import type { EmbeddingService } from './embedding-service.js';

const DIM = 4;

function vectorFor(text: string): number[] {
  let h = 0;
  for (const char of text) h = (h * 31 + char.charCodeAt(0)) >>> 0;
  return Array.from({ length: DIM }, (_, i) => ((h >> (i * 4)) & 15) / 15 + 0.01);
}

function embedder(modelName = 'embed-model'): EmbeddingService {
  return {
    modelName,
    embed: vi.fn(async (texts: string[]) => texts.map(vectorFor)),
  } as unknown as EmbeddingService;
}

function node(filePath: string, name: string): FunctionNode {
  return {
    id: `${filePath}::${name}`, name, filePath, language: 'TypeScript', isAsync: false,
    signature: `function ${name}()`, docstring: '', fanIn: 0, fanOut: 0, startIndex: 0, endIndex: 0,
  } as FunctionNode;
}

// `export const User` + `export type User` — the signature extractor yields two
// entries with one name, so both synthetic candidates get the id `src/user.ts::User`.
const USER_SOURCE = 'export const User = { a: 1 } as const;\nexport type User = typeof User;\nexport function createUser() { return User; }\n';

let qdrant: FakeQdrant;
let outputDir: string;

beforeEach(async () => {
  qdrant = new FakeQdrant();
  vi.stubEnv('QDRANT_URL', qdrant.url);
  vi.stubEnv('OPENLORE_PINNED_INDEX', '');
  vi.stubGlobal('fetch', qdrant.fetch);
  outputDir = await mkdtemp(join(tmpdir(), 'ol-qdrant-'));
  _resetVectorIndexCachesForTesting();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  _resetVectorIndexCachesForTesting();
  await rm(outputDir, { recursive: true, force: true });
});

const dbPath = () => join(outputDir, 'vector-index');

describe('D3: one record per id before a Qdrant publication', () => {
  it('build() publishes a file whose signatures repeat one name (const + type)', async () => {
    const signatures = [extractSignatures('src/user.ts', USER_SOURCE)];
    expect(signatures[0].entries.filter(entry => entry.name === 'User')).toHaveLength(2);

    const result = await VectorIndex.build(
      outputDir, [node('src/user.ts', 'createUser')], signatures, new Set(), new Set(), embedder(),
    );
    expect(result.hasEmbeddings).toBe(true);

    const stored = await openStoredVectorIndex(dbPath(), 'functions');
    expect(stored.kind).toBe('qdrant');
    const rows = await stored.backend.loadAll();
    const ids = rows.map(row => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('src/user.ts::User');
  });

  it('updateFiles() publishes a changed file whose signatures repeat one name', async () => {
    const svc = embedder();
    await VectorIndex.build(outputDir, [node('src/other.ts', 'other')], [], new Set(), new Set(), svc);

    const result = await VectorIndex.updateFiles(
      outputDir, [node('src/user.ts', 'createUser')], new Set(['src/user.ts']),
      [extractSignatures('src/user.ts', USER_SOURCE)], new Set(), new Set(), svc,
    );
    expect(result.hasEmbeddings).toBe(true);

    const stored = await openStoredVectorIndex(dbPath(), 'functions');
    expect(stored.kind).toBe('qdrant');
    const ids = (await stored.backend.loadAll()).map(row => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(['src/other.ts::other', 'src/user.ts::createUser', 'src/user.ts::User']));
  });

  it('publishVectorIndex() counts and digests the same unique set it stores', async () => {
    const records: VectorRecord[] = [
      { id: 'a', text: 'first a', vector: [1, 0, 0, 0] },
      { id: 'b', text: 'b', vector: [0, 1, 0, 0] },
      { id: 'a', text: 'second a', vector: [0, 0, 1, 0] },
    ];
    await publishVectorIndex(dbPath(), 'functions', records, 'embed-model', null);

    const stored = await openStoredVectorIndex(dbPath(), 'functions');
    const rows = await stored.backend.loadAll();
    expect(rows.map(row => row.id).sort()).toEqual(['a', 'b']);
    // The later record wins, as a Qdrant upsert of the same point would.
    expect(rows.find(row => row.id === 'a')?.text).toBe('second a');
  });
});
