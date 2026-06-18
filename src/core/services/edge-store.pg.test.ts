import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EdgeStore } from './edge-store.js';
import type { CallEdge, FunctionNode, ClassNode } from '../analyzer/call-graph.js';

// D7 ось C — Postgres-бэкенд EdgeStore против ЖИВОГО Postgres. GATED по OPENLORE_PG_URL (SKIP без него → CI на SQLite).
//   OPENLORE_PG_URL=postgres://… npx vitest run src/core/services/edge-store.pg.test.ts
// Своя ws (hash временного dbPath); clearAll в начале и afterAll (чужие воркспейсы в ol_* не трогаем).

const RUN = !!process.env.OPENLORE_PG_URL;
const DBPATH = EdgeStore.dbPath(mkdtempSync(join(tmpdir(), 'ol-edge-pg-')));

const nodes: FunctionNode[] = [
  { id: 'src/a.ts::foo', name: 'foo', filePath: 'src/a.ts', isAsync: true, language: 'typescript', startIndex: 0, endIndex: 10, fanIn: 0, fanOut: 1, signature: 'foo(): void' },
  { id: 'src/b.ts::bar', name: 'bar', filePath: 'src/b.ts', isAsync: false, language: 'typescript', startIndex: 5, endIndex: 20, fanIn: 1, fanOut: 0 },
];
const edges: CallEdge[] = [
  { callerId: 'src/a.ts::foo', calleeId: 'src/b.ts::bar', calleeName: 'bar', confidence: 'import', callType: 'direct' },
];
const classes: ClassNode[] = [
  { id: 'src/a.ts::A', name: 'A', filePath: 'src/a.ts', language: 'typescript', parentClasses: ['Base'], interfaces: ['IFoo'], methodIds: ['src/a.ts::foo'], fanIn: 0, fanOut: 0 },
];

describe.runIf(RUN)('EdgeStore — Postgres backend (D7 ось C, live)', () => {
  let store: EdgeStore;
  afterAll(async () => { if (store) { await store.clearAll(); await store.close(); } });

  it('build → query roundtrip против живого Postgres', async () => {
    store = await EdgeStore.open(DBPATH);          // OPENLORE_PG_URL → PgBackend
    await store.clearAll();                         // чистый ws

    await store.insertNodes(nodes, new Set(['src/a.ts::foo']), new Set(['src/a.ts::foo']));
    await store.insertEdges(edges);
    await store.insertClasses(classes);
    await store.setFileHash('src/a.ts', 'hash-abc');

    // exists через статик (тот же ws) — есть строки ol_nodes
    expect(await EdgeStore.exists(mkPath(DBPATH))).toBe(true);

    const foo = await store.getNode('src/a.ts::foo');
    expect(foo?.name).toBe('foo');
    expect(foo?.isAsync).toBe(true);               // is_async int 0/1 → boolean
    expect(foo?.signature).toBe('foo(): void');

    expect((await store.getNodesForFile('src/b.ts')).map(n => n.id)).toEqual(['src/b.ts::bar']);
    expect((await store.searchNodes('ba')).some(n => n.id === 'src/b.ts::bar')).toBe(true);   // ILIKE-подстрока
    expect(await store.countNodes()).toBe(2);

    const callees = await store.getCallees('src/a.ts::foo');
    expect(callees.length).toBe(1);
    expect(callees[0].calleeId).toBe('src/b.ts::bar');
    expect(callees[0].confidence).toBe('import');
    expect((await store.getCallers('src/b.ts::bar')).length).toBe(1);
    expect((await store.getCalleesForIds(['src/a.ts::foo'])).length).toBe(1);

    const cls = await store.getClass('src/a.ts::A');
    expect(cls?.parentClasses).toEqual(['Base']);  // JSON round-trip
    expect(cls?.methodIds).toEqual(['src/a.ts::foo']);

    expect(await store.getFileHash('src/a.ts')).toBe('hash-abc');

    // hubs/entry-points флаги доехали
    expect((await store.getHubs()).some(n => n.id === 'src/a.ts::foo')).toBe(true);
    expect((await store.getEntryPoints()).some(n => n.id === 'src/a.ts::foo')).toBe(true);

    // delete по файлу → пусто
    await store.deleteNodesForFile('src/b.ts');
    expect(await store.getNode('src/b.ts::bar')).toBeNull();
  });
});

// EdgeStore.exists принимает outputDir, dbPath = <outputDir>/call-graph.db → восстановим outputDir из dbPath
function mkPath(dbPath: string): string { return dbPath.replace(/\/call-graph\.db$/, ''); }
