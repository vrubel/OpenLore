/**
 * VectorStore backend — хранилище векторного индекса за единым интерфейсом (D7 ось B, PDLC §12).
 *   QDRANT_URL задан           → Qdrant: коллекция openlore_<table>_<hash(dbPath)>, точки {id,vector,payload}.
 *   нет QDRANT_URL, есть lancedb→ LanceDB (папка <dbPath>/, таблица tableName) — ANN, как раньше (dev/integration).
 *   нет ни того, ни другого    → File: <dbPath>/<table>.records.json — слим-дистрибутив без 129-МБ напи и без
 *                                Qdrant. BM25 (loadAll) работает «из коробки»; dense — brute-force cosine.
 *
 * @lancedb/lancedb теперь optionalDependencies: дистрибутив PDLC (single-installer) собирается `--omit=optional`
 * и нативный 129-МБ napi-бинарь LanceDB в поставку НЕ входит (он один форсил per-OS-разбиение артефакта).
 * РАНЬШЕ его отсутствие без QDRANT_URL = fail-loud (orient/BM25 падал «задайте QDRANT_URL» даже без --embed,
 * т.к. _bm25Only зовёт backend.loadAll()). Теперь при отсутствии lancedb выбирается FileBackend — навигация
 * (orient/search_code) работает на standalone БЕЗ Qdrant и БЕЗ 129-МБ нативки; семантика большого масштаба —
 * внешний Qdrant (QDRANT_URL). Где lancedb установлен (dev/integration) — LanceBackend остаётся ANN, как раньше.
 *
 * Контракт наружу один (VectorIndex/SpecVectorIndex используют его, не зная бэкенд): build (overwrite), loadAll
 * (все строки id+payload+vector — для BM25-корпуса и инкрементального кэша), searchDense (ANN best-first c _distance),
 * exists. BM25/RRF-слой остаётся бэкенд-агностичным (работает над строками).
 *
 * exists() ОСТАЁТСЯ синхронным (не рябит async на вызывающих): в Qdrant-режиме build пишет локальный маркер
 * <dbPath>/.qdrant — existsSync(dbPath) истинно для обоих бэкендов; данные при этом в Qdrant.
 * fail-loud: Qdrant не-2xx → throw (НЕ молчаливый пустой результат).
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync, createReadStream, createWriteStream, renameSync, openSync, readSync, closeSync } from 'node:fs';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

export interface VectorRecord extends Record<string, unknown> {
  id: string;
  text: string;
  vector: number[];
}

export interface VectorBackend {
  /** Полная перезапись хранилища (overwrite). */
  build(records: VectorRecord[]): Promise<void>;
  /** Все строки (id + поля payload + vector как number[]) — для BM25-корпуса и инкрементального кэша. */
  loadAll(): Promise<Record<string, unknown>[]>;
  /** Dense ANN: best-first, каждая строка несёт `_distance` (меньше = ближе). */
  searchDense(queryVector: number[], limit: number): Promise<Record<string, unknown>[]>;
  /** Построен ли индекс. Синхронно (маркер-папка). */
  exists(): boolean;
}

const qdrantUrl = (): string | null => (process.env.QDRANT_URL ? process.env.QDRANT_URL.replace(/\/+$/, '') : null);

/**
 * Можно ли РЕАЛЬНО использовать LanceBackend (синхронно, без загрузки нативки).
 * Резолвим И @lancedb/lancedb, И его peerDependency apache-arrow: openlore объявляет lancedb лишь как
 * optionalDependency, а apache-arrow (peer @lancedb, >=15 <=18.1) штатный npm-install НЕ тянет → `import
 * ('@lancedb/lancedb')` падает 'Cannot find module apache-arrow' даже когда сам @lancedb на месте. Поэтому
 * LanceBackend выбираем ТОЛЬКО когда резолвится весь стек; иначе → FileBackend (BM25 без нативки и без arrow).
 */
function hasLancedb(): boolean {
  try {
    const req = createRequire(import.meta.url);
    req.resolve('@lancedb/lancedb');
    req.resolve('apache-arrow');
    return true;
  } catch {
    return false;
  }
}

