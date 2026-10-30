/**
 * Reader thread entry: serves viewport reads (row windows, copy rows,
 * cell text) for the generations the host commits (`reader-core.ts`).
 * Requests take milliseconds each, so scrolling never waits behind a
 * sort, which runs in the scan worker. Element gather here uses
 * synchronous `readSync` against the page cache.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { ArrowSliceReader } from '../arrow-reader';
import { ReaderCore } from '../reader-core';
import type { ReaderRequest, ThreadInit, ThreadReply } from './protocol';
import { errorPayload } from './protocol';

const port = parentPort!;
const init = workerData as ThreadInit;
const post = (m: ThreadReply) => port.postMessage(m);

async function main(): Promise<void> {
    let core: ReaderCore;
    try {
        core = new ReaderCore(await ArrowSliceReader.open(init.filePath));
    } catch (err) {
        post({ type: 'openFailed', error: errorPayload(err).message });
        return;
    }
    port.on('message', (m: ReaderRequest) => { void handle(core, m); });
    post({ type: 'ready' });
}

async function handle(core: ReaderCore, m: ReaderRequest): Promise<void> {
    if (!('id' in m)) {
        if (m.op === 'abort') core.abort(m.gen);
        else if (m.op === 'adopted') core.adopted(m.gen);
        else core.releaseAdoptions();
        return;
    }
    try {
        let value: unknown;
        switch (m.op) {
            case 'prepare': core.prepare(m.gen, m.perm); break;
            case 'commit': core.commit(m.gen); break;
            case 'seed':
                core.seed(m.seed);
                if (m.candidate) core.prepare(m.candidate[0], m.candidate[1]);
                break;
            case 'getRows': value = await core.getRows(m.req, m.gen); break;
            case 'cellText':
                value = await core.getCellText(m.row, m.columnIndex, m.maxBytes, m.gen);
                break;
        }
        post({ type: 'reply', id: m.id, ok: true, value });
    } catch (err) {
        post({ type: 'reply', id: m.id, ok: false, error: errorPayload(err) });
    }
}

void main();
