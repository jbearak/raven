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

// ---------- bigint64: 5 rows × 1 Int64 column with values straddling
//                       the JS Number.MAX_SAFE_INTEGER boundary.
// Used to verify the sort engine doesn't coalesce distinct Int64 values
// when they're beyond 2^53.

function buildBigInt64() {
    const N = 5;
    // Three Int64 values above Number.MAX_SAFE_INTEGER (= 2^53 - 1) plus
    // two safe-range anchors. Under Number-coercion, these collapse with
    // round-half-to-even at ULP = 2:
    //
    //   bigint               | Number(bigint)        | note
    //   (1n << 53n) + 1n     | 2^53                  | rounds DOWN
    //   (1n << 53n) + 3n     | 2^53 + 4              | rounds UP (half-to-even)
    //   (1n << 53n) + 5n     | 2^53 + 4              | rounds DOWN — COLLIDES with the +3 row
    //
    // (Note: (1n << 53n) + 1n == MAX_SAFE_INTEGER + 2, not + 1. The
    // value 2^53 is one past MAX_SAFE_INTEGER and is itself
    // representable; it's 2^53 + 1 that needs rounding.)
    //
    // The rows are arranged so naive Number() + stable sort produces a
    // DIFFERENT order than bigint sort — without that, the test would
    // pass even if the engine secretly coerced through Number:
    //
    //   row 0: (1n << 53n) + 5n   → Number 2^53 + 4    (precise: largest)
    //   row 1: (1n << 53n) + 3n   → Number 2^53 + 4    (precise: middle)
    //   row 2: (1n << 53n) + 1n   → Number 2^53        (precise: smallest of these three)
    //   row 3: 1n
    //   row 4: -1n
    //
    // Bigint asc:        [4, 3, 2, 1, 0]   (each precise value distinct)
    // Naive Number asc:  [4, 3, 2, 0, 1]   (rows 0 and 1 tie at 2^53+4;
    //                                       stable sort keeps original
    //                                       order, so 0 comes before 1)
    const values = new BigInt64Array(N);
    values[0] = (1n << 53n) + 5n;
    values[1] = (1n << 53n) + 3n;
    values[2] = (1n << 53n) + 1n;
    values[3] = 1n;
    values[4] = -1n;
    const fields = [new A.Field('big', new A.Int64(), false)];
    const schema = new A.Schema(fields);
    const colVec = A.makeVector({ data: values, type: new A.Int64() });
    const data = A.makeData({
        type: new A.Struct(fields),
        length: N,
        nullCount: 0,
        children: [colVec.data[0]],
    });
    const t = new A.Table(schema, [new A.RecordBatch(schema, data)]);
    write(join(outDir, 'bigint64.arrow'), t);
}

// ---------- uint64: 4 rows × 1 Uint64 column with values straddling
//                     the signed 64-bit boundary (2^63).
// Storing 2^63 in BigInt64Array would wrap to a negative two's-
// complement bigint and break ascending order; the engine must use
// BigUint64Array for Uint64 columns.

function buildUint64() {
    const N = 4;
    // Original row order:
    //   row 0: 2^63 + 1    (above signed 64-bit positive max)
    //   row 1: 2^64 - 1    (Uint64 max)
    //   row 2: 1
    //   row 3: 0
    // Asc on bigint compare → row 3, 2, 0, 1.
    const values = new BigUint64Array(N);
    values[0] = (1n << 63n) + 1n;
    values[1] = (1n << 64n) - 1n;
    values[2] = 1n;
    values[3] = 0n;
    const fields = [new A.Field('big', new A.Uint64(), false)];
    const schema = new A.Schema(fields);
    const colVec = A.makeVector({ data: values, type: new A.Uint64() });
    const data = A.makeData({
        type: new A.Struct(fields),
        length: N,
        nullCount: 0,
        children: [colVec.data[0]],
    });
    const t = new A.Table(schema, [new A.RecordBatch(schema, data)]);
    write(join(outDir, 'uint64.arrow'), t);
}

// ---------- labelled-non-float: 5 rows × 2 labelled columns whose
//                                  underlying storage is Int32 and Utf8
// (rather than Float64 like tiny.lbl). cell-render.ts honors valueLabels
// for any number-or-string cell, so the sort engine must too.

function buildLabelledNonFloat() {
    const N = 5;
    // i32 col with codes whose label order differs from numeric order:
    //   code 1 → "zebra", 2 → "apple", 3 → "mango".
    // Original rows: 1, 2, 3, 1, 2.
    //   Labels off (asc by code): rows [0, 3, 1, 4, 2] (1,1,2,2,3)
    //   Labels  on (asc by label): apple(1,4), mango(2), zebra(0,3) → [1, 4, 2, 0, 3]
    const i32Field = new A.Field('rating', new A.Int32(), false,
        new Map([
            ['raven.value_labels', JSON.stringify({ 1: 'zebra', 2: 'apple', 3: 'mango' })],
            ['raven.original_class', 'haven_labelled/vctrs_vctr/integer'],
        ]));
    // utf8 col with labels whose lexical order INVERTS the raw-code
    // order, so the test can prove the engine actually uses labels
    // when Labels is on (and raw codes when Labels is off).
    //   "Y" → "Apple", "N" → "Mango", "M" → "Zebra"
    // Original rows: "Y", "N", "M", "Y", "N"
    //   Labels off (asc, raw codes): M(2), N(1), N(4), Y(0), Y(3) → [2, 1, 4, 0, 3]
    //   Labels  on (asc, by label):  Apple(0,3), Mango(1,4), Zebra(2) → [0, 3, 1, 4, 2]
    const utf8Field = new A.Field('answer', new A.Utf8(), false,
        new Map([
            ['raven.value_labels', JSON.stringify({ Y: 'Apple', N: 'Mango', M: 'Zebra' })],
            ['raven.original_class', 'haven_labelled/vctrs_vctr/character'],
        ]));
    const fields = [i32Field, utf8Field];
    const schema = new A.Schema(fields);
    const i32Vec = A.vectorFromArray(Int32Array.from([1, 2, 3, 1, 2]), new A.Int32());
    const utf8Vec = A.vectorFromArray(['Y', 'N', 'M', 'Y', 'N'], new A.Utf8());
    const data = A.makeData({
        type: new A.Struct(fields),
        length: N,
        nullCount: 0,
        children: [i32Vec.data[0], utf8Vec.data[0]],
    });
    const t = new A.Table(schema, [new A.RecordBatch(schema, data)]);
    write(join(outDir, 'labelled-non-float.arrow'), t);
}

buildTiny();
buildMultibatch();
buildBigInt64();
buildUint64();
buildLabelledNonFloat();
buildBigdict();
console.log('done.');