/**
 * Выбор бэкенда (чистая функция — без env/fs, тестируется напрямую):
 *   QDRANT_URL          → 'qdrant'
 *   иначе есть lancedb  → 'lance'
 *   иначе               → 'file' (слим-standalone: BM25 без Qdrant и без 129-МБ напи)
 */
export function selectBackendKind(opts: { qdrantUrl: string | null; hasLancedb: boolean }): 'qdrant' | 'lance' | 'file' {
  if (opts.qdrantUrl) return 'qdrant';
  return opts.hasLancedb ? 'lance' : 'file';
}

/** Выбор бэкенда по окружению (Qdrant → LanceDB → File). */
export function openVectorBackend(dbPath: string, tableName: string): VectorBackend {
  const url = qdrantUrl();
  switch (selectBackendKind({ qdrantUrl: url, hasLancedb: hasLancedb() })) {
    case 'qdrant': return new QdrantBackend(url as string, dbPath, tableName);
    case 'lance':  return new LanceBackend(dbPath, tableName);
    default:       return new FileBackend(dbPath, tableName);
  }
}

// ── LanceDB (standalone, поведение прежнее) ───────────────────────────────────────────────────────
// @lancedb/lancedb — НЕ обязательная зависимость (optionalDependencies): дистрибутив PDLC собирается с
// `--omit=optional` и НЕ несёт 129-МБ нативный napi-бинарь (он один форсил per-OS-разбиение артефакта).
// Семантический индекс в поставке идёт через внешний Qdrant (QDRANT_URL). LanceBackend остаётся рабочим
// там, где lancedb установлен (dev/integration без Qdrant); если пакета нет — fail-loud с понятной причиной,
// а НЕ тихий BM25-fallback (принцип «без fallback'ов»). Импорт ленивый: на --no-embed-пути не вызывается.
class LanceBackend implements VectorBackend {
  constructor(private dbPath: string, private tableName: string) {}

  /** Ленивая загрузка опционального lancedb. Нет пакета → громкая ошибка с указанием задать QDRANT_URL. */
  private async lance(): Promise<typeof import('@lancedb/lancedb')> {
    try {
      return await import('@lancedb/lancedb');
    } catch {
      throw new Error(
        'Семантический индекс запрошен, но локальный LanceDB (@lancedb/lancedb) не установлен. ' +
        'Сборка PDLC идёт без него (single-installer, без 129-МБ нативного бинаря) — задайте QDRANT_URL ' +
        '(внешний Qdrant) для семантического поиска, либо запускайте analyze без --embed (только BM25).',
      );
    }
  }

  async build(records: VectorRecord[]): Promise<void> {
    const { connect } = await this.lance();
    const db = await connect(this.dbPath);
    // LanceDB не может вывести схему из пустого набора → createTable([]) бросает.
    // Пустой build = «индекс есть, строк нет» (напр. text-line по репозиторию без
    // индексируемых строк): сносим устаревшую таблицу, папка <dbPath> остаётся
    // (connect её создал) → folder-based exists() истинно, search вернёт пусто.
    if (records.length === 0) {
      try { await db.dropTable(this.tableName); } catch { /* таблицы не было */ }
      return;
    }
    await db.createTable(this.tableName, records as unknown as Record<string, unknown>[], { mode: 'overwrite' });
  }

  async loadAll(): Promise<Record<string, unknown>[]> {
    const { connect } = await this.lance();
    const db = await connect(this.dbPath);
    const table = await db.openTable(this.tableName);
    const rows = await table.query().toArray();
    for (const r of rows) if (r.vector) r.vector = Array.from(r.vector as ArrayLike<number>);
    return rows;
  }

  async searchDense(queryVector: number[], limit: number): Promise<Record<string, unknown>[]> {
    const { connect } = await this.lance();
    const db = await connect(this.dbPath);
    const table = await db.openTable(this.tableName);
    return table.query().nearestTo(queryVector).limit(limit).toArray();
  }

  // table-specific: LanceDB createTable создаёт <dbPath>/<table>.lance (для specs совпадает с прежним check)
  exists(): boolean { return existsSync(join(this.dbPath, `${this.tableName}.lance`)); }
}

