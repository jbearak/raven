import { describe, test, expect } from 'bun:test';
import {
    createHelpStateMachine,
    type FetchResponse,
} from '../../editors/vscode/src/help/state-machine';

function okResponse(topic: string, pkg: string): FetchResponse {
    return {
        ok: true,
        topic,
        package: pkg,
        title: `${pkg}::${topic}`,
        html: `<p>${topic}</p>`,
        anchor: null,
        helpDir: `/lib/${pkg}/help`,
        libPaths: [`/lib`],
    };
}

describe('help state machine', () => {
    test('navigate pushes to back, clears forward', async () => {
        const fetch = async (t: string, p: string) => okResponse(t, p);
        const sm = createHelpStateMachine({ fetch });
        await sm.navigate('a', 'p');
        await sm.navigate('b', 'p');
        expect(sm.canBack()).toBe(true);
        expect(sm.canForward()).toBe(false);
        await sm.back();
        expect(sm.canForward()).toBe(true);
    });

    test('failed fetch does not mutate stacks', async () => {
        let okFetch = true;
        const fetch = async (t: string, p: string): Promise<FetchResponse> =>
            okFetch
                ? okResponse(t, p)
                : { ok: false, reason: 'not-found', message: 'no help' };
        const sm = createHelpStateMachine({ fetch });
        await sm.navigate('a', 'p');
        // After this, current is 'a', stacks empty
        expect(sm.canBack()).toBe(false);
        await sm.navigate('b', 'p');
        // Now current is 'b', back has 'a'
        expect(sm.canBack()).toBe(true);
        // Try to navigate to a failed fetch
        okFetch = false;
        await sm.navigate('c', 'p');
        // The failed fetch caused 'b' to be pushed to back, but no new current set;
        // Actually per spec: "Failures do not mutate stacks — the user stays on the
        // previous topic". So back should still have just 'a' (b stays as current),
        // and current should still be 'b'.
        // Note: the implementation MUST capture the pre-navigate state, then commit
        // only on success.
        expect(sm.canForward()).toBe(false);
        // After failure, going back from 'b' should still work — back-stack has 'a'.
        // Re-enable successful fetches so the back() navigation itself succeeds.
        okFetch = true;
        await sm.back();
        // Now current is 'a', forward has 'b'
        expect(sm.canForward()).toBe(true);
    });

    test('stale request id is dropped', async () => {
        let resolveFirst!: (r: FetchResponse) => void;
        const firstPromise = new Promise<FetchResponse>((resolve) => {
            resolveFirst = resolve;
        });
        let count = 0;
        const fetch = async (t: string, _p: string): Promise<FetchResponse> => {
            count += 1;
            if (count === 1) return firstPromise;
            return okResponse(t, 'p');
        };
        const loaded: Array<{ topic: string; package: string }> = [];
        const sm = createHelpStateMachine({
            fetch,
            onLoad: (load) => {
                loaded.push({ topic: load.topic, package: load.package });
            },
        });
        const slow = sm.navigate('slow', 'p');
        // Issue a second navigate while the first is still pending — supersedes.
        const fast = sm.navigate('fast', 'p');
        await fast;
        // Now resolve the slow one; its result should be dropped because its
        // request id is stale.
        resolveFirst(okResponse('slow', 'p'));
        await slow;
        // Only 'fast' should have been loaded.
        expect(loaded).toEqual([{ topic: 'fast', package: 'p' }]);
    });

    test('stack capped at 50', async () => {
        const fetch = async (t: string, p: string) => okResponse(t, p);
        const sm = createHelpStateMachine({ fetch });
        // Navigate 60 times — cap is 50.
        for (let i = 0; i < 60; i++) {
            await sm.navigate(`t${i}`, 'p');
        }
        // Now back-walk 50 times (cap), then expect canBack() to be false.
        for (let i = 0; i < 50; i++) {
            expect(sm.canBack()).toBe(true);
            await sm.back();
        }
        expect(sm.canBack()).toBe(false);
    });
});
