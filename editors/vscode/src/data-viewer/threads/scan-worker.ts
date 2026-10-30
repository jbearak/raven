/**
 * Scan worker entry: all full-column work — sort keys and permutations,
 * filters, histograms, the header null-count scan, and column profiles
 * and value counts at the lowest priority (`scan-core.ts`).
 * A busy worker can't read messages, so cancellation reaches it through
 * each request's shared flag, checked between batches and every 65,536
 * comparisons; a regex filter or a deadline overrun is cancelled by the
 * host terminating this thread.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { ArrowSliceReader } from '../arrow-reader';
import { MemoryCounter } from '../perm-buffer';
import { ScanCore } from '../scan-core';
import type { ScanRequest, ThreadInit, ThreadReply } from './protocol';
import { errorPayload, sharedSignal } from './protocol';

const port = parentPort!;
const init = workerData as ThreadInit;
const post = (m: ThreadReply) => port.postMessage(m);

async function main(): Promise<void> {
    let core: ScanCore;
    try {
        core = new ScanCore(
            await ArrowSliceReader.open(init.filePath),
            new MemoryCounter(init.counter),
            init.priority ? new Int32Array(init.priority) : undefined,
        );
    } catch (err) {
        post({ type: 'openFailed', error: errorPayload(err).message });
        return;
    }
    port.on('message', (m: ScanRequest) => { void handle(core, m); });
    post({ type: 'ready' });
}

async function handle(core: ScanCore, m: ScanRequest): Promise<void> {
    if (!('id' in m)) {
        if (m.op === 'commit') core.commit(m.gen, m.spec);
        else core.abort(m.gen);
        return;
    }
    try {
        let value: unknown;
        switch (m.op) {
            case 'seed': core.seed(m.gen, m.spec); break;
            case 'compute': {
                let last = 0;
                value = await core.compute(m.gen, m.req, {
                    signal: sharedSignal(m.cancel),
                    partial: m.partial,
                    onProgress: (phase, done, total) => {
                        const now = Date.now();
                        if (now - last < 100) return;
                        last = now;
                        post({ type: 'progress', id: m.id, value: { phase, done, total } });
                    },
                });
                break;
            }
            case 'nullCounts': {
                let last = 0;
                const counts = await core.nullCounts(sharedSignal(m.cancel), c => {
                    const now = Date.now();
                    if (now - last < 100) return;
                    last = now;
                    post({ type: 'progress', id: m.id, value: Array.from(c) });
                });
                value = Array.from(counts);
                break;
            }
            case 'histogram':
                value = await core.histogram(m.columnIndex, sharedSignal(m.cancel));
                break;
            case 'profile':
                value = await core.profile(m.columnIndex, sharedSignal(m.cancel));
                break;
            case 'valueCounts':
                value = await core.valueCounts(m.columnIndex, m.order, m.limit, sharedSignal(m.cancel));
                break;
            case 'find':
                value = await core.find(m.query, m.perm, sharedSignal(m.cancel));
                break;
        }
        post({ type: 'reply', id: m.id, ok: true, value });
    } catch (err) {
        post({ type: 'reply', id: m.id, ok: false, error: errorPayload(err) });
    }
}

void main();
