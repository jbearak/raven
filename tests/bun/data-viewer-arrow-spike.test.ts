// Spike test that pins the apache-arrow JS API surface used by
// ArrowSliceReader (Task 4 of the data viewer plan). Any change to
// apache-arrow's reader or vector internals will surface here first
// rather than ten layers down inside the reader.
//
// All `as any` casts are intentional: the spike is reaching into
// implementation details (typed-array `data[0].values`,
// `data[0].dictionary`) that the public d.ts deliberately doesn't
// surface. ArrowSliceReader uses the same casts.
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RecordBatchFileReader } from 'apache-arrow';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = (n: string) =>
    join(HERE, '..', '..', 'editors/vscode/test-fixtures/data-viewer', n);

async function openFile(buf: Buffer): Promise<any> {
    return await (RecordBatchFileReader.from(buf) as any).open();
}

describe('apache-arrow JS API surface', () => {
    test('open() is required before schema/numRecordBatches are valid', async () => {
        const r = await openFile(readFileSync(FIX('tiny.arrow')));
        expect(r.schema.fields.map((f: any) => f.name))
            .toEqual(['x', 'y', 's', 'f', 'd', 'ts', 'lbl']);
        expect(r.numRecordBatches).toBe(1);
    });

    test('column-level KV metadata round-trips on Field.metadata', async () => {
        const r = await openFile(readFileSync(FIX('tiny.arrow')));
        const yField = r.schema.fields.find((f: any) => f.name === 'y');
        expect(yField.metadata.get('raven.variable_label')).toBe('A floaty column');
        const lblField = r.schema.fields.find((f: any) => f.name === 'lbl');
        const labels = JSON.parse(lblField.metadata.get('raven.value_labels'));
        expect(labels).toEqual({ '1': 'low', '2': 'mid', '3': 'high' });
    });

    test('readRecordBatch(i) returns a RecordBatch with getChild()', async () => {
        const r = await openFile(readFileSync(FIX('tiny.arrow')));
        const b = r.readRecordBatch(0);
        expect(b.numRows).toBe(5);
        expect(b.getChild('x').get(0)).toBe(1);
        const y = b.getChild('y');
        expect(y.get(0)).toBe(1.5);
        expect(y.get(1)).toBeNull();
        expect(Number.isNaN(y.get(2) as number)).toBe(true);
        expect(y.get(3)).toBe(Infinity);
        expect(y.get(4)).toBe(-Infinity);
    });

    test('factor column: raw 0-based indices via child.data[0].values', async () => {
        const r = await openFile(readFileSync(FIX('tiny.arrow')));
        const b = r.readRecordBatch(0);
        const f = b.getChild('f');
        expect(f.get(0)).toBe('low');
        const data = (f as any).data[0];
        expect(data.values).toBeInstanceOf(Int32Array);
        expect(Array.from(data.values as Int32Array).slice(0, 5))
            .toEqual([0, 1, 0, 2, 1]);
        const dict = data.dictionary;
        expect(dict.get(0)).toBe('low');
        expect(dict.get(1)).toBe('med');
        expect(dict.get(2)).toBe('high');
        expect(dict.length).toBe(3);
    });

    test('Date32 (DateDay) raw days via child.data[0].values', async () => {
        const r = await openFile(readFileSync(FIX('tiny.arrow')));
        const b = r.readRecordBatch(0);
        const d = b.getChild('d');
        const data = (d as any).data[0];
        expect(data.values).toBeInstanceOf(Int32Array);
        const days = Array.from(data.values as Int32Array).slice(0, 5);
        expect(days[0]).toBe(Math.floor(Date.UTC(2024, 0, 1) / 86_400_000));
    });

    test('Timestamp microsecond raw bigint via .data[0].values (BigInt64Array)', async () => {
        const r = await openFile(readFileSync(FIX('tiny.arrow')));
        const b = r.readRecordBatch(0);
        const ts = b.getChild('ts');
        const data = (ts as any).data[0];
        expect(data.values).toBeInstanceOf(BigInt64Array);
        const us0 = (data.values as BigInt64Array)[0];
        expect(us0).toBe(BigInt(Date.UTC(2024, 0, 1, 12, 0, 0)) * 1000n);
    });

    test('multibatch fixture: numRecordBatches=10, each has 100 rows', async () => {
        const r = await openFile(readFileSync(FIX('multibatch.arrow')));
        expect(r.numRecordBatches).toBe(10);
        for (let i = 0; i < r.numRecordBatches; i++) {
            const b = r.readRecordBatch(i);
            expect(b.numRows).toBe(100);
        }
    });

    test('readRecordBatch is idempotent across calls', async () => {
        const r = await openFile(readFileSync(FIX('multibatch.arrow')));
        const a = r.readRecordBatch(3);
        const b = r.readRecordBatch(3);
        expect(a.numRows).toBe(b.numRows);
        expect((a.getChild('i') as any).data[0].values[0])
            .toBe((b.getChild('i') as any).data[0].values[0]);
    });

    test('field type discrimination via String(type)', async () => {
        const r = await openFile(readFileSync(FIX('tiny.arrow')));
        const ts: Record<string, string> = {};
        for (const f of r.schema.fields) ts[f.name] = String(f.type);
        expect(ts.x).toBe('Int32');
        expect(ts.y).toBe('Float64');
        expect(ts.s).toBe('Utf8');
        expect(ts.f).toMatch(/^Dictionary/);
        expect(ts.d).toMatch(/^Date/);
        expect(ts.ts).toMatch(/^Timestamp/);
        expect(ts.lbl).toBe('Float64');
    });
});
