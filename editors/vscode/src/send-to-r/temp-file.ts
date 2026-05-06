import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Long fallback only — primary cleanup is R's own on.exit(unlink(...)) inside
// the source() wrapper. This timer catches the case where R never reaches the
// source line at all (session crashed before reading it).
const CLEANUP_DELAY_MS = 120_000;
let counter = 0;

export function create_temp_file(content: string): string {
    const tmp_dir = os.tmpdir();
    const file_path = path.join(tmp_dir, `raven_send_${Date.now()}_${counter++}.R`);
    fs.writeFileSync(file_path, content, { encoding: 'utf8', mode: 0o600 });
    return file_path;
}

export function schedule_temp_file_cleanup(file_path: string): void {
    setTimeout(() => {
        try { fs.unlinkSync(file_path); } catch {}
    }, CLEANUP_DELAY_MS);
}
