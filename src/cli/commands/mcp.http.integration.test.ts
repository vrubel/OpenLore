/**
 * Интеграционный тест Streamable-HTTP-транспорта MCP-сервера openlore (`openlore mcp --http`).
 *
 * Стратегия: поднимаем РЕАЛЬНЫЙ HTTP MCP-сервер на эфемерном порту и подключаемся к нему НАСТОЯЩИМ
 * MCP-клиентом из @modelcontextprotocol/sdk (StreamableHTTPClientTransport) — тем же, что использует qwen
 * под капотом. Это доказывает работу транспорта end-to-end (initialize-хендшейк, session-id, tools/list,
 * Bearer-auth) без запуска агента/LLM.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

  // ── Дефолт записи: свой репозиторий, НИКОГДА не соседи ──────────────────────
  //
  // Требование владельца (PDLC-110): «пишущие инструменты по чужому `directory`
  // закрываются НЕЗАВИСИМО от allowlist: даже разрешённый на ЧТЕНИЕ репозиторий не
  // может быть изменён из прогона по другому репозиторию». Типовой запуск
  // federation-стадии — `--root <свой> --root <сосед>`; если бы запись по умолчанию
  // равнялась корням чтения, сосед стал бы записываемым молча, и периметр держался бы
  // на том, что вызывающий не забыл `--write-root`. Это и есть замок на то решение.
  it('--root СВОЙ --root СОСЕД без --write-root: писать можно только в свой, в соседа — отказ', async () => {
    const home = mk('d-home');
    const neighbour = mk('d-nb');
    const prevCwd = process.cwd();
    try {
      process.chdir(home);                       // как в проде: cwd = каталог своего репозитория
      handle = await startHttpMcpServer({
        http: true, port: '0', watchAuto: false, root: [home, neighbour],
      });

      // сосед ЧИТАЕТСЯ (ради него его и объявили)…
      const read = await callTool(handle.port, 'federation_status', { directory: neighbour });
      expect(read.isError).toBeFalsy();

      // …но НЕ пишется, хотя --write-root не передавали вовсе
      const write = await callTool(handle.port, 'record_decision', {
        directory: neighbour, title: 'x', rationale: 'y',
      });
      expect(write.isError).toBe(true);
      expect(write.text).toMatch(/readable but not writable/);
      expect(existsSync(join(neighbour, '.openlore')), 'запись просочилась в соседа').toBe(false);

      // а свой репозиторий записываем — иначе периметр был бы просто выключен
      const own = await callTool(handle.port, 'record_decision', {
        directory: home, title: 'x', rationale: 'y',
      });
      expect(own.text).not.toMatch(/Root allowlist/);
    } finally {
      process.chdir(prevCwd);
      rmSync(home, { recursive: true, force: true });
      rmSync(neighbour, { recursive: true, force: true });
    }
  });

  it('cwd вне всех корней чтения: запись пуста, чтение работает, пишущий инструмент отбивается', async () => {
    const served = mk('r-served');
    const elsewhere = mk('r-elsewhere');
    const prevCwd = process.cwd();
    try {
      process.chdir(elsewhere);                  // сервер поднят «не из» обслуживаемого репозитория
      // Это ЗАКОННАЯ конфигурация (read-only сервер), а не ошибка запуска.
      handle = await startHttpMcpServer({ http: true, port: '0', watchAuto: false, root: [served] });

      const read = await callTool(handle.port, 'federation_status', { directory: served });
      expect(read.isError).toBeFalsy();

      const write = await callTool(handle.port, 'record_decision', {
        directory: served, title: 'x', rationale: 'y',
      });
      expect(write.isError).toBe(true);
      expect(write.text).toMatch(/readable but not writable/);
      expect(write.text).toMatch(/Writable roots: \(none\)/);
      expect(existsSync(join(served, '.openlore')), 'read-only сервер что-то записал').toBe(false);
    } finally {
      process.chdir(prevCwd);
      rmSync(served, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  // panic-response ПИШЕТ <dir>/.openlore/panic-state.json (+ .lock, .tmp), и запускает
  // его ЧИТАЮЩИЙ инструмент — режим на транспорте берётся из имени инструмента, так что
  // гейт записи об этом не спрашивали. Хуже: включается он конфигом ЦЕЛЕВОГО каталога,
  // то есть решение о записи принимает сосед.
  it('panic-state не пишется в корень, разрешённый только на чтение, даже если его конфиг это просит', async () => {
    const home = mk('p-home');
    const readOnly = mk('p-ro');
    const prevCwd = process.cwd();
    try {
      mkdirSync(join(readOnly, '.openlore'), { recursive: true });
      writeFileSync(
        join(readOnly, '.openlore', 'config.json'),
        JSON.stringify({ projectType: 'typescript', openspecPath: 'openspec', panicResponse: { mode: 'warn' } }),
        'utf-8',
      );
      process.chdir(home);
      handle = await startHttpMcpServer({
        http: true, port: '0', watchAuto: false, root: [home, readOnly],
      });
      const res = await callTool(handle.port, 'federation_status', { directory: readOnly });
      expect(res.isError).toBeFalsy();                      // читать — можно
      expect(existsSync(join(readOnly, '.openlore', 'panic-state.json')),
        'panic-state записан в корень только для чтения').toBe(false);
      expect(existsSync(join(readOnly, '.openlore', 'panic-state.json.lock'))).toBe(false);
    } finally {
      process.chdir(prevCwd);
      rmSync(home, { recursive: true, force: true });
      rmSync(readOnly, { recursive: true, force: true });
    }
  });

  it('--daemon при периметре — громкий отказ запуска (демон без периметра и без токена)', async () => {
    const home = mk('dm');
    try {
      await expect(startHttpMcpServer({
        http: true, port: '0', watchAuto: false, root: [home], daemon: true,
      })).rejects.toThrow(/--daemon/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // M8: проверка --watch живёт в applyRootAllowlist, то есть ДО listen(). Позже
  // добавился второй отказ в maybeStartWatcher (F6) — он ловит тот же случай, но
  // уже ПОСЛЕ того, как порт открыт. Тест, смотревший только «упало ли», перестал
  // различать эти два слоя и зеленел со снятой стартовой проверкой. Различаем по
  // тексту: стартовый отказ говорит про «корни чтения», поздний — про «пишет индекс».
  it('--watch отбивается СТАРТОВОЙ проверкой (до listen), а не поздней', async () => {
    const served = mk('w8-served');
    const watched = mk('w8-watched');
    try {
      await expect(startHttpMcpServer({
        http: true, port: '0', watchAuto: false, root: [served], watch: watched,
      })).rejects.toThrow(/обязан лежать внутри корней чтения/);
    } finally {
      rmSync(served, { recursive: true, force: true });
      rmSync(watched, { recursive: true, force: true });
    }
  });

  it('--watch вне явных корней чтения — громкий отказ запуска (вотчер пишет туда индекс)', async () => {
    const served = mk('w-served');
    const watched = mk('w-watched');
    try {
      await expect(startHttpMcpServer({
        http: true, port: '0', watchAuto: false, root: [served], watch: watched,
      })).rejects.toThrow(/--watch/);
    } finally {
      rmSync(served, { recursive: true, force: true });
      rmSync(watched, { recursive: true, force: true });
    }
  });

  // Долг, который я сам назвал в прошлом круге: возврат делегирования демону не
  // ловился НИЧЕМ — ни гейтом, ни тестом. `openlore serve` не знает про allowlist,
  // поднимается без токена, а находят его через <repo>/.openlore/serve.json — файл
  // внутри разрешённого корня, то есть адрес выбирает агент. Проверяем наблюдаемо:
  // подсовываем валидный дескриптор, указывающий на НАШ сервер-ловушку, и требуем,
  // чтобы к нему не ушло ни одного запроса.
  it('делегирование чужому serve-демону не происходит: дескриптор в корне игнорируется', async () => {
    const home = mk('dlg');
    const hits: string[] = [];
    const trap = createServer((req, res) => {
      hits.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, version: '2.1.3', root: home }));
    });
    await new Promise<void>(r => trap.listen(0, '127.0.0.1', () => r()));
    const trapPort = (trap.address() as { port: number }).port;
    try {
      mkdirSync(join(home, '.openlore'), { recursive: true });
      writeFileSync(
        join(home, '.openlore', 'serve.json'),
        JSON.stringify({
          port: trapPort, pid: process.pid, host: '127.0.0.1',
          startedAt: new Date().toISOString(), version: '2.1.3',
        }),
        'utf-8',
      );
      handle = await startHttpMcpServer({ http: true, port: '0', watchAuto: false, root: [home] });
      await callTool(handle.port, 'federation_status', { directory: home });
      expect(hits, `сервер сходил к демону из serve.json: ${hits.join(', ')}`).toEqual([]);
    } finally {
      await new Promise<void>(r => trap.close(() => r()));
      rmSync(home, { recursive: true, force: true });
    }
  });

  // Отказ, поднятый ГЛУБОКО в хендлере (write-target), возвращается его обычным
  // значением {error} — и без пометки уходит клиенту как УСПЕШНЫЙ вызов с полем
  // error. Клиент MCP решает «упало или нет» по isError; агент, которому сказали
  // «успех», понял, что граница — это особенность данных, а не граница. Дверные
  // отказы помечались правильно, глубокие — нет.
  // Раскладка ЧТЕНИЕ-ДА / ЗАПИСЬ-НЕТ, и это принципиально. Если `.openlore` ведёт
  // наружу совсем, отказ прилетает раньше — на чтении config.json — и транспорт
  // помечает его isError своим общим catch'ем. Тест тогда зеленеет и со снятой
  // пометкой: он проверяет чужой слой. Здесь чтения проходят до конца, отказ
  // рождается ГЛУБОКО и возвращается значением {error}, а не броском — то есть
  // ровно тот случай, ради которого пометка и добавлена.
  it('глубокий отказ приходит агенту как isError, а не как успешный вызов с полем error', async () => {
    const home = mk('deep-home');
    const ws = mk('deep-ws');
    const prevCwd = process.cwd();
    try {
      mkdirSync(join(ws, '.openlore'), { recursive: true });
      symlinkSync(join(ws, '.openlore'), join(home, '.openlore'));
      process.chdir(home);
      handle = await startHttpMcpServer({
        http: true, port: '0', watchAuto: false, root: [home, ws], writeRoot: [home],
      });
      const res = await callTool(handle.port, 'record_decision', {
        directory: home, title: 'T', rationale: 'R',
      });
      expect(res.isError, 'граница пришла агенту как успешный вызов с полем error').toBe(true);
      expect(res.text).toMatch(/Root allowlist/);
      // И это НЕ общий catch транспорта: тот оформляет бросок как «Tool error [CODE]».
      expect(res.text, 'отказ пришёл броском, а не значением — тест смотрит не на тот слой')
        .not.toMatch(/^Tool error \[/);
      expect(readdirSync(join(ws, '.openlore'), { recursive: true, encoding: 'utf-8' }),
        'запись просочилась в корень только для чтения').toEqual([]);
    } finally {
      process.chdir(prevCwd);
      rmSync(home, { recursive: true, force: true });
      rmSync(ws, { recursive: true, force: true });
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
