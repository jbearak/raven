import { describe, test, expect } from 'bun:test';
import { _sweep_and_dequeue_session } from '../../editors/vscode/src/send-to-r/pending-fifo';

describe('FIFO session dequeue', () => {
    test('returns first session id', () => {
        const q = [
            { sessionId: 'a', programName: 'R', generatedAtMs: 1000 },
            { sessionId: 'b', programName: 'R', generatedAtMs: 1500 },
        ];
        expect(_sweep_and_dequeue_session(q, 1500, 30_000)).toBe('a');
        expect(q.length).toBe(1);
        expect(q[0].sessionId).toBe('b');
    });

    test('sweeps stale entries before dequeue', () => {
        const q = [
            { sessionId: 'a', programName: 'R', generatedAtMs: 0 },
            { sessionId: 'b', programName: 'R', generatedAtMs: 50_000 },
        ];
        expect(_sweep_and_dequeue_session(q, 60_000, 30_000)).toBe('b');
        expect(q.length).toBe(0);
    });

    test('returns null for empty queue', () => {
        expect(_sweep_and_dequeue_session([], 0, 30_000)).toBeNull();
    });

    test('returns null when all entries are stale', () => {
        const q = [
            { sessionId: 'a', programName: 'R', generatedAtMs: 0 },
        ];
        expect(_sweep_and_dequeue_session(q, 100_000, 30_000)).toBeNull();
        expect(q.length).toBe(0);
    });
});
