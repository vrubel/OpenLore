/**
 * The root perimeter over the STDIO transport — the one openlore actually ships.
 *
 * Why this file exists: every other perimeter test reaches the server through
 * `startHttpMcpServer` or calls `configureRootAllowlist` directly, so deleting the
 * single `applyRootAllowlist(options)` line in `startStdioMcpServer` left the whole
 * suite green. stdio is the default transport — an editor integration, and every
 * `openlore mcp` with no flags, runs through it. A lock that cannot see the main
 * road is not a lock.
 *
 * It spawns the real CLI (via tsx) and speaks MCP to it over pipes with the same
 * SDK client an agent uses. Lives in the unit suite deliberately: the integration
 * suite is not part of CI, and this is exactly the case CI must not lose.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, realpathSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const TSX = join(REPO, 'node_modules', '.bin', 'tsx');
const CLI = join(REPO, 'src', 'cli', 'index.ts');

const dirs: string[] = [];
const mk = (tag: string): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `ol-stdio-${tag}-`)));
  dirs.push(d);
  return d;
};

let client: Client | undefined;
afterEach(async () => {
  if (client) { await client.close().catch(() => {}); client = undefined; }
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** Start `openlore mcp` over stdio with NO flags beyond those given — in
 * particular WITHOUT `--no-watch-auto`, i.e. exactly how it runs in the field. */
const connectRaw = async (args: string[], cwd: string): Promise<{ client: Client; stderr: () => string }> => {
  const c = new Client({ name: 'openlore-stdio-test', version: '1.0.0' });
  const t = new StdioClientTransport({
    command: TSX,
    args: [CLI, 'mcp', ...args],
    cwd,
    env: { ...process.env, OPENLORE_TELEMETRY: '1' } as Record<string, string>,
    stderr: 'pipe',
  });
  await c.connect(t);
  let buf = '';
  t.stderr?.on('data', (d: Buffer) => { buf += d.toString(); });
  return { client: c, stderr: () => buf };
};

/** Start `openlore mcp` over stdio with the given extra args and cwd. */
const connect = async (args: string[], cwd: string): Promise<Client> => {
  const c = new Client({ name: 'openlore-stdio-test', version: '1.0.0' });
  await c.connect(new StdioClientTransport({
    command: TSX,
    args: [CLI, 'mcp', '--no-watch-auto', ...args],
    cwd,
    env: { ...process.env, OPENLORE_TELEMETRY: '1' } as Record<string, string>,
    stderr: 'ignore',
  }));
  return c;
};

const call = async (c: Client, name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; text: string }> => {
  const res = await c.callTool({ name, arguments: args }) as
    { isError?: boolean; content?: Array<{ type: string; text?: string }> };
  return { isError: res.isError, text: (res.content ?? []).map(x => x.text ?? '').join('\n') };
};

describe('openlore mcp (stdio): корневой периметр', () => {
  it('дефолтный периметр = cwd: чужой каталог отбивается, свой обслуживается', async () => {
    const home = mk('home');
    const neighbour = mk('nb');
    client = await connect([], home);          // ни одного флага — как запускают редакторы

    const denied = await call(client, 'federation_status', { directory: neighbour });
    expect(denied.isError, 'stdio-сервер обслужил чужой каталог').toBe(true);
    expect(denied.text).toMatch(/Root allowlist/);
    expect(existsSync(join(neighbour, '.openlore')), 'телеметрия ушла за периметр').toBe(false);

    const ok = await call(client, 'federation_status', { directory: home });
    expect(ok.isError).toBeFalsy();
  }, 120_000);

  // Прошлый круг: оба stdio-теста запускали сервер с `--no-watch-auto`, то есть
  // замок сознательно смотрел мимо самой опасной части. `--watch-auto` включён ПО
  // УМОЛЧАНИЮ и усыновляет каталог из ПЕРВОГО вызова, поднимая на нём вотчер,
  // который ПИШЕТ индекс. Баннер печатал «запись НИКУДА», а один read-вызов по
  // соседу делал его записываемым. Здесь сервер запускается ровно так, как его
  // запускают реально: без единого флага, кроме корней.
  it('ДЕФОЛТНАЯ конфигурация: --watch-auto не усыновляет каталог из вызова агента', async () => {
    const home = mk('wa-home');
    const neighbour = mk('wa-nb');
    // У соседа УЖЕ есть индекс — иначе вотчеру нечего переписывать и тест зелен
    // по случайности, а не по существу.
    const analysis = join(neighbour, '.openlore', 'analysis');
    mkdirSync(analysis, { recursive: true });
    const ctxFile = join(analysis, 'llm-context.json');
    writeFileSync(ctxFile, JSON.stringify({ signatures: [] }), 'utf-8');
    const src = join(neighbour, 'a.ts');
    writeFileSync(src, 'export const a = 1;\n', 'utf-8');
    const before = statSync(ctxFile).mtimeMs;

    // Обоим корням дано ЧТЕНИЕ; запись по дефолту достаётся только cwd (= home).
    const conn = await connectRaw(['--root', home, '--root', neighbour], home);
    client = conn.client;

    const res = await call(client, 'federation_status', { directory: neighbour });
    expect(res.isError, 'сосед должен читаться').toBeFalsy();

    // (1) Прямой наблюдаемый признак гейта: сервер СКАЗАЛ, что погасил усыновление.
    expect(conn.stderr(), 'нет следа того, что watch-auto погашен периметром')
      .toMatch(/--watch-auto выключен периметром/);

    // (2) И поведение: правим файл у соседа — вотчер, если он усыновлён, перепишет
    //     его индекс. Дебаунс по умолчанию 400мс, ждём с запасом.
    writeFileSync(src, 'export const a = 2;\n', 'utf-8');
    await new Promise(r => setTimeout(r, 2500));
    expect(statSync(ctxFile).mtimeMs, 'индекс соседа переписан усыновлённым вотчером').toBe(before);
  }, 120_000);

  it('--root задаёт периметр и по stdio тоже', async () => {
    const home = mk('r-home');
    const served = mk('r-served');
    const other = mk('r-other');
    client = await connect(['--root', served], home);

    expect((await call(client, 'federation_status', { directory: served })).isError).toBeFalsy();
    expect((await call(client, 'federation_status', { directory: other })).isError).toBe(true);
    // cwd вне корней чтения → сервер только на чтение: пишущий инструмент отбит.
    const write = await call(client, 'record_decision', { directory: served, title: 'x', rationale: 'y' });
    expect(write.isError).toBe(true);
    expect(write.text).toMatch(/readable but not writable/);
  }, 120_000);
});
