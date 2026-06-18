import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openVectorBackend } from './vector-store.js';

// D7 ось B — Qdrant-бэкенд VectorStore против ЖИВОГО Qdrant. GATED по QDRANT_URL (SKIP без него → CI герметичен).
//   QDRANT_URL=http://127.0.0.1:6333 npx vitest run src/core/analyzer/vector-store.qdrant.test.ts
// Своя коллекция (по hash временного dbPath); удаляется в afterAll (чужие ws-…/rag_… не трогаем).

const RUN = !!process.env.QDRANT_URL;
const DBPATH = mkdtempSync(join(tmpdir(), 'ol-vs-qdrant-')) + '/vector-index';
const TABLE = 'functions';
const DIM = 8;
const vec = (i: number) => Array.from({ length: DIM }, (_, k) => (k === i ? 1 : 0));

describe.runIf(RUN)('VectorStore — Qdrant backend (D7 ось B, live)', () => {
  afterAll(async () => {
    // снести свою коллекцию (имя детерминировано от dbPath)
    const { createHash } = await import('node:crypto');
    const h = createHash('sha1').update(DBPATH).digest('hex').slice(0, 12);
    const coll = `openlore_${TABLE}_${h}`;
    const hdr: Record<string, string> = { 'content-type': 'application/json' };
    if (process.env.QDRANT_API_KEY) hdr['api-key'] = process.env.QDRANT_API_KEY;
    await fetch(`${process.env.QDRANT_URL!.replace(/\/+$/, '')}/collections/${coll}`, { method: 'DELETE', headers: hdr }).catch(() => {});
  });

  it('build → exists → loadAll → searchDense roundtrip', async () => {
    const backend = openVectorBackend(DBPATH, TABLE);
    const records = [0, 1, 2].map((i) => ({ id: `f${i}`, name: `fn${i}`, filePath: `src/f${i}.ts`, text: `функция ${i}`, vector: vec(i) }));

    await backend.build(records);
    expect(backend.exists()).toBe(true);                                   // table-specific маркер .qdrant-functions

    const all = await backend.loadAll();
    expect(all.length).toBe(3);
    const f1 = all.find((r) => (r as { id: string }).id === 'f1');
    expect(f1).toBeTruthy();
    expect((f1 as { filePath: string }).filePath).toBe('src/f1.ts');       // payload восстановлен
    expect(Array.isArray((f1 as { vector: number[] }).vector)).toBe(true); // вектор восстановлен (для инкремент-кэша)

    const hits = await backend.searchDense(vec(1), 1);                     // запрос по оси-1 → ближайший f1
    expect(hits.length).toBe(1);
    expect((hits[0] as { id: string }).id).toBe('f1');
    expect(typeof (hits[0] as { _distance: number })._distance).toBe('number');
  });
});
