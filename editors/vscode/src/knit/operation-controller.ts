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

/**
 * Callback invoked when a preview directory's refcount drops to zero
 * *and* the dir has been marked for deletion. The registry runs the
 * callback inline from `unpinPreviewDir`; implementations should be
 * non-blocking (start an async rm, don't await).
 *
 * `previewDir` is the absolute path the registered handler should rm;
 * `previewKey` is provided for logging.
 */
export type PreviewDirDeleter = (previewDir: string, previewKey: string) => void;

export class OperationRegistry {
    private readonly ops = new Map<string, OperationController>();
    private readonly previewPins = new Map<string, number>();
    /** previewKey -> previewDir (absolute path), set on `requestPreviewDirDeletion`. */
    private readonly previewMarkedForDeletion = new Map<string, string>();
    private previewDeleter: PreviewDirDeleter | null = null;

    /**
     * Install the per-process callback that actually removes a preview
     * subdir from disk. Called once at activation. Idempotent in the
     * sense that re-installing is fine, but should never be necessary.
     */
    setPreviewDirDeleter(deleter: PreviewDirDeleter): void {
        this.previewDeleter = deleter;
    }

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
        if (next <= 0) {
            this.previewPins.delete(previewKey);
            // If the panel asked for deletion while exports held refs,
            // discharge it now that the last ref is gone.
            const dir = this.previewMarkedForDeletion.get(previewKey);
            if (dir !== undefined) {
                this.previewMarkedForDeletion.delete(previewKey);
                if (this.previewDeleter) this.previewDeleter(dir, previewKey);
            }
        } else {
            this.previewPins.set(previewKey, next);
        }
    }

    previewRefs(previewKey: string): number {
        return this.previewPins.get(previewKey) ?? 0;
    }

    /**
     * Request deletion of `previewKey`'s temp directory (`previewDir`).
     * The (key, dir) pair is always recorded first; the deleter then
     * fires on the next macrotask via `setTimeout(_, 0)`. The
     * macrotask window gives a new operation that pins immediately
     * after (e.g., a user closing the old panel and right-clicking
     * Knit Preview) a chance to call `pinPreviewDir` +
     * `cancelPreviewDirDeletion` before the unrecoverable `fs.rm`
     * starts. If a pin arrives during the window the deferred
     * deletion sees `previewRefs > 0` or a missing mark and bails.
     * The `unpinPreviewDir` path still discharges marked deletions
     * synchronously when the last pin is released — that path is
     * already covered by the existing pin/unpin lifecycle and stays
     * synchronous so refcount-driven tests don't have to await ticks.
     */
    requestPreviewDirDeletion(previewKey: string, previewDir: string): void {
        this.previewMarkedForDeletion.set(previewKey, previewDir);
        if (this.previewRefs(previewKey) > 0) return;
        setTimeout(() => {
            // Re-check both the pin count AND the mark: a pin that
            // arrived during the macrotask boundary may have called
            // `cancelPreviewDirDeletion`, or another deletion request
            // for a different (key, dir) pair may have superseded
            // this one (in which case the latest dir wins via the
            // existing "latest wins" contract documented above).
            if (this.previewRefs(previewKey) > 0) return;
            const dir = this.previewMarkedForDeletion.get(previewKey);
            if (dir === undefined) return;
            this.previewMarkedForDeletion.delete(previewKey);
            if (this.previewDeleter) this.previewDeleter(dir, previewKey);
        }, 0);
    }

    /**
     * Drop a deferred deletion request when the preview dir becomes live
     * again before the last pin is released, OR before the
     * `requestPreviewDirDeletion` macrotask window closes. Callers use
     * this only while they own a pin protecting the directory — once
     * the deferred fire has run, the rm has either completed or is in
     * flight (and `fs.rm` cannot be cancelled).
     */
    cancelPreviewDirDeletion(previewKey: string): void {
        this.previewMarkedForDeletion.delete(previewKey);
    }
}
