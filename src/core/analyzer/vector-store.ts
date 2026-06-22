/**
 * VectorStore backend — хранилище векторного индекса за единым интерфейсом (D7 ось B, PDLC §12).
 *   QDRANT_URL задан    → Qdrant: коллекция openlore_<table>_<hash(dbPath)>, точки {id,vector,payload}.
 *   QDRANT_URL не задан → LanceDB (папка <dbPath>/, таблица tableName) — ТОЛЬКО если пакет установлен.
 *
 * @lancedb/lancedb теперь optionalDependencies: дистрибутив PDLC (single-installer) собирается `--omit=optional`
 * и нативный 129-МБ napi-бинарь LanceDB в поставку НЕ входит (он один форсил per-OS-разбиение артефакта);
 * семантика в поставке = внешний Qdrant. Где lancedb установлен (dev/integration) — LanceBackend работает как
 * раньше; где нет и запрошен embed без QDRANT_URL — fail-loud (см. LanceBackend.lance), не тихий BM25.
 *
 * Контракт наружу один (VectorIndex/SpecVectorIndex используют его, не зная бэкенд): build (overwrite), loadAll
 * (все строки id+payload+vector — для BM25-корпуса и инкрементального кэша), searchDense (ANN best-first c _distance),
 * exists. BM25/RRF-слой остаётся бэкенд-агностичным (работает над строками).
 *
 * exists() ОСТАЁТСЯ синхронным (не рябит async на вызывающих): в Qdrant-режиме build пишет локальный маркер
 * <dbPath>/.qdrant — existsSync(dbPath) истинно для обоих бэкендов; данные при этом в Qdrant.
 * fail-loud: Qdrant не-2xx → throw (НЕ молчаливый пустой результат).
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

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

/** Выбор бэкенда по env. QDRANT_URL → Qdrant, иначе LanceDB. */
export function openVectorBackend(dbPath: string, tableName: string): VectorBackend {
  const url = qdrantUrl();
  return url ? new QdrantBackend(url, dbPath, tableName) : new LanceBackend(dbPath, tableName);
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
