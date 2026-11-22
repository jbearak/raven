// A value-labelled integer64 column (bit64 values with a "labels"
// attribute) whose values differ past 2^53: the sidebar's per-label
// counts, Value Counts and the set filter all key on the exact integer.
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Field, RecordBatch, Schema, Table, tableToIPC, vectorFromArray } from 'apache-arrow';
import { ArrowSliceReader } from '../../editors/vscode/src/data-viewer/arrow-reader';
import { computeFilteredIndices } from '../../editors/vscode/src/data-viewer/filter';
import { computeProfile } from '../../editors/vscode/src/data-viewer/profile-engine';
import type { FilterPredicate } from '../../editors/vscode/src/data-viewer/messages';

const DIR = mkdtempSync(join(tmpdir(), 'raven-dv-int64-labels-'));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

/** `lab`: 2^53, 2^53 + 1, 2^53 + 1, labelled even / odd. */
async function open(): Promise<ArrowSliceReader> {
    const t = new Table({ lab: vectorFromArray(BigInt64Array.from([9007199254740992n, 9007199254740993n, 9007199254740993n])) });
    const md = new Map([
        ['raven.value_labels', JSON.stringify({ '9007199254740992': 'even', '9007199254740993': 'odd' })],
        ['raven.type_tag', '<integer64>'],
    ]);
    const schema = new Schema([new Field('lab', t.schema.fields[0].type, true, md)]);
    const withMd = new Table(schema, t.batches.map(b => new RecordBatch(schema, b.data)));
    const p = join(DIR, `lab-${Math.random()}.arrow`);
    writeFileSync(p, tableToIPC(withMd, 'file'));
    return ArrowSliceReader.open(p);
}

describe('value-labelled integer64 past 2^53', () => {
    test('the sidebar counts each label on the exact integer, as Value Counts does', async () => {
        const r = await open();
        expect(r.schema.columns[0].valueLabels).toBeDefined();
        const { profile, counts } = await computeProfile(r, 0);
        expect(profile.kind).toBe('labelled');
        expect(counts!.entries.map(e => [e.label, e.count])).toEqual([['odd', 2], ['even', 1]]);
        expect(profile.levels!.used).toBe(2);
        expect(profile.levels!.counts.map(e => [e.label, e.count]).sort()).toEqual([['even', 1], ['odd', 2]]);
        await r.close();
    });

    const cases: [string, FilterPredicate, number[]][] = [
        ['odd (decimal text from Value Counts)', { kind: 'setIn', values: ['9007199254740993'] }, [1, 2]],
        ['even (a safe number)', { kind: 'setIn', values: [9007199254740992] }, [0]],
        ['not odd', { kind: 'setNotIn', values: ['9007199254740993'] }, [0]],
        ['a null from a lossy transport matches nothing', { kind: 'setIn', values: [null as unknown as number] }, []],
    ];
    for (const [name, p, want] of cases) {
        test(`set filter: ${name}`, async () => {
            const r = await open();
            const rows = await computeFilteredIndices(r, {
                entries: [{ id: 'a', columnIndex: 0, predicate: p, enabled: true, includeMissing: false }],
                labelsOnWhenFiltered: true,
            }, { labelsOn: true, formatOn: true, digits: 3 });
            expect(Array.from(rows!)).toEqual(want);
            await r.close();
        });
    }
});
