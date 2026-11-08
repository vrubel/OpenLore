/**
 * Search-index state in MCP telemetry (PDLC-2785, D11).
 *
 * A search tool whose index is unavailable answers the agent with the reason
 * (`index.mode: 'unavailable'`), yet the telemetry line said `outcome: 'ok'` and
 * orient's sizes were all zero: a successful empty call, indistinguishable from
 * "nothing matched". PDLC reads exactly these lines, so the real CLI is spawned over
 * stdio with telemetry on, as PDLC runs it, and the JSONL is read back.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, realpathSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { VectorIndex, _resetVectorIndexCachesForTesting } from '../../core/analyzer/vector-index.js';
import type { FunctionNode } from '../../core/analyzer/call-graph.js';
import type { FileSignatureMap } from '../../core/analyzer/signature-extractor.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const TSX = join(REPO, 'node_modules', '.bin', 'tsx');
const CLI = join(REPO, 'src', 'cli', 'index.ts');

const dirs: string[] = [];
const mk = (tag: string): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `ol-search-tel-${tag}-`)));
  dirs.push(d);
  return d;
};

let client: Client | undefined;
afterEach(async () => {
  if (client) { await client.close().catch(() => {}); client = undefined; }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** The developer's own embedder or Qdrant must not decide what the index looks like here. */
const serverEnv = (): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^(EMBED|QDRANT)/.test(key)) env[key] = value;
  }
  return { ...env, OPENLORE_TELEMETRY: '1' };
};

const connect = async (cwd: string): Promise<Client> => {
  const c = new Client({ name: 'openlore-search-telemetry-test', version: '1.0.0' });
  await c.connect(new StdioClientTransport({
    command: TSX, args: [CLI, 'mcp', '--no-watch-auto'], cwd, env: serverEnv(), stderr: 'ignore',
  }));
  return c;
};

const call = async (c: Client, name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; text: string }> => {
  const res = await c.callTool({ name, arguments: args }) as
    { isError?: boolean; content?: Array<{ type: string; text?: string }> };
  return { isError: res.isError, text: (res.content ?? []).map(x => x.text ?? '').join('\n') };
};

const telemetry = (dir: string, domain: string): Array<Record<string, unknown>> => {
  const file = join(dir, '.openlore', 'telemetry', `${domain}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
};

const SEARCHES: Array<[string, Record<string, unknown>]> = [
  ['orient', { task: 'authenticate a user' }],
  ['search_code', { query: 'authenticate' }],
  ['suggest_insertion_points', { description: 'authenticate a user' }],
  ['search_specs', { query: 'authenticate' }],
  ['search_unified', { query: 'authenticate' }],
];

const node = (o: Partial<FunctionNode>): FunctionNode => ({
  id: 'x', name: 'x', filePath: 'src/x.ts', language: 'TypeScript',
  isAsync: false, startIndex: 0, endIndex: 0, fanIn: 0, fanOut: 0, ...o,
});
const NODES: FunctionNode[] = [
  node({ id: 'src/auth.ts::authenticate', name: 'authenticate', filePath: 'src/auth.ts', fanIn: 5, fanOut: 2 }),
  node({ id: 'src/db.ts::connect', name: 'connect', filePath: 'src/db.ts', fanIn: 3 }),
];
const SIGS: FileSignatureMap[] = [
  { path: 'src/auth.ts', language: 'TypeScript', entries: [
    { kind: 'function', name: 'authenticate', signature: 'async function authenticate(token: string): Promise<User>', docstring: 'Authenticate a user via JWT token' } ] },
];

describe('openlore mcp: состояние поискового индекса в телеметрии', () => {
  it('недоступный индекс — отдельный исход, режим и код причины, а не успешный пустой вызов', async () => {
    const repo = mk('none');                       // ни одной опубликованной таблицы
    client = await connect(repo);
    for (const [tool, args] of SEARCHES) {
      const res = await call(client, tool, { directory: repo, ...args });
      expect(res.isError, `${tool}: ответ агенту не должен меняться`).toBeFalsy();
      expect(res.text, `${tool}: агент видит недоступность`).toMatch(/unavailable|No saved search index|No requested search index/);
    }

    const calls = telemetry(repo, 'mcp').filter(r => r.event === 'tool_call');
    for (const [tool] of SEARCHES) {
      expect(calls.find(r => r.tool === tool), `${tool}: строка tool_call`).toMatchObject({
        outcome: 'unavailable', index_mode: 'unavailable', index_reason: 'missing-index',
      });
    }
    const orient = telemetry(repo, 'orient').filter(r => r.event === 'orient_call');
    expect(orient).toHaveLength(1);
    expect(orient[0]).toMatchObject({ index_mode: 'unavailable', index_reason: 'missing-index', functions: 0 });
  }, 120_000);

  it('доступный текстовый индекс — обычный исход с режимом text и без причины', async () => {
    const repo = mk('text');
    _resetVectorIndexCachesForTesting();
    const built = await VectorIndex.build(join(repo, '.openlore', 'analysis'), NODES, SIGS, new Set(), new Set(), null);
    expect(built.hasEmbeddings).toBe(false);
    client = await connect(repo);

    expect((await call(client, 'orient', { directory: repo, task: 'authenticate a user' })).isError).toBeFalsy();
    expect((await call(client, 'search_code', { directory: repo, query: 'authenticate' })).isError).toBeFalsy();

    const calls = telemetry(repo, 'mcp').filter(r => r.event === 'tool_call');
    for (const tool of ['orient', 'search_code']) {
      expect(calls.find(r => r.tool === tool), tool).toMatchObject({ outcome: 'ok', index_mode: 'text', index_reason: null });
    }
    const orient = telemetry(repo, 'orient').filter(r => r.event === 'orient_call');
    expect(orient[0]).toMatchObject({ index_mode: 'text', index_reason: null });
    expect(orient[0].functions).toBeGreaterThan(0);
  }, 120_000);
});
