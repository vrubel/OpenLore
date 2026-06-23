import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBackend, selectBackendKind } from './vector-store.js';

// Lancedb-free бэкенд (слим single-installer: BM25 без Qdrant и без 129-МБ напи). Полностью герметичен —
// НЕ требует ни @lancedb, ни Qdrant (в отличие от vector-store.qdrant.test.ts, который GATED по QDRANT_URL).

const DIM = 8;
const vec = (i: number) => Array.from({ length: DIM }, (_, k) => (k === i ? 1 : 0));

describe('selectBackendKind — выбор бэкенда (чистая функция)', () => {
  it('QDRANT_URL задан → qdrant (приоритет, даже если есть lancedb)', () => {
    expect(selectBackendKind({ qdrantUrl: 'http://127.0.0.1:6333', hasLancedb: true })).toBe('qdrant');
    expect(selectBackendKind({ qdrantUrl: 'http://x', hasLancedb: false })).toBe('qdrant');
  });
  it('нет QDRANT_URL, есть lancedb → lance', () => {
    expect(selectBackendKind({ qdrantUrl: null, hasLancedb: true })).toBe('lance');
  });
  it('нет ни QDRANT_URL, ни lancedb → file (слим-standalone)', () => {
    expect(selectBackendKind({ qdrantUrl: null, hasLancedb: false })).toBe('file');
  });
});

describe('FileBackend — lancedb-free хранилище (build → exists → loadAll → searchDense)', () => {
  it('roundtrip: записи сохраняются и читаются (BM25-корпус), вектор восстановлен', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'ol-vs-file-')), 'vector-index');
    const backend = new FileBackend(dbPath, 'functions');
    expect(backend.exists()).toBe(false);

    const records = [0, 1, 2].map((i) => ({ id: `f${i}`, name: `fn${i}`, filePath: `src/f${i}.ts`, text: `функция ${i}`, vector: vec(i) }));
    await backend.build(records);

    expect(backend.exists()).toBe(true);                                   // файл записей создан
    expect(existsSync(dbPath)).toBe(true);                                 // папка vector-index/ → VectorIndex.exists() истинно

    const all = await backend.loadAll();
    expect(all.length).toBe(3);
    const f1 = all.find((r) => (r as { id: string }).id === 'f1') as { filePath: string; vector: number[] };
    expect(f1.filePath).toBe('src/f1.ts');                                 // payload восстановлен
    expect(Array.isArray(f1.vector)).toBe(true);                           // вектор восстановлен (для инкремент-кэша)
  });

  it('searchDense: brute-force cosine — ближайший по оси, _distance растёт от близкого к далёкому', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'ol-vs-file-')), 'vector-index');
    const backend = new FileBackend(dbPath, 'functions');
    await backend.build([0, 1, 2].map((i) => ({ id: `f${i}`, text: `t${i}`, vector: vec(i) })));

    const hits = await backend.searchDense(vec(1), 3) as { id: string; _distance: number }[];
    expect(hits[0].id).toBe('f1');                                         // запрос по оси-1 → ближайший f1
    expect(typeof hits[0]._distance).toBe('number');
    expect(hits[0]._distance).toBeLessThanOrEqual(hits[1]._distance);      // best-first
    expect(hits[0]._distance).toBeCloseTo(0, 5);                           // совпадение по направлению → cos≈1 → dist≈0
  });

  it('loadAll на непостроенном индексе → пусто (без падения)', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'ol-vs-file-')), 'vector-index');
    const backend = new FileBackend(dbPath, 'functions');
    expect(await backend.loadAll()).toEqual([]);
  });
});
