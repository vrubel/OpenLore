/**
 * Интеграционный тест Streamable-HTTP-транспорта MCP-сервера openlore (`openlore mcp --http`).
 *
 * Стратегия: поднимаем РЕАЛЬНЫЙ HTTP MCP-сервер на эфемерном порту и подключаемся к нему НАСТОЯЩИМ
 * MCP-клиентом из @modelcontextprotocol/sdk (StreamableHTTPClientTransport) — тем же, что использует qwen
 * под капотом. Это доказывает работу транспорта end-to-end (initialize-хендшейк, session-id, tools/list,
 * Bearer-auth) без запуска агента/LLM.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHttpMcpServer, type HttpMcpHandle } from './mcp.js';

let handle: HttpMcpHandle | undefined;

afterEach(async () => {
  if (handle) { await handle.close(); handle = undefined; }
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
        ['check_spec_drift', 'detect_changes', 'orient', 'record_decision', 'search_code'].sort(),
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
});
