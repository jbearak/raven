import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const CLEANUP_DELAY_MS = 5000;

export function create_temp_file(content: string): string {
    const tmp_dir = os.tmpdir();
    const file_path = path.join(tmp_dir, `raven_send_${Date.now()}.R`);
    fs.writeFileSync(file_path, content, 'utf8');
    return file_path;
}

export function schedule_temp_file_cleanup(file_path: string): void {
    setTimeout(() => {
        try { fs.unlinkSync(file_path); } catch {}
    }, CLEANUP_DELAY_MS);
}
