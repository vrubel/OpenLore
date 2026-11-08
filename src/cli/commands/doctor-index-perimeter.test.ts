/**
 * `doctor --index-only` and the MCP server judge the saved index through the same
 * perimeter (PDLC-2785, D15).
 *
 * PDLC asks `doctor --index-only --json` (cwd = the directory it will serve, no
 * `--root`) whether search works, then starts `openlore mcp` in the same cwd with
 * `--root`/`--write-root`. The MCP server canonicalizes every index path against its
 * roots; doctor did not declare a perimeter at all. In the "commit message" phase
 * `<worktree>/.openlore` is a symlink to the workspace's `.openlore`, outside the
 * server's roots: doctor reported "keyword search", and every MCP search was refused.
 *
 * Both processes are the real CLI, started as PDLC starts them.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
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

let scratch: string | undefined;
let client: Client | undefined;
afterEach(async () => {
  if (client) { await client.close().catch(() => {}); client = undefined; }
  if (scratch) { rmSync(scratch, { recursive: true, force: true }); scratch = undefined; }
});

/** The developer's own embedder or Qdrant must not decide what the index looks like here. */
const env = (): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^(EMBED|QDRANT|OPENLORE_PINNED)/.test(key)) out[key] = value;
  }
  return out;
};

const node = (o: Partial<FunctionNode>): FunctionNode => ({
  id: 'x', name: 'x', filePath: 'src/x.ts', language: 'TypeScript',
  isAsync: false, startIndex: 0, endIndex: 0, fanIn: 0, fanOut: 0, ...o,
});
const NODES: FunctionNode[] = [
  node({ id: 'src/auth.ts::authenticate', name: 'authenticate', filePath: 'src/auth.ts', fanIn: 5, fanOut: 2 }),
];
const SIGS: FileSignatureMap[] = [
  { path: 'src/auth.ts', language: 'TypeScript', entries: [
    { kind: 'function', name: 'authenticate', signature: 'async function authenticate(token: string): Promise<User>', docstring: 'Authenticate a user via JWT token' } ] },
];

/** A workspace with a published keyword index, plus the run's own empty directories. */
async function layout(): Promise<{ ws: string; draft: string; agentScratch: string }> {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'ol-doctor-perimeter-')));
  const dirs = { ws: join(scratch, 'ws'), draft: join(scratch, 'draft'), agentScratch: join(scratch, 'agent-scratch') };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  _resetVectorIndexCachesForTesting();
  const built = await VectorIndex.build(join(dirs.ws, '.openlore', 'analysis'), NODES, SIGS, new Set(), new Set(), null);
  expect(built.hasEmbeddings).toBe(false);
  return dirs;
}

/** `doctor --index-only --json` exactly as PDLC's probe runs it: served cwd, no roots. */
function doctor(cwd: string): { indexes: Record<string, { mode: string; reason: { code: string } | null }> } {
  const run = spawnSync(TSX, [CLI, 'doctor', '--index-only', '--json'], { cwd, env: env(), encoding: 'utf8', timeout: 60_000 });
  expect(run.status, `doctor завершился с кодом ${run.status}: ${run.stderr}`).toBe(0);
  return JSON.parse(run.stdout);
}

/** `openlore mcp` with the roots PDLC composes for the run: served cwd, author tree, agent scratch. */
async function mcp(cwd: string, roots: string[]): Promise<Client> {
  const c = new Client({ name: 'openlore-doctor-perimeter-test', version: '1.0.0' });
  await c.connect(new StdioClientTransport({
    command: TSX,
    args: [CLI, 'mcp', '--no-watch-auto', ...roots.flatMap(r => ['--root', r]), ...roots.flatMap(r => ['--write-root', r])],
    cwd, env: env(), stderr: 'ignore',
  }));
  return c;
}

const searchCode = async (c: Client, directory: string): Promise<{ isError?: boolean; text: string }> => {
  const res = await c.callTool({ name: 'search_code', arguments: { directory, query: 'authenticate' } }) as
    { isError?: boolean; content?: Array<{ type: string; text?: string }> };
  return { isError: res.isError, text: (res.content ?? []).map(x => x.text ?? '').join('\n') };
};

describe('doctor --index-only и MCP: один периметр для одного вызова', () => {
  it('.openlore — символическая ссылка вне корней: MCP отказывает, doctor не обещает поиск', async () => {
    const { ws, draft, agentScratch } = await layout();
    const wt = join(scratch!, 'wt');
    mkdirSync(wt);
    symlinkSync(join(ws, '.openlore'), join(wt, '.openlore'), 'dir');

    client = await mcp(wt, [wt, draft, agentScratch]);
    const served = await searchCode(client, wt);
    expect(served.isError, 'MCP обязан отказать: индекс за пределами корней').toBe(true);
    expect(served.text).toMatch(/Root allowlist/);

    const report = doctor(wt);
    expect(report.indexes.functions.mode, 'doctor обещал поиск, которого MCP не даст').toBe('unavailable');
  }, 120_000);

  it('собственный .openlore внутри корней: и MCP, и doctor видят текстовый поиск', async () => {
    const { ws, draft, agentScratch } = await layout();

    client = await mcp(ws, [ws, draft, agentScratch]);
    const served = await searchCode(client, ws);
    expect(served.isError, served.text).toBeFalsy();
    expect(served.text).toMatch(/authenticate/);

    const report = doctor(ws);
    expect(report.indexes.functions).toMatchObject({ mode: 'text', reason: null });
  }, 120_000);
});
