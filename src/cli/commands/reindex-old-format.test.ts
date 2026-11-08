/**
 * D2/D3 (PDLC-2785, second court of openlore#15): an index published by
 * v2.1.3-ru19 or earlier may hold two records with one id (`export const X` +
 * `export type X`). The publisher now refuses such pairs, so an incremental
 * update that keeps them as survivors cannot be published. That must be a
 * distinguishable outcome — a refusal, the "vectors behind" marker, reindex
 * exit 1 with the recovery command, the published index untouched — and a full
 * build (what Maestro runs on exit 1) clears it. Any failed publication on the
 * incremental path is treated the same. An index without repeats updates as
 * before.
 *
 * Real git repo, EdgeStore and vector store; a real EmbeddingService from the
 * environment against a stubbed `/embeddings` endpoint; Qdrant faked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EdgeStore } from '../../core/services/edge-store.js';
import { VectorIndex, _resetVectorIndexCachesForTesting } from '../../core/analyzer/vector-index.js';
import { openStoredVectorIndex } from '../../core/analyzer/vector-store.js';
import { extractSignatures } from '../../core/analyzer/signature-extractor.js';
import { FakeQdrant } from '../../core/analyzer/__tests__/fake-qdrant.test.helper.js';
import type { FunctionNode } from '../../core/analyzer/call-graph.js';
import type { EmbeddingService } from '../../core/analyzer/embedding-service.js';
import { reindexCommand } from './reindex.js';

const DIM = 4;
const RECOVERY = /openlore analyze --embed --force/;
const A_SOURCE = 'export const User = { a: 1 } as const;\nexport type User = typeof User;\n';
const vector = (text: string) => [text.length % 5 + 1, 1, 2, 3];

let root: string;
let analysisDir: string;
const vectorDir = () => join(analysisDir, 'vector-index');
const behind = () => existsSync(join(analysisDir, 'vector-index-behind.json'));
const reindexState = () => existsSync(join(analysisDir, 'reindex-state.json'));
const git = (args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf-8' }).trim();

async function embeddings(url: URL | string, init: RequestInit): Promise<Response> {
  if (String(url) !== 'http://embed.test/v1/embeddings') throw new TypeError('fetch failed');
  const { input } = JSON.parse(String(init.body)) as { input: string[] };
  return new Response(JSON.stringify({ data: input.map((text, index) => ({ index, embedding: vector(text) })) }));
}

const node = (filePath: string, name: string) => ({
  id: `${filePath}::${name}`, name, filePath, language: 'TypeScript', isAsync: false,
  signature: `export function ${name}()`, docstring: '', fanIn: 0, fanOut: 0, startIndex: 0, endIndex: 0,
}) as FunctionNode;
const svc = () => ({ modelName: 'embed-model', embed: vi.fn(async (texts: string[]) => texts.map(vector)) }) as unknown as EmbeddingService;

/** a.ts holds `const User` + `type User`, b.ts holds foo. Returns the base commit. */
async function seed(): Promise<string> {
  await writeFile(join(root, 'a.ts'), A_SOURCE, 'utf-8');
  await writeFile(join(root, 'b.ts'), 'export function foo() { return 1; }\n', 'utf-8');
  git(['add', 'a.ts', 'b.ts']);
  git(['commit', '-q', '-m', 'init']);
  await writeFile(join(analysisDir, 'llm-context.json'), JSON.stringify({
    signatures: [extractSignatures('a.ts', A_SOURCE), extractSignatures('b.ts', 'export function foo() { return 1; }\n')],
    callGraph: null,
  }), 'utf-8');
  EdgeStore.open(EdgeStore.dbPath(analysisDir)).close();
  return git(['rev-parse', 'HEAD']);
}

async function changeB(): Promise<void> {
  await writeFile(join(root, 'b.ts'), 'export function foo() { return 1; }\nexport function baz() { return foo(); }\n', 'utf-8');
  git(['add', 'b.ts']);
  git(['commit', '-q', '-m', 'add baz']);
}

