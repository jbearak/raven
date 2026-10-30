/**
 * Messages between the extension host and the data viewer's two threads
 * (`reader-thread.ts`, `scan-worker.ts`). Requests with an `id` get one
 * reply with the same `id`; the rest are one-way. Every permutation
 * travels as a `Uint32Array` over a `SharedArrayBuffer` (shared, never
 * transferred), and every cancellable request carries its own 4-byte
 * shared cancel flag.
 */
import type { GenerationSeed } from '../reader-core';
import type { TransformRequest, TransformSpec } from '../scan-core';
import type { ViewportRequest } from '../engine';

/** `workerData` for both threads. */
export type ThreadInit = {
    filePath: string;
    /** The shared memory counter (`MemoryCounter`). */
    counter: SharedArrayBuffer;
};

export type ReaderRequest =
    | { id: number; op: 'prepare'; gen: number; perm: Uint32Array | undefined }
    | { id: number; op: 'commit'; gen: number }
    | { id: number; op: 'seed'; seed: GenerationSeed; candidate?: [number, Uint32Array | undefined] }
    | { id: number; op: 'getRows'; req: ViewportRequest; gen: number | undefined }
    | { id: number; op: 'cellText'; row: number; columnIndex: number; maxBytes: number; gen: number | undefined }
    | { op: 'abort'; gen: number }
    | { op: 'adopted'; gen: number }
    | { op: 'releaseAdoptions' };

export type ScanRequest =
    | {
        id: number; op: 'compute'; gen: number; req: TransformRequest;
        partial: boolean; cancel: SharedArrayBuffer;
    }
    | { id: number; op: 'seed'; gen: number; spec: TransformSpec }
    | { id: number; op: 'nullCounts'; cancel: SharedArrayBuffer }
    | { id: number; op: 'histogram'; columnIndex: number; cancel: SharedArrayBuffer }
    | { op: 'commit'; gen: number; spec: TransformSpec }
    | { op: 'abort'; gen: number };

export type ThreadReply =
    | { type: 'ready' }
    | { type: 'openFailed'; error: string }
    | { type: 'reply'; id: number; ok: true; value: unknown }
    | { type: 'reply'; id: number; ok: false; error: { name: string; message: string } }
    | { type: 'progress'; id: number; value: unknown }
    | { type: 'log'; message: string };

/** An `AbortSignal`-shaped view of a shared cancel flag: aborted once the
 *  host stores a non-zero value. Read with `Atomics.load`, so a busy
 *  thread sees it without processing messages. */
export function sharedSignal(flag: SharedArrayBuffer): AbortSignal {
    const cell = new Int32Array(flag);
    return { get aborted() { return Atomics.load(cell, 0) !== 0; } } as AbortSignal;
}

export function errorPayload(err: unknown): { name: string; message: string } {
    if (typeof err === 'object' && err !== null) {
        const e = err as { name?: unknown; message?: unknown };
        return { name: String(e.name ?? 'Error'), message: String(e.message ?? err) };
    }
    return { name: 'Error', message: String(err) };
}
