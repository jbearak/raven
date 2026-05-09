// Generates Arrow IPC test fixtures for data-viewer tests.
// Run:  bun editors/vscode/test-fixtures/generate-data-viewer.mjs
//
// Writes into editors/vscode/test-fixtures/data-viewer/.
//
// We generate fixtures in JS (rather than R) so the unit-test suite has
// no R dependency. End-to-end tests with real R-written files are covered
// separately under crates/raven/tests/.

import * as A from 'apache-arrow';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'data-viewer');
mkdirSync(outDir, { recursive: true });

function write(path, table) {
    const buf = A.tableToIPC(table, 'file');
    writeFileSync(path, Buffer.from(buf));
    console.log('wrote', path, buf.length, 'bytes');
}

// ---------- tiny: 5 rows with a mix of types & metadata ----------

function buildTiny() {
    // Manually build a Schema + RecordBatch to attach column-level KV
    // metadata (raven.variable_label, raven.value_labels).
    const fields = [
        new A.Field('x', new A.Int32(), false),
        new A.Field('y', new A.Float64(), true,
            new Map([['raven.variable_label', 'A floaty column']])),
        new A.Field('s', new A.Utf8(), true),
        new A.Field('f', new A.Dictionary(new A.Utf8(), new A.Int32()), false,
            new Map([['raven.original_class', 'factor']])),
        new A.Field('d', new A.DateDay(), true),
        new A.Field('ts', new A.TimestampMicrosecond('UTC'), true),
        // haven_labelled — encoded as plain Float64 with value_labels meta.
        new A.Field('lbl', new A.Float64(), false,
            new Map([
                ['raven.variable_label', 'Group'],
                ['raven.value_labels', JSON.stringify({ 1: 'low', 2: 'mid', 3: 'high' })],
                ['raven.original_class', 'haven_labelled/vctrs_vctr/double'],
            ])),
    ];

    const schema = new A.Schema(fields);

    // Build typed arrays for each column.
    const x = Int32Array.from([1, 2, 3, 4, 5]);
    const yVals = Float64Array.from([1.5, 0, NaN, Infinity, -Infinity]);
    const yValid = new Uint8Array([1 | (0 << 1) | (1 << 2) | (1 << 3) | (1 << 4)]);
    const s = ['a', 'b', null, 'd', 'e'];
    const fLevels = ['low', 'med', 'high'];
    const fIndices = Int32Array.from([0, 1, 0, 2, 1]);
    const dDays = Int32Array.from([
        Math.floor(Date.UTC(2024, 0, 1) / 86_400_000),
        Math.floor(Date.UTC(2024, 0, 2) / 86_400_000),
        Math.floor(Date.UTC(2024, 0, 3) / 86_400_000),
        Math.floor(Date.UTC(2024, 0, 4) / 86_400_000),
        Math.floor(Date.UTC(2024, 0, 5) / 86_400_000),
    ]);
    const tsBig = BigInt64Array.from([
        BigInt(Date.UTC(2024, 0, 1, 12, 0, 0)) * 1000n,
        BigInt(Date.UTC(2024, 0, 1, 12, 0, 1)) * 1000n,
        BigInt(Date.UTC(2024, 0, 1, 12, 0, 2)) * 1000n,
        BigInt(Date.UTC(2024, 0, 1, 12, 0, 3)) * 1000n,
        BigInt(Date.UTC(2024, 0, 1, 12, 0, 4)) * 1000n,
    ]);
    const lbl = Float64Array.from([1, 2, 3, 1, 2]);

    // Direct vectors so types match the schema we declared.
    const xVec = A.vectorFromArray(x, new A.Int32());
    const yVec = A.makeVector({ data: yVals, type: new A.Float64(), nullBitmap: yValid });
    const sVec = A.vectorFromArray(s, new A.Utf8());
    const fVec = (() => {
        const dictType = new A.Dictionary(new A.Utf8(), new A.Int32());
        const dictVec = A.vectorFromArray(fLevels, new A.Utf8());
        return A.makeVector({
            data: fIndices,
            type: dictType,
            dictionary: dictVec,
        });
    })();
    const dVec = A.makeVector({ data: dDays, type: new A.DateDay() });
    const tsVec = A.makeVector({ data: tsBig, type: new A.TimestampMicrosecond('UTC') });
    const lblVec = A.vectorFromArray(lbl, new A.Float64());

    // Build the table from these vectors but preserve our metadata-bearing schema.
    const t = new A.Table(schema, [
        new A.RecordBatch(schema, A.makeData({
            type: new A.Struct(fields),
            length: 5,
            nullCount: 0,
            children: [xVec.data[0], yVec.data[0], sVec.data[0], fVec.data[0], dVec.data[0], tsVec.data[0], lblVec.data[0]],
        })),
    ]);

    write(join(outDir, 'tiny.arrow'), t);
}

// ---------- multibatch: 1000 rows × 2 cols, batches of 100 ----------

function buildMultibatch() {
    const N = 1000;
    const i = Int32Array.from({ length: N }, (_, k) => k + 1);
    const v = Float64Array.from({ length: N }, (_, k) => k * 0.5);
    const chunkSize = 100;
    const fields = [
        new A.Field('i', new A.Int32(), false),
        new A.Field('v', new A.Float64(), false),
    ];
    const schema = new A.Schema(fields);
    const batches = [];
    for (let off = 0; off < N; off += chunkSize) {
        const end = Math.min(N, off + chunkSize);
        const ic = A.vectorFromArray(i.slice(off, end), new A.Int32());
        const vc = A.vectorFromArray(v.slice(off, end), new A.Float64());
        const data = A.makeData({
            type: new A.Struct(fields),
            length: end - off,
            nullCount: 0,
            children: [ic.data[0], vc.data[0]],
        });
        batches.push(new A.RecordBatch(schema, data));
    }
    const t = new A.Table(schema, batches);
    write(join(outDir, 'multibatch.arrow'), t);
}

// ---------- bigdict: 50 rows × 1 dict column with 20 unique levels ----------
// The "big dictionary" cardinality test uses an injectable threshold in
// the reader; we don't need a literal 100k-cardinality fixture file.

function buildBigdict() {
    const N = 50;
    const distinct = 20;
    const levels = Array.from({ length: distinct }, (_, k) =>
        `zip-${String(k).padStart(3, '0')}`);
    const idx = Int32Array.from({ length: N }, (_, k) => k % distinct);
    const fields = [new A.Field('zip', new A.Dictionary(new A.Utf8(), new A.Int32()), false)];
    const schema = new A.Schema(fields);
    const dictType = new A.Dictionary(new A.Utf8(), new A.Int32());
    const dictVec = A.vectorFromArray(levels, new A.Utf8());
    const colVec = A.makeVector({ data: idx, type: dictType, dictionary: dictVec });
    const data = A.makeData({
        type: new A.Struct(fields),
        length: N,
        nullCount: 0,
        children: [colVec.data[0]],
    });
    const batch = new A.RecordBatch(schema, data);
    const t = new A.Table(schema, [batch]);
    write(join(outDir, 'bigdict.arrow'), t);
}

buildTiny();
buildMultibatch();
buildBigdict();
console.log('done.');