/** A File-backend generation in the v2.1.3-ru19 layout, written as that version stored it. */
async function ru19Index(rows: Record<string, unknown>[], dim: number): Promise<void> {
  const generation = randomUUID();
  const table = 'functions_' + generation.replaceAll('-', '');
  await writeFile(join(vectorDir(), table + '.records.json'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  await writeFile(join(vectorDir(), 'functions.index.json'), JSON.stringify({
    version: 1, table: 'functions', generation, backend: 'file', count: rows.length,
    source_sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
    model: dim > 0 ? 'embed-model' : null, dim, analysis_fingerprint: null,
    distance: dim > 0 ? 'Cosine' : null, embedding_input: dim > 0 ? 'text-24000-v1' : null,
  }) + '\n');
}

function row(id: string, filePath: string, name: string, text: string, dim: number): Record<string, unknown> {
  return {
    id, name, filePath, className: '', language: 'TypeScript', signature: text, docstring: '', fanIn: 0, fanOut: 0,
    isHub: false, isEntryPoint: false, text, ...(dim > 0 ? { vector: vector(text) } : {}),
  };
}

/** The ru19 rows: the const and the type of a.ts share one id. */
const ru19Rows = (dim: number, repeated = true) => [
  row('a.ts::User', 'a.ts', 'User', 'export const User = { a: 1 } as const;', dim),
  ...(repeated ? [row('a.ts::User', 'a.ts', 'User', 'export type User', dim)] : []),
  row('b.ts::foo', 'b.ts', 'foo', 'export function foo()', dim),
];

async function folder(): Promise<Record<string, string>> {
  const state: Record<string, string> = {};
  for (const name of (await readdir(vectorDir())).sort()) {
    state[name] = name.endsWith('.json') ? await readFile(join(vectorDir(), name), 'utf8') : 'dir';
  }
  return state;
}

async function runReindex(args: string[]): Promise<{ exitCode: number; stderr: string }> {
  const prevCwd = process.cwd();
  const prevExit = process.exitCode;
  const err: string[] = [];
  const spies = [
    vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array): boolean => { err.push(String(c)); return true; }),
    vi.spyOn(process.stdout, 'write').mockImplementation((): boolean => true),
    vi.spyOn(console, 'log').mockImplementation(() => {}),
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.join(' ')); }),
  ];
  try {
    process.chdir(root);
    process.exitCode = 0;
    await reindexCommand.parseAsync(args, { from: 'user' });
    return { exitCode: Number(process.exitCode ?? 0), stderr: err.join('') };
  } finally {
    for (const spy of spies) spy.mockRestore();
    process.chdir(prevCwd);
    process.exitCode = prevExit;
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ol-reindex-old-'));
  analysisDir = join(root, '.openlore', 'analysis');
  await mkdir(vectorDir(), { recursive: true });
  git(['init', '-q']);
  git(['config', 'user.email', 'a@b.c']);
  git(['config', 'user.name', 't']);
  vi.stubEnv('QDRANT_URL', undefined);
  vi.stubEnv('OPENLORE_PINNED_INDEX', undefined);
  vi.stubEnv('EMBEDDER_URL', undefined);
  vi.stubEnv('EMBED_BASE_URL', 'http://embed.test/v1');
  vi.stubEnv('EMBED_MODEL', 'embed-model');
  vi.stubGlobal('fetch', vi.fn(embeddings));
  reindexCommand.setOptionValue('embed', true);
  reindexCommand.setOptionValue('json', false);
  _resetVectorIndexCachesForTesting();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  _resetVectorIndexCachesForTesting();
  await rm(root, { recursive: true, force: true });
});

describe('D2: an ru19 index with a repeated id is refused, not silently left behind', () => {
  it('semantic ru19 index: exit 1 with the recovery command, marker written, index and reindex state untouched', async () => {
    const base = await seed();
    await ru19Index(ru19Rows(DIM), DIM);
    await changeB();
    const before = await folder();

    const { exitCode, stderr } = await runReindex(['--since', base]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(RECOVERY);
    expect(behind()).toBe(true);
    expect(reindexState()).toBe(false);
    expect(await folder()).toEqual(before);
  });

  it('keyword-only ru19 index (the fallback of a Qdrant installation): the same refusal', async () => {
    const base = await seed();
    await ru19Index(ru19Rows(0), 0);
    await changeB();
    const before = await folder();

    const { exitCode, stderr } = await runReindex(['--since', base]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(RECOVERY);
    expect(behind()).toBe(true);
    expect(reindexState()).toBe(false);
    expect(await folder()).toEqual(before);
  });

  it('a full build afterwards publishes unique ids, and the next reindex exits 0', async () => {
    const base = await seed();
    await ru19Index(ru19Rows(DIM), DIM);
    await changeB();
    expect((await runReindex(['--since', base])).exitCode).not.toBe(0);

    await VectorIndex.build(analysisDir, [node('b.ts', 'foo'), node('b.ts', 'baz')], [extractSignatures('a.ts', A_SOURCE)], new Set(), new Set(), svc());
    const ids = (await (await openStoredVectorIndex(vectorDir(), 'functions')).backend.loadAll()).map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);

    expect((await runReindex(['--since', base])).exitCode).toBe(0);
    expect(behind()).toBe(false);
    expect(reindexState()).toBe(true);
  });

  it('control: an ru19 index without repeats updates as before and exits 0', async () => {
    const base = await seed();
    await ru19Index(ru19Rows(DIM, false), DIM);
    await changeB();

    const { exitCode } = await runReindex(['--since', base]);

    expect(exitCode).toBe(0);
    expect(behind()).toBe(false);
    const ids = (await (await openStoredVectorIndex(vectorDir(), 'functions')).backend.loadAll()).map(r => r.id);
    expect(ids).toEqual(expect.arrayContaining(['a.ts::User', 'b.ts::foo', 'b.ts::baz']));
  });
});

describe('D2: a failed publication on the incremental path is a refusal, not exit 0', () => {
  it('Qdrant refuses the new generation: exit 1, marker written, the published generation stays', async () => {
    const qdrant = new FakeQdrant();
    qdrant.fallback = embeddings;
    vi.stubGlobal('fetch', qdrant.fetch);
    vi.stubEnv('QDRANT_URL', qdrant.url);
    const base = await seed();
    await VectorIndex.build(analysisDir, [node('b.ts', 'foo')], [extractSignatures('a.ts', A_SOURCE)], new Set(), new Set(), svc());
    await changeB();
    const before = await folder();
    const collections = [...qdrant.collections.keys()];
    qdrant.intercept = call => call.method === 'PUT' && call.suffix === ''
      ? new Response('{"status":{"error":"unavailable"}}', { status: 503 })
      : undefined;

    const { exitCode, stderr } = await runReindex(['--since', base]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(RECOVERY);
    expect(behind()).toBe(true);
    expect(reindexState()).toBe(false);
    expect(await folder()).toEqual(before);
    expect([...qdrant.collections.keys()]).toEqual(collections);
  });
});
