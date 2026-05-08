import { describe, test, expect } from 'bun:test';
import { generate_profile_source, build_terminal_env } from '../../editors/vscode/src/plot/r-bootstrap-profile';

const src = generate_profile_source();

describe('bootstrap profile: data viewer block', () => {
    test('contains the data viewer marker', () => {
        expect(src).toContain('# Raven data viewer block');
    });

    test('the data viewer block runs BEFORE the plot bridge', () => {
        const dvIdx = src.indexOf('# Raven data viewer block');
        const plotIdx = src.indexOf('httpgd::hgd');
        expect(dvIdx).toBeGreaterThan(-1);
        expect(plotIdx).toBeGreaterThan(-1);
        expect(dvIdx).toBeLessThan(plotIdx);
    });

    test('uses its own local({}) block', () => {
        const dvIdx = src.indexOf('# Raven data viewer block');
        const localAfter = src.indexOf('local({', dvIdx);
        const closeOfDvLocal = src.indexOf('\n})', localAfter);
        expect(localAfter).toBeGreaterThan(dvIdx);
        expect(closeOfDvLocal).toBeGreaterThan(localAfter);
        // Plot block's local({ should start after the data viewer block ends.
        const plotLocal = src.indexOf('local({', closeOfDvLocal);
        expect(plotLocal).toBeGreaterThan(closeOfDvLocal);
    });

    test('checks for the arrow package and skips when missing', () => {
        const dvIdx = src.indexOf('# Raven data viewer block');
        const slice = src.slice(dvIdx);
        expect(slice).toContain('requireNamespace("arrow"');
    });

    test('overrides View in globalenv', () => {
        const dvIdx = src.indexOf('# Raven data viewer block');
        const slice = src.slice(dvIdx);
        expect(slice).toContain('assign("View"');
        expect(slice).toContain('globalenv()');
    });

    test('errors with the Positron-style message for unsupported types', () => {
        expect(src).toContain("Can't `View()` an object of class");
    });

    test('truncates panelName to 256 chars with ellipsis', () => {
        const dvIdx = src.indexOf('# Raven data viewer block');
        const slice = src.slice(dvIdx);
        expect(slice).toContain('256');
    });

    test('POSTs /view-data with body shape sessionId/panelName/filePath/nrow', () => {
        const dvIdx = src.indexOf('# Raven data viewer block');
        const slice = src.slice(dvIdx);
        expect(slice).toContain('/view-data');
        expect(slice).toMatch(/sessionId/);
        expect(slice).toMatch(/panelName/);
        expect(slice).toMatch(/filePath/);
        expect(slice).toMatch(/nrow/);
        expect(slice).not.toMatch(/schemaJson/);
    });

    test('reads RAVEN_DATA_VIEWER_DIR from the env', () => {
        const dvIdx = src.indexOf('# Raven data viewer block');
        const slice = src.slice(dvIdx);
        expect(slice).toContain('RAVEN_DATA_VIEWER_DIR');
    });

    test('user .Rprofile is sourced exactly once at the top', () => {
        // Profile-source happens before either bridge marker.
        const userProfile = src.indexOf('RAVEN_ORIGINAL_R_PROFILE_USER');
        const dvIdx = src.indexOf('# Raven data viewer block');
        expect(userProfile).toBeGreaterThan(-1);
        expect(userProfile).toBeLessThan(dvIdx);
        // sys.source(...envir = globalenv()) only appears once
        const matches = (src.match(/sys\.source\(/g) ?? []).length;
        expect(matches).toBe(1);
    });
});

describe('build_terminal_env', () => {
    test('forwards data_viewer_dir into RAVEN_DATA_VIEWER_DIR', () => {
        const env = build_terminal_env({
            profile_path: '/tmp/p',
            session_port: 12345,
            session_token: 't',
            r_session_id: 's',
            previous_r_profile_user: undefined,
            data_viewer_dir: '/tmp/dv',
        });
        expect(env.RAVEN_DATA_VIEWER_DIR).toBe('/tmp/dv');
    });

    test('omits RAVEN_DATA_VIEWER_DIR (empty string) when not provided', () => {
        const env = build_terminal_env({
            profile_path: '/tmp/p',
            session_port: 12345,
            session_token: 't',
            r_session_id: 's',
            previous_r_profile_user: undefined,
        });
        expect(env.RAVEN_DATA_VIEWER_DIR).toBe('');
    });
});
