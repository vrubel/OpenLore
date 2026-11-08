/**
 * D2 (PDLC-2785): `openlore reindex` on a semantic index it cannot update
 * incrementally (ru18: no publication generation) exits non-zero with the
 * recovery command, leaves the index as it was and does not advance its marker
 * — Maestro then runs the full `analyze --embed --force`. Graph and signatures
 * of the delta are still applied. Control: an index with a generation of the
 * same model is updated semantically and the command exits 0.
 *
 * Real git repo, real EdgeStore and vector store, a real EmbeddingService from
 * the environment against a stubbed `/embeddings` endpoint.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EdgeStore } from '../../core/services/edge-store.js';
import { VectorIndex, _resetVectorIndexCachesForTesting } from '../../core/analyzer/vector-index.js';
import { openStoredVectorIndex } from '../../core/analyzer/vector-store.js';
import type { FunctionNode } from '../../core/analyzer/call-graph.js';
import type { EmbeddingService } from '../../core/analyzer/embedding-service.js';
import { reindexCommand } from './reindex.js';

const DIM = 4;
const vector = (text: string) => [text.length % 5 + 1, 1, 2, 3];

let root: string;
let analysisDir: string;
const vectorDir = () => join(analysisDir, 'vector-index');
const git = (args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf-8' }).trim();

async function seedAnalysis(): Promise<string> {
  await writeFile(join(root, 'a.ts'), 'export function foo() { return 1; }\n', 'utf-8');
  git(['add', '-A']);
  git(['commit', '-m', 'init']);
  await writeFile(join(analysisDir, 'llm-context.json'), JSON.stringify({
    signatures: [{ path: 'a.ts', language: 'TypeScript', entries: [{ kind: 'function', name: 'foo', signature: 'export function foo()' }] }],
    callGraph: null,
  }), 'utf-8');
  EdgeStore.open(EdgeStore.dbPath(analysisDir)).close();
  return git(['rev-parse', 'HEAD']);
}

async function commitChange(): Promise<void> {
  await writeFile(join(root, 'a.ts'), 'export function foo() { return 1; }\nexport function baz() { return foo(); }\n', 'utf-8');
  git(['add', 'a.ts']);
  git(['commit', '-m', 'add baz']);
}

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
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array): boolean => { err.push(String(c)); return true; });
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((): boolean => true);
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.join(' ')); });
  try {
    process.chdir(root);
    process.exitCode = 0;
    await reindexCommand.parseAsync(args, { from: 'user' });
    return { exitCode: Number(process.exitCode ?? 0), stderr: err.join('') };
  } finally {
    errSpy.mockRestore(); outSpy.mockRestore(); logSpy.mockRestore(); errorSpy.mockRestore();
    process.chdir(prevCwd);
    process.exitCode = prevExit;
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ol-reindex-vec-'));
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
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (String(url) !== 'http://embed.test/v1/embeddings') throw new TypeError('fetch failed');
    const { input } = JSON.parse(String(init.body)) as { input: string[] };
    return new Response(JSON.stringify({ data: input.map((text, index) => ({ index, embedding: vector(text) })) }));
  }));
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

describe('D2: reindex on an index it cannot update semantically', () => {
  it('ru18 semantic index: exit 1 with the recovery command, index and marker untouched, signatures applied', async () => {
    const base = await seedAnalysis();
    await writeFile(join(vectorDir(), 'functions.records.json'), JSON.stringify({
      id: 'a.ts::foo', name: 'foo', filePath: 'a.ts', className: '', language: 'TypeScript', signature: 'export function foo()',
      docstring: '', fanIn: 0, fanOut: 0, isHub: false, isEntryPoint: false, text: 'foo', vector: [1, 0, 0, 0],
    }) + '\n');
    await writeFile(join(analysisDir, 'vector-index-meta.json'), JSON.stringify({ hasEmbeddings: true, dim: DIM, model: 'embed-model', builtAt: 'x', schemaVersion: 1 }));
    await commitChange();
    const before = await folder();

    const { exitCode, stderr } = await runReindex(['--since', base]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/openlore analyze --embed --force/);
    expect(stderr).toContain('[mcp-watcher] vector index not updated:');
    expect(await folder()).toEqual(before);
    expect((await openStoredVectorIndex(vectorDir(), 'functions')).identity).toMatchObject({ generation: null, dim: DIM });
    expect(existsSync(join(analysisDir, 'reindex-state.json'))).toBe(false);
    const context = JSON.parse(await readFile(join(analysisDir, 'llm-context.json'), 'utf8'));
    expect(context.signatures.find((s: { path: string }) => s.path === 'a.ts').entries.map((e: { name: string }) => e.name))
      .toEqual(expect.arrayContaining(['foo', 'baz']));
  });

  it('control: an index with a generation of the same model stays semantic and the command exits 0', async () => {
    const base = await seedAnalysis();
    const svc = { modelName: 'embed-model', embed: vi.fn(async (texts: string[]) => texts.map(vector)) } as unknown as EmbeddingService;
    const foo = {
      id: 'a.ts::foo', name: 'foo', filePath: 'a.ts', language: 'TypeScript', isAsync: false,
      signature: 'export function foo()', docstring: '', fanIn: 0, fanOut: 0, startIndex: 0, endIndex: 0,
    } as FunctionNode;
    await VectorIndex.build(analysisDir, [foo], [], new Set(), new Set(), svc);
    await commitChange();

    const { exitCode } = await runReindex(['--since', base]);

    expect(exitCode).toBe(0);
    const stored = await openStoredVectorIndex(vectorDir(), 'functions');
    expect(stored.identity).toMatchObject({ dim: DIM, model: 'embed-model' });
    const rows = await stored.backend.loadAll();
    expect(rows.map(row => row.id)).toEqual(expect.arrayContaining(['a.ts::foo', 'a.ts::baz']));
    expect(rows.every(row => (row.vector as number[]).length === DIM)).toBe(true);
    expect(existsSync(join(analysisDir, 'reindex-state.json'))).toBe(true);
  });
});

describe('D2: reindex refuses up front when the semantic index cannot be kept current', () => {
  const RECOVERY = /openlore analyze --embed --force/;
  const marker = () => existsSync(join(analysisDir, 'reindex-state.json'));

  async function ru18Index(): Promise<void> {
    await writeFile(join(vectorDir(), 'functions.records.json'), JSON.stringify({
      id: 'a.ts::foo', name: 'foo', filePath: 'a.ts', className: '', language: 'TypeScript', signature: 'export function foo()',
      docstring: '', fanIn: 0, fanOut: 0, isHub: false, isEntryPoint: false, text: 'foo', vector: [1, 0, 0, 0],
    }) + '\n');
    await writeFile(join(analysisDir, 'vector-index-meta.json'), JSON.stringify({ hasEmbeddings: true, dim: DIM, model: 'embed-model', builtAt: 'x', schemaVersion: 1 }));
  }

  async function generationIndex(modelName: string): Promise<void> {
    const svc = { modelName, embed: vi.fn(async (texts: string[]) => texts.map(vector)) } as unknown as EmbeddingService;
    const foo = {
      id: 'a.ts::foo', name: 'foo', filePath: 'a.ts', language: 'TypeScript', isAsync: false,
      signature: 'export function foo()', docstring: '', fanIn: 0, fanOut: 0, startIndex: 0, endIndex: 0,
    } as FunctionNode;
    await VectorIndex.build(analysisDir, [foo], [], new Set(), new Set(), svc);
  }

  it('ru18 semantic index, empty delta: exit 1 with the recovery command, marker and index untouched', async () => {
    const base = await seedAnalysis();
    await ru18Index();
    const before = await folder();

    const { exitCode, stderr } = await runReindex(['--since', base]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(RECOVERY);
    expect(marker()).toBe(false);
    expect(await folder()).toEqual(before);
  });

  it('ru18 semantic index: a repeated reindex after the refusal still fails', async () => {
    const base = await seedAnalysis();
    await ru18Index();
    await commitChange();

    expect((await runReindex(['--since', base])).exitCode).not.toBe(0);
    const again = await runReindex(['--since', base]);

    expect(again.exitCode).not.toBe(0);
    expect(again.stderr).toMatch(RECOVERY);
    expect(marker()).toBe(false);
  });

  it('index with a generation, a different configured model, empty delta: exit 1', async () => {
    const base = await seedAnalysis();
    await generationIndex('model-a');
    vi.stubEnv('EMBED_MODEL', 'model-b');

    const { exitCode, stderr } = await runReindex(['--since', base]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(RECOVERY);
    expect(marker()).toBe(false);
  });

  it('index with a generation and vectors, no embedder configured, empty delta: exit 1', async () => {
    const base = await seedAnalysis();
    await generationIndex('embed-model');
    vi.stubEnv('EMBED_BASE_URL', undefined);
    vi.stubEnv('EMBED_MODEL', undefined);

    const { exitCode, stderr } = await runReindex(['--since', base]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(RECOVERY);
    expect(marker()).toBe(false);
  });

  it('control: an index with a generation of the same model, empty delta: exit 0 and the marker advances', async () => {
    const base = await seedAnalysis();
    await generationIndex('embed-model');

    const { exitCode } = await runReindex(['--since', base]);

    expect(exitCode).toBe(0);
    expect(marker()).toBe(true);
  });
});
