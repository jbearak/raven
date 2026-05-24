import { describe, test, expect } from 'bun:test';
import { CHUNK_LENS_COMMANDS } from '../../editors/vscode/src/chunks/chunk-commands';

describe('CHUNK_LENS_COMMANDS gates', () => {
    test('raven.runAboveChunks is gated on requires_previous_runnable', () => {
        // The Run Above lens has nothing to do when there are no chunks above
        // the current one. Mirror the gating pattern used by the sibling
        // lenses (Run Previous / Run Next) so the topmost runnable chunk
        // drops the lens rather than surfacing a useless button.
        const meta = CHUNK_LENS_COMMANDS['raven.runAboveChunks'];
        expect(meta).toBeDefined();
        expect(meta.gate).toBe('requires_previous_runnable');
    });

    test('raven.runBelowChunks is gated on requires_next_runnable', () => {
        // Symmetric to Run Above: with no chunks below the current one, the
        // Run Below button has nothing to do. Hide it on the bottommost
        // runnable chunk instead of surfacing a no-op button.
        const meta = CHUNK_LENS_COMMANDS['raven.runBelowChunks'];
        expect(meta).toBeDefined();
        expect(meta.gate).toBe('requires_next_runnable');
    });
});
