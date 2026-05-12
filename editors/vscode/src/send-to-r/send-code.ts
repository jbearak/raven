import * as vscode from 'vscode';
import { choose_send_transport, SendMethod } from './send-method';
import { create_temp_file, schedule_temp_file_cleanup } from './temp-file';

export interface SendOptions {
    sendMethod: SendMethod;
    autoTempFileThresholdLines: number;
}

export function get_send_options(): SendOptions {
    const config = vscode.workspace.getConfiguration('raven.sendToR');
    return {
        sendMethod: config.get<SendMethod>('sendMethod', 'auto'),
        autoTempFileThresholdLines: config.get<number>(
            'autoTempFileThresholdLines',
            25
        ),
    };
}

export function send_code(
    terminal: vscode.Terminal,
    code: string,
    options: SendOptions,
): void {
    const transport = choose_send_transport(
        code,
        options.sendMethod,
        options.autoTempFileThresholdLines,
    );
    switch (transport) {
        case 'direct-paste':
            terminal.sendText(code);
            return;
        case 'bracketed-paste':
            send_via_bracketed_paste(terminal, code);
            return;
        case 'tempfile':
            send_via_tempfile(terminal, code);
            return;
    }
}

function send_via_bracketed_paste(
    terminal: vscode.Terminal,
    code: string,
): void {
    terminal.sendText('\x1b[200~' + code + '\x1b[201~');
}

function send_via_tempfile(terminal: vscode.Terminal, code: string): void {
    const tmp = create_temp_file(code);
    // Have R unlink the script's per-call directory as part of consuming it,
    // so cleanup is tied to execution rather than a wall-clock timer. The JS
    // fallback below only runs if R never reaches the source() line (e.g.
    // session crashed).
    const path_literal = JSON.stringify(tmp);
    terminal.sendText(
        `local({ .raven_src <- ${path_literal}; on.exit(unlink(dirname(.raven_src), recursive = TRUE)); source(.raven_src, echo = TRUE) })`
    );
    schedule_temp_file_cleanup(tmp);
}
