/**
 * Интеграционный тест Streamable-HTTP-транспорта MCP-сервера openlore (`openlore mcp --http`).
 *
 * Стратегия: поднимаем РЕАЛЬНЫЙ HTTP MCP-сервер на эфемерном порту и подключаемся к нему НАСТОЯЩИМ
 * MCP-клиентом из @modelcontextprotocol/sdk (StreamableHTTPClientTransport) — тем же, что использует qwen
 * под капотом. Это доказывает работу транспорта end-to-end (initialize-хендшейк, session-id, tools/list,
 * Bearer-auth) без запуска агента/LLM.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { startHttpMcpServer, type HttpMcpHandle } from './mcp.js';
import { _resetRootAllowlistForTesting } from '../../core/services/mcp-handlers/root-allowlist.js';

let handle: HttpMcpHandle | undefined;

afterEach(async () => {
  if (handle) { await handle.close(); handle = undefined; }
  _resetRootAllowlistForTesting();
});

const connect = async (port: number, headers?: Record<string, string>): Promise<Client> => {
  const client = new Client({ name: 'openlore-http-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    headers ? { requestInit: { headers } } : undefined,
  );
  await client.connect(transport);   // выполняет initialize-хендшейк
  return client;
};

describe('openlore mcp --http (Streamable HTTP transport)', () => {
  it('поднимается на эфемерном порту и отдаёт openlore-инструменты реальному MCP-клиенту', async () => {
    handle = await startHttpMcpServer({ http: true, host: '127.0.0.1', port: '0', watchAuto: false });
    expect(handle.port).toBeGreaterThan(0);

    const client = await connect(handle.port);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      // канонические core-инструменты openlore доступны по сети
      expect(names).toContain('orient');
      expect(names).toContain('search_code');
      expect(names.length).toBeGreaterThan(10);
    } finally {
      await client.close();
    }
  });

  it('--minimal отдаёт только core-набор и по HTTP', async () => {
    handle = await startHttpMcpServer({ http: true, port: '0', minimal: true, watchAuto: false });
    const client = await connect(handle.port);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(
        ['check_spec_drift', 'detect_changes', 'get_health_map', 'orient', 'record_decision', 'search_code'].sort(),
      );
    } finally {
      await client.close();
    }
  });

  it('Bearer-токен обязателен, когда задан: без него — отказ, с ним — работает', async () => {
    const TOKEN = 'tok-openlore-secret-1234567890';
    handle = await startHttpMcpServer({ http: true, port: '0', token: TOKEN, watchAuto: false });

    // без Authorization → сервер отвергает (initialize не проходит)
    await expect(connect(handle.port)).rejects.toThrow();

    // с верным Bearer → подключение и tools/list работают
    const client = await connect(handle.port, { authorization: `Bearer ${TOKEN}` });
    try {
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });

  it('fail-loud: --host не-loopback без --token → отказ запуска (не открываем анализ в сеть)', async () => {
    await expect(
      startHttpMcpServer({ http: true, host: '0.0.0.0', port: '0', watchAuto: false }),
    ).rejects.toThrow(/token/i);
    // с токеном не-loopback допускается
    handle = await startHttpMcpServer({ http: true, host: '0.0.0.0', port: '0', token: 'x'.repeat(24), watchAuto: false });
    expect(handle.port).toBeGreaterThan(0);
  });

  it('две сессии изолированы (каждая получает свой Mcp-Session-Id)', async () => {
    handle = await startHttpMcpServer({ http: true, port: '0', watchAuto: false });
    const a = await connect(handle.port);
    const b = await connect(handle.port);
    try {
      // обе сессии независимо отвечают на tools/list
      expect((await a.listTools()).tools.length).toBeGreaterThan(0);
      expect((await b.listTools()).tools.length).toBeGreaterThan(0);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('кривой ввод не валит сервер: битый JSON → 400, неизвестная сессия → 404', async () => {
    handle = await startHttpMcpServer({ http: true, port: '0', watchAuto: false });
    const url = `http://127.0.0.1:${handle.port}/mcp`;
    const hdr = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

    // битый JSON → 400 (parse error), сервер жив
    const bad = await fetch(url, { method: 'POST', headers: hdr, body: '{не-json' });
    expect(bad.status).toBe(400);

    // POST с неизвестным mcp-session-id → 404
    const unknown = await fetch(url, {
      method: 'POST',
      headers: { ...hdr, 'mcp-session-id': 'no-such-session' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(unknown.status).toBe(404);

    // сервер по-прежнему обслуживает корректного клиента
    const client = await connect(handle.port);
    try { expect((await client.listTools()).tools.length).toBeGreaterThan(0); }
    finally { await client.close(); }
  });

  it('SSE-heartbeat: молчащий GET-стрим шлёт keepalive-пинги (не даёт undici-клиенту рвать idle-SSE)', async () => {
    // малый интервал вместо дефолтных 25с — чтобы тест был быстрым
    handle = await startHttpMcpServer({ http: true, port: '0', watchAuto: false, sseKeepAliveMs: 60 });
    const url = `http://127.0.0.1:${handle.port}/mcp`;

    // 1) initialize RAW (не через SDK-клиент — иначе он сам займёт единственный standalone GET) → session-id из заголовка
    const init = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'hb-test', version: '1.0.0' } },
      }),
    });
    const sid = init.headers.get('mcp-session-id');
    if (!sid) throw new Error('initialize не вернул mcp-session-id');
    await init.body?.cancel();   // не течь телом initialize

    // 2) открываем standalone GET-SSE и слушаем несколько интервалов — должен прийти комментарий-пинг «: keepalive»
    const ac = new AbortController();
    const stop = setTimeout(() => ac.abort(), 1000);
    let seen = '';
    try {
      const get = await fetch(url, { headers: { 'mcp-session-id': sid, accept: 'text/event-stream' }, signal: ac.signal });
      expect(get.headers.get('content-type')).toMatch(/text\/event-stream/);
      if (!get.body) throw new Error('нет тела SSE-ответа');
      const reader = get.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        seen += decoder.decode(value, { stream: true });
        if (seen.includes(': keepalive')) break;
      }
    } catch (e) {
      if (!ac.signal.aborted) throw e;   // abort по таймауту — ожидаемо; прочее — реальная ошибка
    } finally {
      clearTimeout(stop);
      ac.abort();
    }
    expect(seen).toContain(': keepalive');
  });
});

// ── Корневой allowlist на ТРАНСПОРТЕ ──────────────────────────────────────────
//
// Отдельно от юнита на хендлере — и это не дублирование. `directory` из запроса
// трогает диск ДО того, как до него доберётся validateDirectory: телеметрия
// (mkdir + append в <dir>/.openlore/telemetry), резолв serve-демона (чтение
// <dir>/.openlore/serve.json и делегирование чужому процессу), panic-state,
// спавн git с cwd=<dir>. Юнит на хендлере ничего из этого не видит.
describe('openlore mcp --http: корневой allowlist на транспорте', () => {
  const mk = (tag: string): string => realpathSync(mkdtempSync(join(tmpdir(), `ol-http-perim-${tag}-`)));
  const telemetryDir = (d: string): string => join(d, '.openlore', 'telemetry');

  const callTool = async (
    port: number, name: string, args: Record<string, unknown>,
  ): Promise<{ isError?: boolean; text: string }> => {
    const client = await connect(port);
    try {
      const res = await client.callTool({ name, arguments: args }) as
        { isError?: boolean; content?: Array<{ type: string; text?: string }> };
      return { isError: res.isError, text: (res.content ?? []).map(c => c.text ?? '').join('\n') };
    } finally {
      await client.close();
    }
  };

  it('вызов на чужой каталог отбивается, и телеметрия туда НЕ пишется', async () => {
    const home = mk('home');
    const neighbour = mk('nb');
    const prevTelemetry = process.env['OPENLORE_TELEMETRY'];
    process.env['OPENLORE_TELEMETRY'] = '1';   // ровно так поднимает openlore PDLC
    try {
      handle = await startHttpMcpServer({
        http: true, port: '0', watchAuto: false, root: [home], writeRoot: [home],
      });

      // Аргументы намеренно КРИВЫЕ: без периметра запрос дошёл бы до ветки
      // INVALID_ARGS, которая пишет телеметрию по сырому args.directory.
      const denied = await callTool(handle.port, 'get_function_skeleton', {
        directory: neighbour, functionName: 42,
      });
      expect(denied.isError).toBe(true);
      expect(denied.text).toMatch(/Root allowlist/);
      expect(denied.text).toMatch(/deliberate boundary/i);
      expect(existsSync(join(neighbour, '.openlore')), 'телеметрия ушла за периметр').toBe(false);

      // Позитивный контроль: внутри периметра тот же вызов телеметрию пишет —
      // значит гейт не «выключил всё», а именно ограничил.
      await expect(callTool(handle.port, 'get_function_skeleton', {
        directory: home, functionName: 42,
      })).rejects.toThrow();                       // кривые args → JSON-RPC -32602
      expect(existsSync(join(telemetryDir(home), 'mcp.jsonl'))).toBe(true);
    } finally {
      if (prevTelemetry === undefined) delete process.env['OPENLORE_TELEMETRY'];
      else process.env['OPENLORE_TELEMETRY'] = prevTelemetry;
      rmSync(home, { recursive: true, force: true });
      rmSync(neighbour, { recursive: true, force: true });
    }
  });

  it('пишущий инструмент отбивается на корне, разрешённом только на чтение', async () => {
    const home = mk('w-home');
    const readOnly = mk('w-ro');
    try {
      handle = await startHttpMcpServer({
        http: true, port: '0', watchAuto: false, root: [home, readOnly], writeRoot: [home],
      });
      const res = await callTool(handle.port, 'record_decision', {
        directory: readOnly, title: 'x', rationale: 'y',
      });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/readable but not writable/);
      expect(existsSync(join(readOnly, '.openlore')), 'запись ушла в read-only корень').toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(readOnly, { recursive: true, force: true });
    }
  });

  it('несуществующий корень — громкий отказ ЗАПУСКА, а не сюрприз на первом вызове', async () => {
    await expect(startHttpMcpServer({
      http: true, port: '0', watchAuto: false, root: ['/definitely/not/here/openlore'],
    })).rejects.toThrow(/не существует/);
  });

  it('корень записи вне корней чтения — громкий отказ запуска', async () => {
    const home = mk('s-home');
    const outside = mk('s-out');
    try {
      await expect(startHttpMcpServer({
        http: true, port: '0', watchAuto: false, root: [home], writeRoot: [outside],
      })).rejects.toThrow(/подмножеством корней чтения/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
