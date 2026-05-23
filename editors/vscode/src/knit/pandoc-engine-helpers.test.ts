import { describe, it, expect } from 'bun:test';
import { chooseTempPath, interpretExitResult } from './pandoc-engine-helpers';

describe('chooseTempPath', () => {
    it('places the temp file next to the destination', () => {
        const t = chooseTempPath('/p/out.docx', { pid: 42, rand: 'abc' });
        // path.dirname is /p; the basename starts with a dot.
        const sep = t.includes('\\') ? '\\' : '/';
        expect(t.startsWith(`/p${sep}`) || t.startsWith('/p/')).toBe(true);
        expect(t).toMatch(/\.out\.docx\.42\.abc\.tmp$/);
    });

    it('uses the supplied rand suffix verbatim', () => {
        expect(chooseTempPath('/p/o.pdf', { pid: 7, rand: 'deadbeef' })).toBe('/p/.o.pdf.7.deadbeef.tmp');
    });
});

describe('interpretExitResult', () => {
    it('success on exit 0', () => {
        expect(interpretExitResult({ code: 0, signal: null, cancelled: false }).status).toBe('success');
    });
    it('cancelled when the cancelled flag is set', () => {
        expect(interpretExitResult({ code: null, signal: 'SIGINT', cancelled: true }).status).toBe('cancelled');
    });
    it('failure on non-zero exit code', () => {
        expect(interpretExitResult({ code: 1, signal: null, cancelled: false }).status).toBe('failure');
    });
    it('failure on signal termination not from cancel', () => {
        expect(interpretExitResult({ code: null, signal: 'SIGTERM', cancelled: false }).status).toBe('failure');
    });
});
