import { describe, test, expect } from 'bun:test';
import {
    build_terminal_env,
    RAVEN_PROFILE_FILENAME,
} from '../../editors/vscode/src/plot/r-bootstrap-profile';

describe('build_terminal_env', () => {
    test('returns required keys', () => {
        const env = build_terminal_env({
            profile_path: '/tmp/raven-profile.R',
            session_port: 5555,
            session_token: 'a'.repeat(64),
            r_session_id: 'sid-1',
            previous_r_profile_user: '/home/u/.Rprofile.original',
        });
        expect(env.R_PROFILE_USER).toBe('/tmp/raven-profile.R');
        expect(env.RAVEN_ORIGINAL_R_PROFILE_USER).toBe('/home/u/.Rprofile.original');
        expect(env.RAVEN_SESSION_PORT).toBe('5555');
        expect(env.RAVEN_SESSION_TOKEN).toBe('a'.repeat(64));
        expect(env.RAVEN_R_SESSION_ID).toBe('sid-1');
    });

    test('sets RAVEN_ORIGINAL_R_PROFILE_USER to empty string when previous is undefined', () => {
        const env = build_terminal_env({
            profile_path: '/tmp/raven-profile.R',
            session_port: 1,
            session_token: 'tok',
            r_session_id: 'sid',
            previous_r_profile_user: undefined,
        });
        expect(env.RAVEN_ORIGINAL_R_PROFILE_USER).toBe('');
    });

    test('exports a stable profile filename', () => {
        expect(RAVEN_PROFILE_FILENAME).toBe('r-profile.R');
    });
});
