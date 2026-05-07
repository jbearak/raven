export type SendMethod = 'auto' | 'paste' | 'tempfile';
export type SendTransport = 'direct-paste' | 'bracketed-paste' | 'tempfile';

export function choose_send_transport(
    code: string,
    sendMethod: SendMethod,
): SendTransport {
    const normalized = sendMethod === 'paste' || sendMethod === 'tempfile'
        ? sendMethod
        : 'auto';

    if (normalized === 'tempfile') {
        return 'tempfile';
    }

    const is_multiline = code.includes('\n');
    if (normalized === 'paste' && is_multiline) {
        return 'bracketed-paste';
    }

    if (normalized === 'auto' && is_multiline) {
        return 'tempfile';
    }

    return 'direct-paste';
}
