/**
 * Поддельный Qdrant для юнит-тестов хранилища векторов (без сети).
 *
 * Отвечает на те запросы, которые делает QdrantBackend, настоящими объектами
 * `Response`: ограниченный читатель тела (`probeBody`) читает поток, а не
 * подставной объект. Точки хранятся по id; повтор id перезаписывает точку,
 * как в настоящем Qdrant. Подключение в тесте:
 *
 *   const qdrant = new FakeQdrant();
 *   vi.stubEnv('QDRANT_URL', qdrant.url);
 *   vi.stubGlobal('fetch', qdrant.fetch);
 *
 * `intercept` подменяет ответ на отдельный запрос (сбой Qdrant); его второй
 * аргумент `answer()` сначала выполняет запрос как обычно — так моделируется
 * сервер, который сделал работу, но ответ клиенту потерян. `fallback` —
 * обработчик запросов не к Qdrant (например, к поддельному embedder).
 *
 * Имя `*.test.helper.ts`: vitest не берёт его как тест (маска `*.test.ts`), а
 * исключение `*.test.*` для dist в поле `files` package.json не кладёт его в
 * пакет, как и прочие собранные тесты.
 */

export interface FakePoint {
  id: string | number;
  vector: number[];
  payload: Record<string, unknown>;
}

export interface FakeCollection {
  size: number;
  distance: string;
  points: Map<string, FakePoint>;
}

/** Поля тел запросов QdrantBackend, которые разбирает подделка. */
export interface FakeBody {
  vectors?: { size: number; distance: string };
  points?: FakePoint[];
  vector?: number[];
  limit?: number;
  offset?: string | number | null;
  with_payload?: boolean | string[];
  with_vector?: boolean;
  exact?: boolean;
}

export interface FakeCall {
  method: string;
  /** Путь после `/collections/<имя>`: '', '/points', '/points/count', … */
  suffix: string;
  collection: string;
  body: FakeBody;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ok = (result: unknown): Response => json(200, { status: 'ok', result, time: 0 });
const missing = (): Response => json(404, { status: { error: 'Not found: collection does not exist' }, time: 0 });

function pick(payload: Record<string, unknown>, fields: unknown): Record<string, unknown> | undefined {
  if (fields === true) return { ...payload };
  if (Array.isArray(fields)) return Object.fromEntries(fields.filter(f => f in payload).map(f => [f, payload[f]]));
  return undefined;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / ((Math.sqrt(na) || 1) * (Math.sqrt(nb) || 1));
}

export class FakeQdrant {
  readonly collections = new Map<string, FakeCollection>();
  readonly calls: FakeCall[] = [];
  intercept?: (call: FakeCall, answer: () => Response) => Response | undefined;
  fallback?: (url: URL, init: RequestInit) => Promise<Response>;

  constructor(readonly url = 'http://qdrant.test') {}

  /** Готовая коллекция (например, legacy-коллекция ru18), минуя запросы. */
  seed(name: string, size: number, points: FakePoint[]): FakeCollection {
    const collection: FakeCollection = { size, distance: 'Cosine', points: new Map() };
    for (const point of points) collection.points.set(String(point.id), point);
    this.collections.set(name, collection);
    return collection;
  }

  callsTo(method: string, suffix: string): FakeCall[] {
    return this.calls.filter(call => call.method === method && call.suffix === suffix);
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    if (url.origin !== new URL(this.url).origin) {
      if (this.fallback) return this.fallback(url, init);
      throw new TypeError('fetch failed: no fake service for ' + url.origin);
    }
    const match = /^\/collections\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (!match) return json(404, { status: { error: 'unknown path' } });
    const call: FakeCall = {
      method: (init.method ?? 'GET').toUpperCase(),
      collection: decodeURIComponent(match[1]),
      suffix: match[2] ?? '',
      body: typeof init.body === 'string' ? JSON.parse(init.body) as FakeBody : {},
    };
    this.calls.push(call);
    const intercepted = this.intercept?.(call, () => this.answer(call));
    if (intercepted) return intercepted;
    return this.answer(call);
  };

  private answer({ method, collection: name, suffix, body }: FakeCall): Response {
    const collection = this.collections.get(name);
    const route = method + ' ' + suffix;
    if (route === 'PUT ') {
      if (collection) return json(409, { status: { error: 'Collection `' + name + '` already exists!' } });
      this.collections.set(name, { size: body.vectors!.size, distance: body.vectors!.distance, points: new Map() });
      return ok(true);
    }
    if (route === 'DELETE ') return ok(this.collections.delete(name));
    if (!collection) return missing();
    const sorted = () => [...collection.points.values()].sort((a, b) => String(a.id) < String(b.id) ? -1 : 1);
    switch (route) {
      case 'GET ':
        return ok({
          status: 'green', points_count: collection.points.size,
          config: { params: { vectors: { size: collection.size, distance: collection.distance } } },
        });
      case 'PUT /points':
        for (const point of body.points ?? []) {
          if (point.vector.length !== collection.size) return json(400, { status: { error: 'Wrong input: vector dimension error' } });
          collection.points.set(String(point.id), point);
        }
        return ok({ operation_id: this.calls.length, status: 'completed' });
      case 'POST /points/count':
        return ok({ count: collection.points.size });
      case 'POST /points/scroll': {
        const points = sorted();
        const limit = body.limit ?? 10;
        const start = Math.max(body.offset == null ? 0 : points.findIndex(point => String(point.id) === String(body.offset)), 0);
        const page = points.slice(start, start + limit);
        const next = points[start + limit];
        return ok({
          points: page.map(point => ({
            id: point.id,
            ...(body.with_payload ? { payload: pick(point.payload, body.with_payload) } : {}),
            ...(body.with_vector ? { vector: point.vector } : {}),
          })),
          next_page_offset: next ? next.id : null,
        });
      }
      case 'POST /points/search':
        return ok(sorted()
          .map(point => ({ id: point.id, score: cosine(point.vector, body.vector ?? []), payload: { ...point.payload } }))
          .sort((a, b) => b.score - a.score)
          .slice(0, body.limit ?? 10));
      default:
        return json(404, { status: { error: 'unsupported fake route ' + route } });
    }
  }
}
