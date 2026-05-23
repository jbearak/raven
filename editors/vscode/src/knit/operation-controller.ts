/**
 * Per-source operation controller + registry.
 *
 * Replaces `knit-commands.ts`'s legacy `Set<string>` of in-flight knit
 * source paths. The export feature needs richer state:
 *   - The toolbar needs to know whether knit, export, or knit-then-
 *     export is running (`kind`) and which phase (`phase`).
 *   - The webview needs to display the spinner and disable buttons.
 *   - `cancelExport` messages from the webview need a handle to call
 *     into.
 *
 * Registry contract (closes Codex finding P2-1):
 *   - Canonical key: `canonicalOpKey(uri)` (normalized fsPath, lower-
 *     cased on Windows). The same `.Rmd` opened under different URI
 *     shapes collapses to one controller.
 *   - Caller MUST call `registry.beginOp(key, kind)` synchronously,
 *     before its first `await`. Two concurrent command invocations
 *     thus cannot both pass the empty-registry check.
 *   - One controller per key at a time; new ops on the same key must
 *     `existing.cancel()` and await its completion before inserting.
 *
 * `pinPreviewDir` / `unpinPreviewDir` refcount the preview temp
 * subdir while in-flight exports reference it, so panel disposal
 * doesn't yank the `.md` out from under Pandoc.
 */

export type OpKind =
    | 'knit-preview'
    | 'export-html'
    | 'export-pdf'
    | 'export-docx'
    | 'knit-then-export';

export type OpPhase = 'starting' | 'knitting' | 'converting' | 'finalizing' | 'done' | 'cancelled';

export interface OperationController {
    readonly key: string;
    readonly kind: OpKind;
    /** Current phase. Mutated only via `updatePhase`. */
    phase: OpPhase;
    /** Set true by `cancel()`; subprocess watchers check this in tight loops. */
    cancelled: boolean;
    /** Listener registered via `BeginOpOptions.broadcast`, or a no-op. */
    broadcast: (phase: OpPhase) => void;
    /** Mutate phase and broadcast. */
    updatePhase(p: OpPhase): void;
    /** Mark cancel; does NOT remove from registry — caller still calls endOp. */
    cancel(): void;
}

export type BeginOpResult =
    | { kind: 'started'; controller: OperationController }
    | { kind: 'busy'; existing: OperationController };

export interface BeginOpOptions {
    broadcast?: (p: OpPhase) => void;
}

export class OperationRegistry {
    private readonly ops = new Map<string, OperationController>();
    private readonly previewPins = new Map<string, number>();

    beginOp(key: string, kind: OpKind, opts: BeginOpOptions = {}): BeginOpResult {
        const existing = this.ops.get(key);
        if (existing) return { kind: 'busy', existing };

        const broadcast = opts.broadcast ?? (() => {});
        const controller: OperationController = {
            key,
            kind,
            phase: 'starting',
            cancelled: false,
            broadcast,
            updatePhase(p: OpPhase) {
                this.phase = p;
                this.broadcast(p);
            },
            cancel() {
                this.cancelled = true;
            },
        };
        controller.broadcast('starting');
        this.ops.set(key, controller);
        return { kind: 'started', controller };
    }

    endOp(controller: OperationController, finalPhase: 'done' | 'cancelled'): void {
        if (this.ops.get(controller.key) !== controller) return;
        controller.phase = finalPhase;
        controller.broadcast(finalPhase);
        this.ops.delete(controller.key);
    }

    current(key: string): OperationController | undefined {
        return this.ops.get(key);
    }

    pinPreviewDir(previewKey: string): void {
        this.previewPins.set(previewKey, (this.previewPins.get(previewKey) ?? 0) + 1);
    }

    unpinPreviewDir(previewKey: string): void {
        const next = (this.previewPins.get(previewKey) ?? 0) - 1;
        if (next <= 0) this.previewPins.delete(previewKey);
        else this.previewPins.set(previewKey, next);
    }

    previewRefs(previewKey: string): number {
        return this.previewPins.get(previewKey) ?? 0;
    }
}
