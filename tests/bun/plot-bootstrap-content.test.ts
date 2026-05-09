import { describe, test, expect } from 'bun:test';
import { generate_profile_source } from '../../editors/vscode/src/plot/r-bootstrap-profile';

describe('generate_profile_source', () => {
    const src = generate_profile_source();

    test('starts profile by sourcing the original R profile candidate', () => {
        expect(src).toMatch(/RAVEN_ORIGINAL_R_PROFILE_USER/);
        expect(src).toMatch(/Sys\.getenv\("RAVEN_ORIGINAL_R_PROFILE_USER"\)/);
        expect(src).toMatch(/\.Rprofile/);
    });

    test('runs Raven bootstrap inside local()', () => {
        expect(src).toMatch(/local\(\{[\s\S]*\}\)/);
    });

    test('checks httpgd is installed and version is at least 2.0.2', () => {
        expect(src).toMatch(/requireNamespace\("httpgd"/);
        expect(src).toMatch(/packageVersion\("httpgd"\) >= "2\.0\.2"/);
    });

    test('retries plot bridge initialization after outdated httpgd is updated', () => {
        const retry_helper = src.match(
            /\.raven_register_httpgd_retry <- function\(\.raven_original_device\) \{[\s\S]*?\n    \}/,
        )?.[0];
        const outdated_branch = src.match(
            /if \(!\(utils::packageVersion\("httpgd"\) >= "2\.0\.2"\)\) \{[\s\S]*?return\(invisible\(NULL\)\)\n    \}/,
        )?.[0];

        expect(retry_helper).toBeDefined();
        expect(retry_helper).toContain('addTaskCallback(function(...)');
        expect(retry_helper).toContain(
            'if (!(utils::packageVersion("httpgd") >= "2.0.2")) return(TRUE)',
        );
        expect(retry_helper).toContain(
            'options(device = .raven_original_device)',
        );
        expect(retry_helper).toContain('.raven_init_httpgd()');
        expect(retry_helper).toContain('name = "raven-httpgd-pending"');

        expect(outdated_branch).toBeDefined();
        expect(outdated_branch).toContain(
            '.raven_original_device <- .raven_deferred_warn',
        );
        expect(outdated_branch).toContain(
            '.raven_register_httpgd_retry(.raven_original_device)',
        );
    });

    test('starts httpgd::hgd with localhost host and ephemeral port', () => {
        expect(src).toMatch(/httpgd::hgd\(/);
        expect(src).toMatch(/host = "127\.0\.0\.1"/);
        expect(src).toMatch(/port = 0/);
        expect(src).toMatch(/token = TRUE/);
        expect(src).toMatch(/silent = TRUE/);
    });

    test('reads endpoint via httpgd::hgd_details()', () => {
        expect(src).toMatch(/httpgd::hgd_details\(\)/);
    });

    test('installs an addTaskCallback that POSTs plot-available', () => {
        expect(src).toMatch(/addTaskCallback/);
        expect(src).toMatch(/plot-available/);
        expect(src).toMatch(/httpgd::hgd_url\(endpoint = "state"\)/);
    });

    test('uses httpgd::hgd_url for state polling (not hgd_state which was removed in httpgd 2.0)', () => {
        expect(src).toMatch(/httpgd::hgd_url\(endpoint = "state"\)/);
        expect(src).not.toMatch(/hgd_state/);
    });

    test('POSTs session-ready', () => {
        expect(src).toMatch(/session-ready/);
    });

    test('uses base R socketConnection for the POST helper', () => {
        expect(src).toMatch(/socketConnection\(/);
    });

    test('reads RAVEN_SESSION_PORT and RAVEN_SESSION_TOKEN from env', () => {
        expect(src).toMatch(/Sys\.getenv\("RAVEN_SESSION_PORT"\)/);
        expect(src).toMatch(/Sys\.getenv\("RAVEN_SESSION_TOKEN"\)/);
    });

    test('uses Raven: prefix for console messages', () => {
        expect(src).toMatch(/Raven:\s/);
    });
});