// ── File (lancedb-free standalone: BM25 без Qdrant и без 129-МБ напи) ───────────────────────────────
// Выбирается, когда нет ни QDRANT_URL, ни установленного @lancedb (слим single-installer). Записи индекса
// (id+payload+vector) храним в локальном JSON-файле <dbPath>/<table>.records.json. BM25-путь orient/search
// (без --embed) читает корпус через loadAll() — нативный lancedb НЕ нужен. Dense (если задан embed-сервис)
// — точный brute-force по косинусу над загруженными векторами (без ANN; приемлемо для типового репозитория;
// для большого масштаба — внешний Qdrant). exists() синхронный — наличие файла записей.
// Экспортируется для прямого юнит-теста (в dev-окружении форка @lancedb установлен → авто-выбор даёт Lance).
export class FileBackend implements VectorBackend {
  private file: string;
  constructor(private dbPath: string, private tableName: string) {
    this.file = join(dbPath, `${tableName}.records.json`);
  }

  /**
   * NDJSON: одна запись — одна строка, дописываемая потоком.
   *
   * Раньше корпус сериализовался единым `JSON.stringify(records)`, и это упиралось
   * в предел строки V8 РАНЬШЕ всех остальных артефактов: на строчном текстовом
   * индексе — примерно с 12 600 файлов (замер: 42 529 символов на файл), на
   * векторном с эмбеддингами — уже с 2–3 тысяч (один 768-мерный вектор весит
   * 16 185 символов JSON). Хуже того, переполнение ГЛОТАЛОСЬ вызывающим:
   * `analyze` завершался успешно, индекса не было, а `orient`/`search_code`
   * молча отдавали пустоту. Построчная запись убирает потолок совсем — ни на
   * одном шаге не собирается строка длиннее одной записи.
   */
  async build(records: VectorRecord[]): Promise<void> {
    mkdirSync(this.dbPath, { recursive: true });   // папка vector-index/ → VectorIndex.exists() (проверка папки) истинно
    // tmp + rename: читатель никогда не видит наполовину переписанный корпус.
    const tmp = `${this.file}.${process.pid}.tmp`;
    const out = createWriteStream(tmp, { encoding: 'utf8' });
    for (const r of records) {
      if (!out.write(`${JSON.stringify(r)}\n`)) await once(out, 'drain');
    }
    out.end();
    await once(out, 'finish');
    renameSync(tmp, this.file);
  }

  async loadAll(): Promise<Record<string, unknown>[]> {
    if (!existsSync(this.file)) return [];
    const rows: Record<string, unknown>[] = [];
    // Формат распознаём по первому байту. '[' — корпус, записанный ДО перехода на
    // NDJSON; такой файл по построению помещался в одну строку (иначе его не
    // удалось бы записать), поэтому читать его целиком безопасно. Иначе — NDJSON
    // построчно: целиком его читать нельзя, readFile('utf8') на корпусе больше
    // предела строки бросил бы ERR_STRING_TOO_LONG и обнулил бы смысл правки.
    const fd = openSync(this.file, 'r');
    const head = Buffer.alloc(1);
    const got = readSync(fd, head, 0, 1, 0);
    closeSync(fd);

    if (got === 1 && head.toString('utf8') === '[') {
      rows.push(...(JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, unknown>[]));
    } else if (got === 1) {
      const rl = createInterface({ input: createReadStream(this.file, 'utf8'), crlfDelay: Infinity });
      for await (const line of rl) {
        if (line.length > 0) rows.push(JSON.parse(line) as Record<string, unknown>);
      }
    }
    for (const r of rows) if (r.vector) r.vector = Array.from(r.vector as ArrayLike<number>);
    return rows;
  }

  async searchDense(queryVector: number[], limit: number): Promise<Record<string, unknown>[]> {
    const rows = await this.loadAll();
    const qn = Math.sqrt(queryVector.reduce((s, v) => s + v * v, 0)) || 1;
    // _distance = 1 − cosine (меньше = ближе, как у Lance/Qdrant); записи без вектора уходят в конец.
    const scored = rows.map((r) => {
      const v = (r.vector as number[]) || [];
      if (v.length === 0) return { r, _distance: 2 };
      let dot = 0, vv = 0;
      const n = Math.min(v.length, queryVector.length);
      for (let i = 0; i < n; i++) { dot += v[i] * queryVector[i]; vv += v[i] * v[i]; }
      const cos = dot / ((Math.sqrt(vv) || 1) * qn);
      return { r, _distance: 1 - cos };
    });
    scored.sort((a, b) => a._distance - b._distance);
    return scored.slice(0, limit).map(({ r, _distance }) => ({ ...r, _distance }));
  }

