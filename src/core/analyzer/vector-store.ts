/** Persisted backend selection for reads, environment selection for publication. */
import { existsSync, mkdirSync, writeFileSync, readFileSync, createReadStream, createWriteStream, renameSync, openSync, readSync, closeSync, statSync, unlinkSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { assertPathAllowed } from '../services/mcp-handlers/root-allowlist.js';

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

export type BackendKind = ReturnType<typeof selectBackendKind>;
export type IndexTable = 'functions' | 'specs' | 'text_lines';

export interface IndexIdentity {
  table: IndexTable;
  generation: string | null;
  source_sha256: string | null;
  model: string | null;
  dim: number;
}

interface Descriptor extends IndexIdentity {
  version: 1;
  generation: string;
  source_sha256: string;
  backend: BackendKind;
  count: number;
  analysis_fingerprint: string | null;
  distance: 'Cosine' | null;
  embedding_input: 'text-24000-v1' | null;
}

export interface IndexIssue {
  code: 'missing-index' | 'legacy-remote-unpinned' | 'collection-missing' |
    'collection-binding-mismatch' | 'backend-unreachable' | 'embedding-mismatch' | 'index-invalid';
  message: string;
}

export type EmbeddingModelMatch = 'same' | 'different' | 'unknown';

/**
 * The embedding-model comparison shared by the index writer and the reader. A name
 * missing on either side is unknown (the distributed embedder carries its own
 * model, `EMBEDDER_URL` without `EMBED_MODEL`). For the reader unknown is not
 * different: the query vector's dimension is still checked. The writer is stricter
 * — see embeddingVectorsReusable().
 */
export function embeddingModelMatch(stored: string | null | undefined, configured: string | null | undefined): EmbeddingModelMatch {
  if (!stored || !configured) return 'unknown';
  return stored === configured ? 'same' : 'different';
}

/**
 * Writer rule: stored vectors may be kept and mixed with new ones only from the
 * same model, or when neither side names one (the same unnamed embedder). A name
 * on one side only proves nothing, and keeping those vectors would record them
 * under a model that did not produce them.
 */
export function embeddingVectorsReusable(stored: string | null | undefined, configured: string | null | undefined): boolean {
  return embeddingModelMatch(stored, configured) === 'same' || (!stored && !configured);
}

export class IndexUnavailable extends Error {
  constructor(readonly code: IndexIssue['code'], message: string, readonly backend: BackendKind | null = null) {
    super(message);
  }
}

/** A new search generation could not be stored; the published generation stays current. */
export class IndexPublicationError extends Error {
  constructor(cause: unknown) {
    super('Publishing the search index failed: ' + (cause instanceof Error ? cause.message : String(cause)), { cause });
  }
}

export function indexIssue(error: unknown): IndexIssue {
  return error instanceof IndexUnavailable
    ? { code: error.code, message: error.message }
    : { code: 'index-invalid', message: 'The stored search index could not be read.' };
}

export interface StoredIndex {
  backend: VectorBackend;
  kind: BackendKind;
  identity: IndexIdentity;
  cacheKey: string;
}

export interface OpenStoredOptions {
  pinned?: boolean;
  signal?: AbortSignal;
}

const SHA256 = /^[a-f0-9]{64}$/;
const GENERATION = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const descriptorPath = (db: string, table: IndexTable) => join(db, table + '.index.json');
const markerPath = (db: string, table: IndexTable) => join(db, '.qdrant-' + table);
const filePath = (db: string, table: string) => join(db, table + '.records.json');
const lancePath = (db: string, table: string) => join(db, table + '.lance');
const legacyCollection = (db: string, table: IndexTable) =>
  'openlore_' + table + '_' + createHash('sha1').update(db).digest('hex').slice(0, 12);
const localTable = (d: Descriptor) => d.table + '_' + d.generation.replaceAll('-', '');
const collection = (d: Descriptor) => 'openlore_' + localTable(d);

function readSmall(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(assertPathAllowed(path, 'read'), 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const data = Buffer.alloc(8193);
    const n = readSync(fd, data, 0, data.length, 0);
    if (n === data.length) throw new IndexUnavailable('index-invalid', 'Search index metadata exceeds its size limit.');
    return data.toString('utf8', 0, n);
  } finally {
    closeSync(fd);
  }
}

function artifactPresent(path: string): boolean {
  try {
    statSync(assertPathAllowed(path, 'read'));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function hasStoredVectorIndex(db: string, table: IndexTable): boolean {
  try {
    return [descriptorPath(db, table), filePath(db, table), lancePath(db, table), markerPath(db, table)]
      .some(artifactPresent);
  } catch {
    // Let the reader report a broken artifact instead of treating it as absent.
    return true;
  }
}

function readDescriptor(db: string, table: IndexTable): Descriptor | null {
  const raw = readSmall(descriptorPath(db, table));
  if (raw === null) return null;
  const d = JSON.parse(raw) as Descriptor;
  if (!d || d.version !== 1 || d.table !== table || !GENERATION.test(d.generation) ||
      typeof d.generation !== 'string' || typeof d.source_sha256 !== 'string' || !SHA256.test(d.source_sha256) ||
      (d.analysis_fingerprint !== null && (typeof d.analysis_fingerprint !== 'string' || !SHA256.test(d.analysis_fingerprint))) ||
      !['file', 'lance', 'qdrant'].includes(d.backend) ||
      !Number.isSafeInteger(d.count) || d.count < 0 || !Number.isSafeInteger(d.dim) || d.dim < 0 ||
      (d.model !== null && (typeof d.model !== 'string' || !d.model)) ||
      (d.dim === 0
        ? d.distance !== null || d.model !== null || d.embedding_input !== null
        : d.distance !== 'Cosine' || d.embedding_input !== 'text-24000-v1') ||
      (d.backend === 'qdrant' && (d.dim === 0 || d.count === 0))) {
    throw new IndexUnavailable('index-invalid', 'Invalid persisted search index descriptor.');
  }
  return d;
}

function readLegacyMeta(db: string, table: IndexTable): { dim: number; model: string | null } | null {
  if (table === 'text_lines') return { dim: 0, model: null };
  const raw = readSmall(join(dirname(db), table === 'functions' ? 'vector-index-meta.json' : 'spec-index-meta.json'));
  if (raw === null) return null;
  const meta = JSON.parse(raw);
  if (!meta || typeof meta.hasEmbeddings !== 'boolean' || !Number.isSafeInteger(meta.dim) ||
      (meta.hasEmbeddings ? meta.dim <= 0 : meta.dim !== 0) ||
      (meta.model !== null && typeof meta.model !== 'string')) {
    throw new IndexUnavailable('index-invalid', 'Invalid legacy search index metadata.');
  }
  return { dim: meta.dim, model: meta.hasEmbeddings ? meta.model || null : null };
}

function statKey(path: string): number[] {
  const stat = statSync(assertPathAllowed(path, 'read'));
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs];
}

function localKey(db: string, table: string, kind: 'file' | 'lance'): string {
  return JSON.stringify(statKey(kind === 'file' ? filePath(db, table) : lancePath(db, table)));
}

function localBackend(db: string, table: string, kind: 'file' | 'lance', expected?: Descriptor): FileBackend | LanceBackend {
  if (kind === 'lance' && !hasLancedb()) {
    throw new IndexUnavailable('backend-unreachable', 'This saved index requires the local LanceDB runtime.', kind);
  }
  assertPathAllowed(kind === 'file' ? filePath(db, table) : lancePath(db, table), 'read');
  return kind === 'file' ? new FileBackend(db, table, expected, true) : new LanceBackend(db, table, expected);
}

export async function openStoredVectorIndex(
  db: string, table: IndexTable, options: OpenStoredOptions = {},
): Promise<StoredIndex> {
  let kind: BackendKind | null = null;
  try {
    db = assertPathAllowed(db, 'read');
    const descriptor = readDescriptor(db, table);
    const pinned = options.pinned || process.env.OPENLORE_PINNED_INDEX === '1';
    if (descriptor) {
      kind = descriptor.backend;
      const { generation, source_sha256, model, dim } = descriptor;
      const identity = { table, generation, source_sha256, model, dim };
      if (kind === 'qdrant') {
        if (pinned && (!descriptor.analysis_fingerprint ||
            publishedAnalysisFingerprint(dirname(db)) !== descriptor.analysis_fingerprint)) {
          throw new IndexUnavailable('collection-binding-mismatch', 'The saved search generation does not match this pinned analysis.', kind);
        }
        const remote = new QdrantBackend(collection(descriptor), descriptor, options.signal);
        await remote.verify();
        return { backend: remote, kind, identity, cacheKey: remote.proof! };
      }
      const storage = localTable(descriptor);
      const local = localBackend(db, storage, kind, descriptor);
      if (!local.exists()) throw new IndexUnavailable('index-invalid', 'The published local index table is missing.', kind);
      await local.inspect(descriptor, options.signal);
      return { backend: local, kind, identity, cacheKey: generation + ':' + localKey(db, storage, kind) };
    }

    const marker = readSmall(markerPath(db, table));
    const file = artifactPresent(filePath(db, table));
    const lance = artifactPresent(lancePath(db, table));
    if (Number(file) + Number(lance) + Number(marker !== null) > 1) {
      throw new IndexUnavailable('index-invalid', 'Multiple legacy backends claim the same search table.');
    }
    if (marker !== null) {
      kind = 'qdrant';
      if (pinned) {
        throw new IndexUnavailable('legacy-remote-unpinned', 'This legacy Qdrant index has no pinned generation. Publish it with an explicit OpenLore analysis.', kind);
      }
      const name = legacyCollection(db, table);
      if (marker.trim() !== name) {
        throw new IndexUnavailable('collection-binding-mismatch', 'The legacy Qdrant marker does not belong to this repository.', kind);
      }
      const remote = new QdrantBackend(name, null, options.signal);
      const dim = await remote.verify();
      const meta = readLegacyMeta(db, table);
      if (meta && meta.dim !== dim) {
        throw new IndexUnavailable('collection-binding-mismatch', 'The legacy Qdrant vector schema differs from its index metadata.', kind);
      }
      const identity = { table, generation: null, source_sha256: null, model: meta?.model ?? null, dim };
      // No generation proves this collection unchanged. A legacy build rewrites the
      // marker when it finishes and changes the point count while it runs, so the
      // marker's stat and the reported point count are a cheap signal to reload on.
      const state = [name, statKey(markerPath(db, table)), remote.pointsCount, dim, meta];
      return { backend: remote, kind, identity, cacheKey: 'legacy:qdrant:' + JSON.stringify(state) };
    }
    if (!file && !lance) {
      throw new IndexUnavailable('missing-index', 'No saved search index for this table. Run OpenLore analysis to build it.');
    }
    kind = file ? 'file' : 'lance';
    const local = localBackend(db, table, kind);
    const meta = readLegacyMeta(db, table);
    const dim = await local.inspect(meta, options.signal);
    const identity = { table, generation: null, source_sha256: null, model: meta?.model ?? null, dim };
    return { backend: local, kind, identity, cacheKey: 'legacy:' + kind + ':' + localKey(db, table, kind) + ':' + JSON.stringify(meta) };
  } catch (error) {
    if (error instanceof IndexUnavailable) throw error;
    throw new IndexUnavailable('index-invalid', 'The stored search index metadata or table could not be read.', kind);
  }
}

/** The analysis fingerprint is a separate anchor from each table's content basis. */
export function publishedAnalysisFingerprint(outputDir: string): string | null {
  const raw = readSmall(join(outputDir, 'fingerprint.json'));
  if (raw === null) return null;
  const hash: unknown = JSON.parse(raw)?.hash;
  return typeof hash === 'string' && SHA256.test(hash) ? hash : null;
}

function sourceDigest(records: Record<string, unknown>[]): string {
  const source = createHash('sha256');
  for (const row of [...records].sort((a, b) => String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0)) {
    const { vector: _vector, ...input } = row;
    const fields = Object.entries(input).filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    source.update(JSON.stringify(fields) + '\n');
  }
  return source.digest('hex');
}

function discardLocalGeneration(db: string, descriptor: Descriptor): void {
  if (descriptor.backend === 'qdrant') return;
  const table = localTable(descriptor);
  const path = descriptor.backend === 'file' ? filePath(db, table) : lancePath(db, table);
  try {
    rmSync(path, { recursive: descriptor.backend === 'lance', force: true });
  } catch {
    // A stale local artifact is harmless after the descriptor has switched.
  }
}

export async function publishVectorIndex(
  db: string, table: IndexTable, records: VectorRecord[], model: string | null, analysisFingerprint: string | null,
): Promise<void> {
  if (process.env.OPENLORE_PINNED_INDEX === '1') {
    throw new IndexUnavailable('index-invalid', 'A pinned index reader cannot publish search data.');
  }
  db = assertPathAllowed(db, 'write');
  // One record per id: Qdrant keeps one point per id, so the count and the source
  // digest must describe the set every backend stores. An exact repeat is stored
  // once; two different records with one id are a producer error, refused loudly
  // rather than losing one of them.
  const byId = new Map<string, VectorRecord>();
  for (const row of records) {
    const prior = byId.get(row.id);
    if (!prior) byId.set(row.id, row);
    else if (JSON.stringify(prior) !== JSON.stringify(row)) {
      throw new IndexPublicationError(new Error(`Two different search records share the id "${row.id}"; ids must be unique before publication.`));
    }
  }
  records = [...byId.values()];
  const dim = records[0]?.vector?.length ?? 0;
  if (records.some(row => (row.vector?.length ?? 0) !== dim || row.vector?.some(value => !Number.isFinite(value)))) {
    throw new IndexUnavailable('embedding-mismatch', 'Cannot publish a search index with mixed or invalid vector dimensions.');
  }
  const backend = selectBackendKind({ qdrantUrl: dim > 0 ? qdrantUrl() : null, hasLancedb: records.length > 0 && hasLancedb() });
  const descriptor: Descriptor = {
    version: 1, table, generation: randomUUID(), backend, count: records.length,
    source_sha256: sourceDigest(records), model: dim > 0 ? model || null : null, dim,
    analysis_fingerprint: analysisFingerprint, distance: dim > 0 ? 'Cosine' : null,
    // EmbeddingService truncates each input at 24,000 characters before either transport.
    embedding_input: dim > 0 ? 'text-24000-v1' : null,
  };
  let previous: Descriptor | null;
  try {
    previous = readDescriptor(db, table);
  } catch {
    // An explicit build can replace a broken descriptor without trusting it for cleanup.
    previous = null;
  }
  const target = descriptorPath(db, table);
  const tmp = target + '.' + descriptor.generation + '.tmp';
  mkdirSync(db, { recursive: true });
  let remote: QdrantBackend | null = null;
  try {
    if (backend === 'qdrant') {
      remote = new QdrantBackend(collection(descriptor), descriptor);
      await remote.build(records);
    } else {
      const storage = localTable(descriptor);
      const store = backend === 'file' ? new FileBackend(db, storage) : new LanceBackend(db, storage);
      await store.build(records);
      await store.inspect(descriptor);
    }
    writeFileSync(tmp, JSON.stringify(descriptor) + '\n', { flag: 'wx', flush: true });
    renameSync(tmp, target);
  } catch (error) {
    discardLocalGeneration(db, descriptor);
    // This publication's own collection: its name is unique to the new generation,
    // so deleting it is safe even when Qdrant created it without confirming (a lost
    // or timed-out answer); a missing collection is fine. The published generation
    // is untouched, and a failed cleanup must not mask the cause.
    if (remote) await remote.drop().catch(() => {});
    throw new IndexPublicationError(error);
  } finally {
    try { unlinkSync(tmp); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (previous) discardLocalGeneration(db, previous);
}

function inspectRow(
  row: Record<string, unknown> | undefined, expected: { dim: number; count?: number } | null,
  kind: 'file' | 'lance',
): number {
  if ((!row && expected?.count !== undefined && expected.count !== 0) ||
      (row && (typeof row.id !== 'string' || typeof row.text !== 'string' || expected?.count === 0))) {
    throw new IndexUnavailable('index-invalid', 'The local search table does not match its descriptor.', kind);
  }
  const dim = row ? (row.vector as ArrayLike<number> | undefined)?.length ?? 0 : expected?.dim ?? 0;
  if (expected && expected.dim !== dim) {
    throw new IndexUnavailable('index-invalid', 'The local search table vector schema does not match its metadata.', kind);
  }
  return dim;
}

function checkRows(rows: Record<string, unknown>[], expected: Descriptor | undefined, kind: 'file' | 'lance'): void {
  if (!expected) return;
  if (rows.length !== expected.count) {
    throw new IndexUnavailable('index-invalid', 'The local search table is incomplete.', kind);
  }
  for (const row of rows) inspectRow(row, expected, kind);
}

// ── LanceDB (standalone, поведение прежнее) ───────────────────────────────────────────────────────
// @lancedb/lancedb — НЕ обязательная зависимость (optionalDependencies): дистрибутив PDLC собирается с
// `--omit=optional` и НЕ несёт 129-МБ нативный napi-бинарь (он один форсил per-OS-разбиение артефакта).
// Семантический индекс в поставке идёт через внешний Qdrant (QDRANT_URL). LanceBackend остаётся рабочим
// там, где lancedb установлен (dev/integration без Qdrant); если пакета нет — fail-loud с понятной причиной,
// а НЕ тихий BM25-fallback (принцип «без fallback'ов»). Импорт ленивый: на --no-embed-пути не вызывается.
class LanceBackend implements VectorBackend {
  constructor(private dbPath: string, private tableName: string, private expected?: Descriptor) {}

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
    checkRows(rows, this.expected, 'lance');
    return rows;
  }

  async searchDense(queryVector: number[], limit: number): Promise<Record<string, unknown>[]> {
    const { connect } = await this.lance();
    const db = await connect(this.dbPath);
    const table = await db.openTable(this.tableName);
    return table.query().nearestTo(queryVector).limit(limit).toArray();
  }

  async inspect(expected: { dim: number; count?: number } | null, signal?: AbortSignal): Promise<number> {
    signal?.throwIfAborted();
    const { connect } = await this.lance();
    const db = await connect(this.dbPath);
    const table = await db.openTable(this.tableName);
    if (expected?.count !== undefined && await table.countRows() !== expected.count) {
      throw new IndexUnavailable('index-invalid', 'The local LanceDB table has an unexpected record count.', 'lance');
    }
    const [row] = await table.query().limit(1).toArray();
    signal?.throwIfAborted();
    return inspectRow(row, expected, 'lance');
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
  constructor(private dbPath: string, tableName: string, private expected?: Descriptor, private required = false) {
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
    const tmp = this.file + '.' + randomUUID() + '.tmp';
    const out = createWriteStream(tmp, { encoding: 'utf8', flags: 'wx', flush: true });
    try {
      for (const r of records) {
        if (!out.write(JSON.stringify(r) + '\n')) await once(out, 'drain');
      }
      out.end();
      await once(out, 'close');
      renameSync(tmp, this.file);
    } finally {
      out.destroy();
      try { unlinkSync(tmp); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }

  async loadAll(): Promise<Record<string, unknown>[]> {
    const file = assertPathAllowed(this.file, 'read');
    if (!this.required && !existsSync(file)) return [];
    const rows: Record<string, unknown>[] = [];
    // Формат распознаём по первому байту. '[' — корпус, записанный ДО перехода на
    // NDJSON; такой файл по построению помещался в одну строку (иначе его не
    // удалось бы записать), поэтому читать его целиком безопасно. Иначе — NDJSON
    // построчно: целиком его читать нельзя, readFile('utf8') на корпусе больше
    // предела строки бросил бы ERR_STRING_TOO_LONG и обнулил бы смысл правки.
    const fd = openSync(file, 'r');
    const head = Buffer.alloc(1);
    const got = readSync(fd, head, 0, 1, 0);
    closeSync(fd);

    if (got === 1 && head.toString('utf8') === '[') {
      rows.push(...(JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>[]));
    } else if (got === 1) {
      const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
      for await (const line of rl) {
        if (line.length > 0) rows.push(JSON.parse(line) as Record<string, unknown>);
      }
    }
    for (const r of rows) if (r.vector) r.vector = Array.from(r.vector as ArrayLike<number>);
    checkRows(rows, this.expected, 'file');
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

  async inspect(expected: { dim: number; count?: number } | null, signal?: AbortSignal): Promise<number> {
    const file = assertPathAllowed(this.file, 'read');
    const stream = createReadStream(file, { encoding: 'utf8', highWaterMark: 16 * 1024, signal });
    // Bound this probe to one object in either NDJSON or the original JSON array.
    let row = '';
    let depth = 0;
    let quoted = false;
    let escaped = false;
    let examined = 0;
    for await (const chunk of stream) {
      for (const char of chunk as string) {
        if (++examined > 2 * 1024 * 1024) {
          throw new IndexUnavailable('index-invalid', 'The first local search index record exceeds its size limit.', 'file');
        }
        if (!row) {
          if (/\s/.test(char) || char === '[') continue;
          if (char === ']') return inspectRow(undefined, expected, 'file');
          if (char !== '{') throw new IndexUnavailable('index-invalid', 'Invalid local search index record.', 'file');
        }
        row += char;
        if (quoted) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') quoted = false;
        } else if (char === '"') {
          quoted = true;
        } else if (char === '{') {
          depth++;
        } else if (char === '}' && --depth === 0) {
          return inspectRow(JSON.parse(row), expected, 'file');
        }
      }
    }
    if (row) throw new IndexUnavailable('index-invalid', 'Truncated local search index record.', 'file');
    return inspectRow(undefined, expected, 'file');
  }

  exists(): boolean { return existsSync(this.file); }
}

// ── Qdrant (distributed) ──────────────────────────────────────────────────────────────────────────
const PROOF_FIELD = '_openlore_generation_sha256';
const RECORD_FIELD = '_openlore_record_sha256';

class QdrantBackend implements VectorBackend {
  readonly proof: string | null;
  /** `points_count` from the last collection info read by verify(). */
  pointsCount: unknown = null;
  private readonly url: string;
  private readonly base: string;

  constructor(name: string, private readonly descriptor: Descriptor | null, private readonly signal?: AbortSignal) {
    const url = qdrantUrl();
    if (!url) throw new IndexUnavailable('backend-unreachable', 'The saved Qdrant index requires its Qdrant connection.', 'qdrant');
    this.url = url;
    this.base = '/collections/' + name;
    this.proof = descriptor
      ? createHash('sha256').update(JSON.stringify([
          descriptor.version, descriptor.table, descriptor.generation, descriptor.source_sha256,
          descriptor.analysis_fingerprint, descriptor.model, descriptor.dim, descriptor.distance,
          descriptor.embedding_input, descriptor.count,
        ])).digest('hex')
      : null;
  }

  private async req(method: string, suffix = '', body?: unknown, signal = this.signal, bounded = false): Promise<any> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (process.env.QDRANT_API_KEY) headers['api-key'] = process.env.QDRANT_API_KEY;
    let response: Response;
    try {
      response = await fetch(this.url + this.base + suffix, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error', signal: signal ?? AbortSignal.timeout(10_000),
      });
    } catch {
      throw new IndexUnavailable('backend-unreachable', 'The Qdrant search backend did not answer the request.', 'qdrant');
    }
    if (response.status === 404) {
      void response.body?.cancel().catch(() => {});
      throw new IndexUnavailable('collection-missing', 'The saved Qdrant collection is missing.', 'qdrant');
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new IndexUnavailable('backend-unreachable', 'Qdrant rejected the search index request (HTTP ' + response.status + ').', 'qdrant');
    }
    const json: any = await (bounded ? this.probeBody(response) : response.json()).catch(error => {
      if (error instanceof IndexUnavailable) throw error;
      return null;
    });
    if (json?.status !== 'ok' || json.result == null) {
      throw new IndexUnavailable('index-invalid', 'Qdrant returned an invalid search index response.', 'qdrant');
    }
    return json.result;
  }

  private async probeBody(response: Response): Promise<unknown> {
    const reader = response.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 64 * 1024) {
          void reader.cancel().catch(() => {});
          throw new IndexUnavailable('index-invalid', 'Qdrant index verification response exceeds its size limit.', 'qdrant');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
  }

  async verify(signal = this.signal ?? AbortSignal.timeout(3000)): Promise<number> {
    const expected = this.descriptor;
    const [info, count, sample] = await Promise.all([
      this.req('GET', '', undefined, signal, true),
      expected ? this.req('POST', '/points/count', { exact: true }, signal, true) : null,
      expected ? this.req('POST', '/points/scroll', { limit: 1, with_payload: [PROOF_FIELD], with_vector: false }, signal, true) : null,
    ]);
    this.pointsCount = info?.points_count ?? null;
    const vectors = info?.config?.params?.vectors;
    const dim = vectors?.size;
    if (!Number.isSafeInteger(dim) || dim <= 0 || vectors.distance !== 'Cosine' ||
        (expected && (dim !== expected.dim || count?.count !== expected.count ||
          sample?.points?.length !== 1 || sample.points[0]?.payload?.[PROOF_FIELD] !== this.proof))) {
      throw new IndexUnavailable('collection-binding-mismatch', 'The Qdrant collection does not match the saved source generation or vector schema.', 'qdrant');
    }
    return dim;
  }

  private static pid(id: string): string {
    const h = createHash('sha1').update(id).digest('hex');
    return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20, 32)].join('-');
  }

  async build(records: VectorRecord[]): Promise<void> {
    const descriptor = this.descriptor;
    if (!descriptor) throw new Error('A Qdrant build requires a new publication generation.');
    const created = await this.req('PUT', '', { vectors: { size: descriptor.dim, distance: descriptor.distance } });
    if (created !== true) throw new IndexUnavailable('index-invalid', 'Qdrant did not create a new search generation.', 'qdrant');
    for (let i = 0; i < records.length; i += 256) {
      const points = records.slice(i, i + 256).map(({ vector, ...payload }) => ({
        id: QdrantBackend.pid(payload.id), vector, payload: { ...payload, [PROOF_FIELD]: this.proof, [RECORD_FIELD]: sourceDigest([payload]) },
      }));
      const result = await this.req('PUT', '/points?wait=true', { points });
      if (result.status !== 'completed') throw new IndexUnavailable('index-invalid', 'Qdrant did not confirm the new index batch.', 'qdrant');
    }
    await this.verify();
  }

  /** Delete this generation's collection — only for a publication that never completed. */
  async drop(): Promise<void> {
    await this.req('DELETE');
  }

  private row(point: any): Record<string, unknown> {
    const payload = point?.payload;
    if (!payload || typeof payload.id !== 'string' || typeof payload.text !== 'string' ||
        (this.proof && payload[PROOF_FIELD] !== this.proof)) {
      throw new IndexUnavailable('collection-binding-mismatch', 'Qdrant returned a record from an unexpected search generation.', 'qdrant');
    }
    const { [PROOF_FIELD]: _proof, [RECORD_FIELD]: digest, ...row } = payload;
    if (this.proof && digest !== sourceDigest([row])) {
      throw new IndexUnavailable('collection-binding-mismatch', 'Qdrant returned a search record with mismatched content.', 'qdrant');
    }
    return row;
  }

  async loadAll(): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    const offsets = new Set<unknown>();
    let offset: unknown;
    for (;;) {
      const page = await this.req('POST', '/points/scroll', {
        limit: 512, with_payload: true, with_vector: true, ...(offset != null ? { offset } : {}),
      });
      if (!Array.isArray(page.points)) throw new IndexUnavailable('index-invalid', 'Qdrant returned an invalid search page.', 'qdrant');
      for (const point of page.points) {
        if (!Array.isArray(point?.vector) || (this.descriptor && point.vector.length !== this.descriptor.dim)) {
          throw new IndexUnavailable('collection-binding-mismatch', 'Qdrant returned a record with an unexpected vector schema.', 'qdrant');
        }
        out.push({ ...this.row(point), vector: point.vector });
      }
      offset = page.next_page_offset;
      if (offset == null) break;
      if (offsets.has(offset) || page.points.length === 0 || (typeof offset !== 'number' && typeof offset !== 'string')) {
        throw new IndexUnavailable('index-invalid', 'Qdrant returned an invalid search cursor.', 'qdrant');
      }
      offsets.add(offset);
    }
    if (this.descriptor && (out.length !== this.descriptor.count || sourceDigest(out) !== this.descriptor.source_sha256)) {
      throw new IndexUnavailable('collection-binding-mismatch', 'Qdrant returned an incomplete or mismatched search generation.', 'qdrant');
    }
    return out;
  }

  async searchDense(queryVector: number[], limit: number): Promise<Record<string, unknown>[]> {
    const results = await this.req('POST', '/points/search', { vector: queryVector, limit, with_payload: true });
    if (!Array.isArray(results) || results.some(point => !Number.isFinite(point?.score))) {
      throw new IndexUnavailable('index-invalid', 'Qdrant returned invalid search results.', 'qdrant');
    }
    return results.map(point => ({ ...this.row(point), _distance: 1 - point.score }));
  }

  exists(): boolean { return true; }
}
