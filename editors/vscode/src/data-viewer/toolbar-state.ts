/**
 * Persisted toolbar-toggle state for the data viewer.
 *
 * Mirrors {@link ./layout-state.ts}'s LayoutStore: keyed by `panelName +
 * schemaHash` so two unrelated `View(df)` calls under the same panel name
 * don't collide, and bounded by `cap` with LRU eviction.
 *
 * Stores `labelsOn`, `formatOn`, `digits`, and the sort menu's string
 * order so a fresh `View(x)` call restores the user's prior toggle state
 * for the same dataset shape (column names + Arrow types in declared
 * order).
 */

import type { Memento } from './layout-state';
import type { StringOrder } from './messages';

const PREFIX = 'raven.dataViewer.toolbar::';
const ORDER_KEY = 'raven.dataViewer.toolbarOrder';

export type ToolbarState = {
    labelsOn: boolean;
    formatOn: boolean;
    digits: number;
    /** String order chosen in the sort menu, used by the next sort.
     *  Absent ⇔ `natural`. */
    sortOrder?: StringOrder;
    /** The Σ summary band. Absent ⇔ the size default: on for frames
     *  with ≤ 200 columns and ≤ 1M rows. */
    summariesOn?: boolean;
};

export class ToolbarStateStore {
    constructor(
        private readonly kv: Memento,
        private readonly cap: number,
    ) {}

    private compositeKey(panelName: string, hash: string): string {
        return `${PREFIX}${panelName}::${hash}`;
    }

    async load(panelName: string, hash: string): Promise<ToolbarState | undefined> {
        return this.kv.get<ToolbarState>(this.compositeKey(panelName, hash));
    }

    async save(panelName: string, hash: string, state: ToolbarState): Promise<void> {
        const key = this.compositeKey(panelName, hash);
        await this.kv.update(key, state);

        const order = (this.kv.get<string[]>(ORDER_KEY) ?? []).filter(k => k !== key);
        order.push(key);
        while (order.length > this.cap) {
            const evict = order.shift()!;
            await this.kv.update(evict, undefined);
        }
        await this.kv.update(ORDER_KEY, order);
    }
}
