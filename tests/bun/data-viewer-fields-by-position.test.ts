// Per-column metadata keyed by position (`raven.fields_by_position`), as
// the R writer stores it when column names repeat or are empty: each
// column gets its own entry, never another column's of the same name.
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Field, Float64, makeData, RecordBatch, Schema, Struct, Table, tableToIPC } from 'apache-arrow';
import { ArrowSliceReader } from '../../editors/vscode/src/data-viewer/arrow-reader';

const DIR = mkdtempSync(join(tmpdir(), 'raven-dv-fields-pos-'));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

test('duplicate and empty names read their own metadata by position', async () => {
    const fields = ['d', 'd', ''].map(n => new Field(n, new Float64(), true));
    const fieldsMd = [
        { 'raven.type_tag': '<drtn hours>' },
        { 'raven.type_tag': '<drtn mins>', 'raven.variable_label': 'Minutes' },
        { 'raven.type_tag': '<dbl>' },
    ];
    const schema = new Schema(fields, new Map([
        ['raven.nrow', '2'],
        ['raven.chunk_rows', '1024'],
        ['raven.fields_by_position', JSON.stringify(fieldsMd)],
    ]));
    const children = [[1, 2], [60, 120], [5, 6]].map(v => makeData({ type: new Float64(), length: 2, nullCount: 0, data: Float64Array.from(v) }));
    const batch = new RecordBatch(schema, makeData({ type: new Struct(fields), length: 2, nullCount: 0, children }));
    const p = join(DIR, 'dups.arrow');
    writeFileSync(p, tableToIPC(new Table(schema, [batch]), 'file'));
    const r = await ArrowSliceReader.open(p);
    // (apache-arrow's JS writer stores an empty name as null; R's keeps "".)
    expect(r.schema.columns.map(c => [c.typeTag, c.variableLabel])).toEqual([
        ['<drtn hours>', undefined],
        ['<drtn mins>', 'Minutes'],
        ['<dbl>', undefined],
    ]);
    await r.close();
});
