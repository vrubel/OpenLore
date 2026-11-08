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
import { mkdtempSync, mkdirSync, rmSync, realpathSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { VectorIndex, _resetVectorIndexCachesForTesting } from '../../core/analyzer/vector-index.js';
import { SpecVectorIndex } from '../../core/analyzer/spec-vector-index.js';
import { addRepo } from '../../core/federation/registry.js';
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

/** The response body the agent receives: the content item that is the JSON result. */
const callJson = async (c: Client, name: string, args: Record<string, unknown>): Promise<unknown> => {
  const res = await c.callTool({ name, arguments: args }) as { content?: Array<{ type: string; text?: string }> };
  for (const item of res.content ?? []) {
    try { return JSON.parse(item.text ?? ''); } catch { /* a freshness or panic signal, not the result */ }
  }
  throw new Error(`${name}: в ответе нет JSON-результата`);
};

const MISSING = 'No saved search index for this table. Run OpenLore analysis to build it.';

/**
 * A home with a spec-store binding to one target, `api`, that is indexed for the
 * registry but has no published search table, plus a story in it. Calls of the three
 * tools that search through orient, with the directory each one writes telemetry to.
 */
function consumersFixture(): { root: string; api: string; home: string; store: string; calls: Array<[string, string, Record<string, unknown>]> } {
  const root = mk('consumers');
  const api = join(root, 'api');
  const home = join(root, 'home');
  const store = join(root, 'plans');
  mkdirSync(join(api, '.openlore', 'analysis'), { recursive: true });
  writeFileSync(join(api, '.openlore', 'analysis', 'fingerprint.json'), JSON.stringify({ hash: 'h' }));
  mkdirSync(join(api, 'stories'), { recursive: true });
  writeFileSync(join(api, 'stories', 'US-1.md'), '# US-1\n\n## Tasks\n\n- [ ] do it\n');
  mkdirSync(join(home, '.openlore'), { recursive: true });
  writeFileSync(join(home, '.openlore', 'config.json'), JSON.stringify({
    version: '1.0.0', projectType: 'library', openspecPath: 'openspec',
    analysis: { maxFiles: 1000, includePatterns: [], excludePatterns: [] },
    generation: { model: 'x', domains: 'auto' },
    createdAt: new Date().toISOString(), lastRun: null,
    specStore: { name: 'plans', path: store, targets: ['api'] },
  }));
  addRepo(home, api, { name: 'api' });
  mkdirSync(join(store, 'openspec', 'changes', 'feat-x'), { recursive: true });
  writeFileSync(join(store, 'openspec', 'changes', 'feat-x', 'proposal.md'), '# Feat X\n\n## Why\n\nReason for X.');
  return {
    root, api, home, store,
    calls: [
      ['generate_change_proposal', api, { description: 'Add payment retry', slug: 'add-payment-retry' }],
      ['annotate_story', api, { storyFilePath: 'stories/US-1.md', description: 'Add payment retry' }],
      ['working_set_context', home, { change: 'feat-x' }],
    ],
  };
}

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

  // Суд по openlore#15, находка 3: единый поиск отбрасывал недоступную полосу, если
  // ответила другая, и строка совпадала со здоровым текстовым поиском.
  it('search_unified: недоступная полоса кода при ответившей полосе спецификаций различима', async () => {
    const repo = mk('partial');
    mkdirSync(join(repo, 'openspec', 'specs', 'auth'), { recursive: true });
    writeFileSync(join(repo, 'openspec', 'specs', 'auth', 'spec.md'),
      '# Auth\n\n## Purpose\n\nAuthenticate users.\n\n## Requirements\n\n### Requirement: Login\n\n' +
      'The system SHALL authenticate a user by token.\n');
    const built = await SpecVectorIndex.build(join(repo, '.openlore', 'analysis'), join(repo, 'openspec', 'specs'), null);
    expect(built.recordCount).toBeGreaterThan(0);          // полоса спецификаций есть, полосы кода нет
    client = await connect(repo);

    expect((await call(client, 'search_unified', { directory: repo, query: 'authenticate' })).isError).toBeFalsy();
    const line = telemetry(repo, 'mcp').find(r => r.event === 'tool_call' && r.tool === 'search_unified');
    expect(line).toMatchObject({ outcome: 'partial', index_mode: 'unavailable', index_reason: 'missing-index' });
  }, 120_000);

  // Суд по openlore#15, находка 4: инструменты, которые зовут orient внутри себя,
  // писали outcome 'ok' без полей индекса, когда поиск по коду был недоступен.
  it('инструменты поверх orient: недоступный индекс кода — тот же исход и поля, что у orient', async () => {
    const { root, calls } = consumersFixture();
    client = await connect(root);                           // периметр по умолчанию — весь root
    for (const [tool, directory, args] of calls) {
      const res = await call(client, tool, { directory, ...args });
      expect(res.isError, `${tool}: ${res.text}`).toBeFalsy();
      expect(res.text, `${tool}: агент видит недоступность`).toMatch(/No saved search index/);
      const line = telemetry(directory, 'mcp').find(r => r.event === 'tool_call' && r.tool === tool);
      expect(line, `${tool}: строка tool_call`).toMatchObject({
        outcome: 'unavailable', index_mode: 'unavailable', index_reason: 'missing-index',
      });
    }
  }, 120_000);

  // Правка D11 — только телеметрия: ответ этих инструментов — вход модели в живых
  // прогонах, и он обязан остаться байт-в-байт таким, как на 7c17278. Ожидаемое ниже
  // снято с 7c17278 для этого же состояния; новых полей (indexes, targets[].index) нет.
  it('инструменты поверх orient: ответ агенту прежний, состояние индекса в него не попадает', async () => {
    const { root, api, store, calls } = consumersFixture();
    client = await connect(root);
    const responses: Record<string, unknown> = {};
    for (const [tool, directory, args] of calls) responses[tool] = await callJson(client, tool, { directory, ...args });

    expect(responses.generate_change_proposal).toEqual({
      slug: 'add-payment-retry',
      proposalPath: join('openspec', 'changes', 'add-payment-retry', 'proposal.md'),
      domainsAffected: [], functionsFound: 0, requirementsTouched: 0, maxRiskScore: null, riskLevel: 'unknown',
      nextStep: 'Review and complete openspec/changes/add-payment-retry/proposal.md, then run: openspec specs add-payment-retry',
      orientErrors: [MISSING], specSearchErrors: [MISSING],
    });
    expect(responses.annotate_story).toEqual({
      storyFile: 'stories/US-1.md', domainsAffected: [], functionsFound: 0, maxRiskScore: null,
      riskLevel: 'unknown', blocked: false, orientErrors: [MISSING],
    });
    const ws = responses.working_set_context as Record<string, unknown>;
    expect(Object.keys(ws).sort()).toEqual(['bound', 'change', 'findings', 'items', 'ready', 'store', 'summary', 'targets']);
    expect(ws.store).toEqual({ name: 'plans', path: store });
    expect(ws.targets).toEqual([{
      target: 'api', briefed: false, reason: MISSING, insertionPoints: [], specDomains: [], anchoredIntent: [],
    }]);
    expect(ws.findings).toEqual([
      { code: 'orient-unavailable', severity: 'warn', subject: 'api',
        message: `Target "api" could not be oriented: ${MISSING}`,
        remediation: `Re-run \`openlore analyze\` in ${api}, then re-brief.` },
      { code: 'no-briefable-targets', severity: 'error', subject: 'plans',
        message: 'No declared target resolved to an indexed local checkout, so no context could be assembled.',
        remediation: 'Register and `openlore analyze` at least one declared target (see `openlore spec-store status`).' },
    ]);
  }, 120_000);
});
