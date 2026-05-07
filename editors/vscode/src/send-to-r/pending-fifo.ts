export type PendingProfileSession = {
    sessionId: string;
    programName: string;
    generatedAtMs: number;
};

export function _sweep_and_dequeue_session(
    queue: PendingProfileSession[],
    now_ms: number = Date.now(),
    ttl_ms: number = 30_000,
): string | null {
    while (queue.length > 0 && now_ms - queue[0].generatedAtMs > ttl_ms) {
        queue.shift();
    }
    return queue.length > 0 ? queue.shift()!.sessionId : null;
}
