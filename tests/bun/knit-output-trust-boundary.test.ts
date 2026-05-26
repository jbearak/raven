import { describe, it, expect } from 'bun:test';
import { isKnitOutputMessage } from '../../editors/vscode/src/knit/knit-output';

describe('isKnitOutputMessage — webview trust boundary', () => {
    it('accepts {type: refresh}', () => {
        expect(isKnitOutputMessage({ type: 'refresh' })).toBe(true);
    });
    it('rejects extra keys on no-payload types', () => {
        expect(isKnitOutputMessage({ type: 'refresh', x: 1 })).toBe(false);
        expect(isKnitOutputMessage({ type: 'cancelExport', signal: 'SIGKILL' })).toBe(false);
    });
    it('accepts requestExport with each whitelisted format', () => {
        // The webview owns the format-choice UI (HTML popover); the
        // format value crosses the trust boundary in `format` and is
        // validated against the EXPORT_FORMATS whitelist before the
        // host dispatches the matching `raven.knit.export*` command.
        expect(isKnitOutputMessage({ type: 'requestExport', format: 'html' })).toBe(true);
        expect(isKnitOutputMessage({ type: 'requestExport', format: 'pdf' })).toBe(true);
        expect(isKnitOutputMessage({ type: 'requestExport', format: 'docx' })).toBe(true);
    });
    it('rejects requestExport with a missing or unsupported format', () => {
        expect(isKnitOutputMessage({ type: 'requestExport' })).toBe(false);
        expect(isKnitOutputMessage({ type: 'requestExport', format: '' })).toBe(false);
        expect(isKnitOutputMessage({ type: 'requestExport', format: '../etc/passwd' })).toBe(false);
        expect(isKnitOutputMessage({ type: 'requestExport', format: 'HTML' })).toBe(false);
        expect(isKnitOutputMessage({ type: 'requestExport', format: 'epub' })).toBe(false);
    });
    it('rejects requestExport with non-string format or extra keys', () => {
        expect(isKnitOutputMessage({ type: 'requestExport', format: 1 })).toBe(false);
        expect(isKnitOutputMessage({ type: 'requestExport', format: true })).toBe(false);
        expect(isKnitOutputMessage({ type: 'requestExport', format: null })).toBe(false);
        expect(
            isKnitOutputMessage({ type: 'requestExport', format: 'html', extra: 1 }),
        ).toBe(false);
    });
    it('accepts {type: cancelExport}', () => {
        expect(isKnitOutputMessage({ type: 'cancelExport' })).toBe(true);
    });
    it('accepts themeChanged with applied: boolean', () => {
        expect(isKnitOutputMessage({ type: 'themeChanged', applied: true })).toBe(true);
        expect(isKnitOutputMessage({ type: 'themeChanged', applied: false })).toBe(true);
    });
    it('rejects themeChanged with missing applied', () => {
        expect(isKnitOutputMessage({ type: 'themeChanged' })).toBe(false);
    });
    it('rejects themeChanged with non-boolean applied', () => {
        expect(isKnitOutputMessage({ type: 'themeChanged', applied: 'yes' })).toBe(false);
    });
    it('rejects themeChanged with extra keys', () => {
        expect(isKnitOutputMessage({ type: 'themeChanged', applied: true, extra: 1 })).toBe(false);
    });
    it('accepts themeContext with editorBackground string', () => {
        expect(isKnitOutputMessage({ type: 'themeContext', editorBackground: '#fff' })).toBe(true);
    });
    it('rejects themeContext with non-string editorBackground', () => {
        expect(isKnitOutputMessage({ type: 'themeContext', editorBackground: 123 })).toBe(false);
    });
    it('accepts requestPalette and requestFonts no-payload', () => {
        expect(isKnitOutputMessage({ type: 'requestPalette' })).toBe(true);
        expect(isKnitOutputMessage({ type: 'requestFonts' })).toBe(true);
    });
    it('rejects unknown type', () => {
        expect(isKnitOutputMessage({ type: 'nope' })).toBe(false);
    });
    it('rejects non-objects', () => {
        expect(isKnitOutputMessage(null)).toBe(false);
        expect(isKnitOutputMessage('hi')).toBe(false);
        expect(isKnitOutputMessage(42)).toBe(false);
    });
});
