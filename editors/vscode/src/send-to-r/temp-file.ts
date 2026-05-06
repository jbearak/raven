import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Long fallback only — primary cleanup is R's own on.exit(unlink(...)) inside
// the source() wrapper. This timer catches the case where R never reaches the
// source line at all (session crashed before reading it).
const CLEANUP_DELAY_MS = 120_000;

export function create_temp_file(content: string): string {
    // mkdtempSync creates a directory with mode 0o700 (POSIX) and an
    // unpredictable random suffix, eliminating the symlink-race vector on
    // legacy Linux kernels without fs.protected_symlinks. The script lives
    // inside the per-call directory so callers (and R) can clean both up.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raven_send_'));
    const file_path = path.join(dir, 'src.R');
    fs.writeFileSync(file_path, content, { encoding: 'utf8', mode: 0o600 });
    return file_path;
}

export function schedule_temp_file_cleanup(file_path: string): void {
    setTimeout(() => {
        try { fs.unlinkSync(file_path); } catch {}
        try { fs.rmdirSync(path.dirname(file_path)); } catch {}
    }, CLEANUP_DELAY_MS);
}
