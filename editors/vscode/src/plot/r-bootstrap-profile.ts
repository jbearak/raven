import * as fs from 'fs/promises';
import * as path from 'path';

export const RAVEN_PROFILE_FILENAME = 'r-profile.R';

export type BuildEnvInputs = {
    profile_path: string;
    session_port: number;
    session_token: string;
    r_session_id: string;
    previous_r_profile_user: string | undefined;
};

export type RavenPlotEnv = {
    R_PROFILE_USER: string;
    RAVEN_ORIGINAL_R_PROFILE_USER: string;
    RAVEN_SESSION_PORT: string;
    RAVEN_SESSION_TOKEN: string;
    RAVEN_R_SESSION_ID: string;
};

export function build_terminal_env(inputs: BuildEnvInputs): RavenPlotEnv {
    return {
        R_PROFILE_USER: inputs.profile_path,
        RAVEN_ORIGINAL_R_PROFILE_USER: inputs.previous_r_profile_user ?? '',
        RAVEN_SESSION_PORT: String(inputs.session_port),
        RAVEN_SESSION_TOKEN: inputs.session_token,
        RAVEN_R_SESSION_ID: inputs.r_session_id,
    };
}

export async function write_profile_file(
    global_storage_dir: string,
    content: string,
): Promise<string> {
    await fs.mkdir(global_storage_dir, { recursive: true });
    const profile_path = path.join(global_storage_dir, RAVEN_PROFILE_FILENAME);
    const tmp_path = `${profile_path}.tmp.${process.pid}`;
    await fs.writeFile(tmp_path, content, { encoding: 'utf8' });
    try {
        await fs.rename(tmp_path, profile_path);
    } catch (err) {
        await fs.unlink(tmp_path).catch(() => undefined);
        throw err;
    }
    return profile_path;
}
