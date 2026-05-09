export type SendMethod = 'auto' | 'paste' | 'tempfile';
export type SendTransport = 'direct-paste' | 'bracketed-paste' | 'tempfile';

export function choose_send_transport(
    code: string,
    sendMethod: SendMethod,
    autoTempFileThresholdLines: number,
): SendTransport {
    const normalized = sendMethod === 'paste' || sendMethod === 'tempfile'
        ? sendMethod
        : 'auto';

    if (normalized === 'tempfile') {
        return 'tempfile';
    }

    const n_lines = code.split('\n').length;

    if (normalized === 'paste') {
        return n_lines > 1 ? 'bracketed-paste' : 'direct-paste';
    }

    const threshold = Math.max(1, Math.floor(autoTempFileThresholdLines));
    if (n_lines >= threshold) {
        return 'tempfile';
    }
    if (n_lines > 1) {
        return 'bracketed-paste';
    }
    return 'direct-paste';
}