  exists(): boolean { return existsSync(this.file); }
}

// ── Qdrant (distributed) ──────────────────────────────────────────────────────────────────────────
class QdrantBackend implements VectorBackend {
  private coll: string;
  private marker: string;
  constructor(private url: string, private dbPath: string, private tableName: string) {
    const h = createHash('sha1').update(dbPath).digest('hex').slice(0, 12);
    this.coll = `openlore_${tableName}_${h}`;
    this.marker = join(dbPath, `.qdrant-${tableName}`);   // table-specific маркер для синхронного exists()
  }

  private hdr(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (process.env.QDRANT_API_KEY) h['api-key'] = process.env.QDRANT_API_KEY;
    return h;
  }
  private async req(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const r = await fetch(`${this.url}${path}`, { method, headers: this.hdr(), body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  }
  /** Qdrant требует uint64/UUID id точки — детерминированный UUID из строкового id (оригинал — в payload). */
  private static pid(s: string): string {
    const h = createHash('sha1').update(s).digest('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
  }

  async build(records: VectorRecord[]): Promise<void> {
    const dim = records[0]?.vector?.length;
    if (!dim) throw new Error('VectorStore(Qdrant): пустой/безразмерный вектор — нечего индексировать');
    await this.req('DELETE', `/collections/${this.coll}`);   // overwrite: снести старую (404 ок)
    const c = await this.req('PUT', `/collections/${this.coll}`, { vectors: { size: dim, distance: 'Cosine' } });
    if (c.status < 200 || c.status >= 300) throw new Error(`VectorStore(Qdrant): создание коллекции ${this.coll} → HTTP ${c.status}`);
    for (let i = 0; i < records.length; i += 256) {
      const batch = records.slice(i, i + 256).map((r) => {
        const { vector, ...payload } = r;   // payload = всё кроме вектора (включая оригинальный id/text)
        return { id: QdrantBackend.pid(r.id), vector, payload };
      });
      const up = await this.req('PUT', `/collections/${this.coll}/points?wait=true`, { points: batch });
      if (up.status < 200 || up.status >= 300) throw new Error(`VectorStore(Qdrant): upsert → HTTP ${up.status}: ${JSON.stringify(up.json).slice(0, 200)}`);
    }
    // локальный table-specific маркер — чтобы синхронный exists() работал для обоих бэкендов (данные в Qdrant)
    try { mkdirSync(this.dbPath, { recursive: true }); writeFileSync(this.marker, this.coll + '\n'); } catch { /* маркер best-effort */ }
  }

  async loadAll(): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    let offset: unknown = undefined;
    for (;;) {
      const r = await this.req('POST', `/collections/${this.coll}/points/scroll`, { limit: 512, with_payload: true, with_vector: true, ...(offset != null ? { offset } : {}) });
      if (r.status < 200 || r.status >= 300) throw new Error(`VectorStore(Qdrant): scroll → HTTP ${r.status}`);
      const pts = r.json?.result?.points ?? [];
      for (const p of pts) out.push({ ...(p.payload || {}), vector: p.vector });
      offset = r.json?.result?.next_page_offset;
      if (offset == null || pts.length === 0) break;
    }
    return out;
  }

  async searchDense(queryVector: number[], limit: number): Promise<Record<string, unknown>[]> {
    const r = await this.req('POST', `/collections/${this.coll}/points/search`, { vector: queryVector, limit, with_payload: true });
    if (r.status < 200 || r.status >= 300) throw new Error(`VectorStore(Qdrant): search → HTTP ${r.status}`);
    // Qdrant Cosine score: больше = ближе. VectorIndex dense-only трактует _distance как «меньше = ближе» →
    // отдаём _distance = 1 - score (гибрид по умолчанию использует лишь ПОРЯДОК, он best-first и так).
    return (r.json?.result ?? []).map((p: any) => ({ ...(p.payload || {}), _distance: 1 - (p.score ?? 0) }));
  }

  exists(): boolean { return existsSync(this.marker); }
}
