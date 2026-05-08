/** Stale-file sweeper for the data viewer's per-extension storage
 *  directory. Lives in its own module so unit tests can import it
 *  without pulling in vscode. */

import * as fs from 'node:fs/promises';
import { join } from 'node:path';

export async function sweep_stale(
    dir: string,
    maxAgeMs: number,
    now: number = Date.now(),
): Promise<number> {
    let count = 0;
    let entries: string[] = [];
    try {
        entries = await fs.readdir(dir);
    } catch {
        return 0;
    }
    for (const name of entries) {
        const fp = join(dir, name);
        try {
            const st = await fs.stat(fp);
            if (st.isFile() && now - st.mtimeMs > maxAgeMs) {
                await fs.unlink(fp);
                count++;
            }
        } catch {
            /* ignore individual failures */
        }
    }
    return count;
}
