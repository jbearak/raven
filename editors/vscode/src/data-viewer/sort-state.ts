/**
 * Persisted sort state for the data viewer.
 *
 * Mirrors {@link ./toolbar-state.ts}'s ToolbarStateStore and shares the
 * same LRU cap (the data viewer's `maxStoredLayouts` setting). Layout,
 * toolbar, and sort persistence evict together for a given panel+hash,
 * so a panel that survives in one store survives in all three.
 *
 * What's persisted is only the list of sort keys (column index +
 * direction). The host always recomputes the permutation against the
 * current reader on restore — schema-hash equality is not evidence
 * that two datasets share values, so trusting a stored permutation
 * would be unsafe.
 */

import type { Memento } from './layout-state';
import type { SortState } from './messages';

const PREFIX = 'raven.dataViewer.sort::';
const ORDER_KEY = 'raven.dataViewer.sortOrder';

export class SortStateStore {
    constructor(
        private readonly kv: Memento,
        private readonly cap: number,
    ) {}

    private compositeKey(panelName: string, hash: string): string {
        return `${PREFIX}${panelName}::${hash}`;
    }

    async load(panelName: string, hash: string): Promise<SortState | undefined> {
        return this.kv.get<SortState>(this.compositeKey(panelName, hash));
    }

    async save(panelName: string, hash: string, state: SortState): Promise<void> {
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

    async clear(panelName: string, hash: string): Promise<void> {
        const key = this.compositeKey(panelName, hash);
        await this.kv.update(key, undefined);
        const order = (this.kv.get<string[]>(ORDER_KEY) ?? []).filter(k => k !== key);
        await this.kv.update(ORDER_KEY, order);
    }
}
