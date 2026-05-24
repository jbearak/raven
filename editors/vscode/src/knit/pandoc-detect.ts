/**
 * Lazy Pandoc resolver. Probe order:
 *   1. `raven.pandoc.path` setting if set and accessible.
 *   2. `pandoc` on PATH (via `pandoc --version`).
 *   3. Platform-specific standard install paths.
 *
 * Cache is in-memory; cleared on `did_change_configuration` for any
 * `raven.pandoc.*` key (the extension wires that in `extension.ts`).
 * No persistent cache: PATH changes outside VS Code shouldn't yield
 * stale errors.
 */

export class PandocNotFoundError extends Error {
    constructor(message = 'Pandoc not found') {
        super(message);
        this.name = 'PandocNotFoundError';
    }
}

export interface PandocResolverDeps {
    /** Returns the configured `raven.pandoc.path` or `""` if unset. */
    getConfigured: () => string;
    /** `fs.promises.access(path, X_OK)`. Throws if missing/non-executable. */
    access: (path: string) => Promise<void>;
    /** Probe a binary by running `<bin> --version`. Resolves to trimmed stdout. */
    spawn: (bin: string) => Promise<string>;
    /** Optional override of platform fallback paths (for testing). */
    fallbacks?: () => string[];
}

export function defaultFallbacks(platform: NodeJS.Platform = process.platform): string[] {
    if (platform === 'darwin') {
        return [
            '/opt/homebrew/bin/pandoc',
            '/usr/local/bin/pandoc',
            '/Applications/RStudio.app/Contents/Resources/app/quarto/bin/tools/pandoc',
        ];
    }
    if (platform === 'win32') {
        const local = process.env.LOCALAPPDATA;
        const programFiles = process.env.PROGRAMFILES;
        const candidates: string[] = [];
        if (local) candidates.push(`${local}\\Pandoc\\pandoc.exe`);
        if (programFiles) candidates.push(`${programFiles}\\Pandoc\\pandoc.exe`);
        return candidates;
    }
    return ['/usr/bin/pandoc', '/usr/local/bin/pandoc'];
}

export class PandocResolver {
    private cached: string | null = null;

    constructor(private readonly deps: PandocResolverDeps) {}

    async resolve(): Promise<string> {
        if (this.cached) return this.cached;

        const configured = this.deps.getConfigured();
        if (configured) {
            // `access(X_OK)` only checks the executable bit — a user could
            // set `raven.pandoc.path` to `/bin/echo` and we'd happily hand
            // it to the export pipeline. Spawn `--version` so we cache a
            // path that actually behaves like pandoc. Mirrors the probe
            // already used for the bare-`pandoc`-on-PATH branch below.
            try {
                await this.deps.access(configured);
                await this.deps.spawn(configured);
                this.cached = configured;
                return configured;
            } catch {
                throw new PandocNotFoundError(`Configured pandoc path is unusable: ${configured}`);
            }
        }

        // Try bare `pandoc` on PATH.
        try {
            await this.deps.spawn('pandoc');
            this.cached = 'pandoc';
            return 'pandoc';
        } catch {
            // Fall through to platform fallbacks.
        }

        const fallbacks = (this.deps.fallbacks ?? defaultFallbacks)();
        for (const candidate of fallbacks) {
            try {
                await this.deps.access(candidate);
                await this.deps.spawn(candidate);
                this.cached = candidate;
                return candidate;
            } catch {
                continue;
            }
        }

        throw new PandocNotFoundError();
    }

    invalidate(): void {
        this.cached = null;
    }
}
