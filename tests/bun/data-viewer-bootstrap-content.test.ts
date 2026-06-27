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

    test('defers the arrow package check until View is called', () => {
        const dvIdx = src.indexOf('# Raven data viewer block');
        const slice = src.slice(dvIdx);
        const viewIdx = slice.indexOf('.raven_view <- function');
        const arrowCheckIdx = slice.indexOf('requireNamespace("arrow"');
        const assignIdx = slice.indexOf('assign("View"');
        expect(viewIdx).toBeGreaterThan(-1);
        expect(arrowCheckIdx).toBeGreaterThan(viewIdx);
        expect(assignIdx).toBeGreaterThan(arrowCheckIdx);
    });

    test('missing arrow warns, notifies VS Code, and returns invisibly', () => {
        const dvIdx = src.indexOf('# Raven data viewer block');
        const slice = src.slice(dvIdx);
        expect(slice).toContain('warning(msg, call. = FALSE)');
        expect(slice).toContain('/data-viewer-warning');
        expect(slice).toContain('return(invisible(NULL))');
        expect(slice).not.toContain('stop("Raven data viewer requires');
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

    test('accepts atomic vectors / scalars / 1-D arrays via a !is.null + !is.raw + dim guard', () => {
        const dvIdx = src.indexOf('# Raven data viewer block');
        const slice = src.slice(dvIdx);
        // The vector branch must guard bare NULL (is.atomic(NULL) is TRUE on
        // R < 4.4) and raw (no NA for ragged padding). The dim guard admits
        // plain vectors (dim NULL) and 1-D arrays (dim length 1) but excludes
        // matrices and higher arrays.
        expect(slice).toContain('!is.null(x)');
        expect(slice).toContain('!is.raw(x)');
        expect(slice).toContain('length(dim(x)) <= 1L');
        expect(slice).toMatch(/is\.atomic\(x\).*is\.factor\(x\).*haven_labelled/s);
        // 1-D array normalization: carry dimnames to names, drop dim.
        expect(slice).toContain('dim(x) <- NULL');
    });

    test('lists report a content-specific reason; >2-D arrays report dimensions', () => {
        const dvIdx = src.indexOf('# Raven data viewer block');
        const slice = src.slice(dvIdx);
        // Empty and non-flat lists name the reason rather than the class.
        expect(slice).toContain("Can't `View()` an empty list.");
        expect(slice).toContain("Can't `View()` this list:");
        expect(slice).toContain('Only flat lists (every element a vector) are supported.');
        // Higher-dimensional arrays report their dimensionality, gated on
        // is.array so S4 dim() methods fall through to the generic message.
        expect(slice).toContain('the data viewer shows 2-dimensional tables only.');
        expect(slice).toMatch(/is\.array\(x\)\s*&&\s*length\(dim\(x\)\)\s*>\s*2L/);
    });

    test('names vector columns name + value(s); drops name column when unnamed', () => {
        const dvIdx = src.indexOf('# Raven data viewer block');
        const slice = src.slice(dvIdx);
        // Singular value header when length 1, else plural.
        expect(slice).toContain('"value"');
        expect(slice).toContain('"values"');
        // Leading names column headed "name".
        expect(slice).toContain('"name"');
        // The names column is conditional on names() being non-NULL.
        expect(slice).toMatch(/is\.null\(nm\)|is\.null\(names\(/);
    });

    test('accepts flat lists, excludes nested/recursive and raw elements', () => {
        const dvIdx = src.indexOf('# Raven data viewer block');
        const slice = src.slice(dvIdx);
        // Per-element acceptance check rejects list/data.frame/dim/raw.
        expect(slice).toMatch(/is\.list\(/);
        expect(slice).toContain('!is.raw(');
        // NA-padding via positional indexing (preserves class); make.unique
        // for column names.
        expect(slice).toMatch(/seq_len\(/);
        expect(slice).toContain('make.unique');
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

    test('checks RAVEN_DATA_VIEWER_DIR before installing the View override', () => {
        // The data viewer being disabled must not install Raven's View()
        // override.
        const dvIdx = src.indexOf('# Raven data viewer block');
        const slice = src.slice(dvIdx);
        const dirCheckIdx = slice.indexOf('RAVEN_DATA_VIEWER_DIR');
        const assignIdx = slice.indexOf('assign("View"');
        expect(dirCheckIdx).toBeGreaterThan(-1);
        expect(assignIdx).toBeGreaterThan(-1);
        expect(dirCheckIdx).toBeLessThan(assignIdx);
    });

    test('panelName truncation does not double-append the ellipsis', () => {
        // The truncate helper already appends "…" when truncating; the
        // caller must not wrap that result in another paste0 with another
        // "…" — that would produce a double ellipsis and push the title
        // past the advertised cap.
        const dvIdx = src.indexOf('# Raven data viewer block');
        const slice = src.slice(dvIdx);
        // Smoking gun: the verbatim text `.raven_truncate_utf8(s, 255L), "…")`
        // — i.e., truncate to 255 then paste an ellipsis on top.
        expect(slice).not.toContain(
            '.raven_truncate_utf8(s, 255L), "\\u2026")',
        );
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
