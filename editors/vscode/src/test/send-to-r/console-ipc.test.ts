import * as assert from 'assert';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    forget_console_terminal,
    make_console_socket_path,
    register_console_terminal,
} from '../../send-to-r/console-ipc';
import { send_code } from '../../send-to-r/send-code';

/** A terminal stand-in that records what would have been typed. */
function fake_terminal(): { terminal: vscode.Terminal; typed: string[] } {
    const typed: string[] = [];
    const terminal = { sendText: (text: string) => typed.push(text) } as unknown as vscode.Terminal;
    return { terminal, typed };
}

const OPTIONS = { sendMethod: 'paste' as const, autoTempFileThresholdLines: 25 };

suite('Raven console socket sends', () => {
    if (process.platform === 'win32') return;

    test('not a Raven console: types the code, synchronously', () => {
        const { terminal, typed } = fake_terminal();
        send_code(terminal, 'x <- 1', OPTIONS);
        assert.deepStrictEqual(typed, ['x <- 1']);
    });

    test('a starting console gets the code once it listens, never typed', async () => {
        const { terminal, typed } = fake_terminal();
        const socket = make_console_socket_path(); // directory exists, socket not yet
        register_console_terminal(terminal, socket);
        const received: string[] = [];
        const server = net.createServer((conn) => {
            conn.setEncoding('utf8');
            conn.on('data', (chunk: string) => {
                for (const line of chunk.split('\n').filter(Boolean)) {
                    const msg = JSON.parse(line) as { id: number; code: string };
                    received.push(msg.code);
                    conn.write(JSON.stringify({ id: msg.id, status: 'queued' }) + '\n');
                }
            });
        });
        try {
            send_code(terminal, 'early <- 1', OPTIONS);
            assert.deepStrictEqual(typed, [], 'nothing typed while the console starts');
            await new Promise((r) => setTimeout(r, 200));
            await new Promise<void>((resolve) => server.listen(socket, resolve));
            for (let i = 0; i < 100 && received.length === 0; i++) {
                await new Promise((r) => setTimeout(r, 20));
            }
            assert.deepStrictEqual(received, ['early <- 1']);
            assert.deepStrictEqual(typed, []);
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            forget_console_terminal(terminal);
        }
    });

    test('console listening: code goes over the socket, nothing is typed', async () => {
        const { terminal, typed } = fake_terminal();
        const socket = make_console_socket_path();
        const received: unknown[] = [];
        const server = net.createServer((conn) => {
            conn.setEncoding('utf8');
            conn.on('data', (chunk: string) => {
                for (const line of chunk.split('\n').filter(Boolean)) {
                    const msg = JSON.parse(line) as { id: number };
                    received.push(msg);
                    conn.write(JSON.stringify({ id: msg.id, status: 'queued' }) + '\n');
                }
            });
        });
        await new Promise<void>((resolve) => server.listen(socket, resolve));
        register_console_terminal(terminal, socket);
        try {
            send_code(terminal, 'a <- 1\nb <- 2', OPTIONS);
            for (let i = 0; i < 100 && received.length === 0; i++) {
                await new Promise((r) => setTimeout(r, 20));
            }
            assert.strictEqual(received.length, 1);
            const msg = received[0] as { v: number; op: string; code: string };
            assert.strictEqual(msg.v, 1);
            assert.strictEqual(msg.op, 'execute');
            assert.strictEqual(msg.code, 'a <- 1\nb <- 2');
            assert.deepStrictEqual(typed, []);
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            forget_console_terminal(terminal);
        }
    });

    test('quick successive sends reach the console in order', async () => {
        const { terminal } = fake_terminal();
        const socket = make_console_socket_path();
        const events: string[] = [];
        let first = true;
        const server = net.createServer((conn) => {
            conn.setEncoding('utf8');
            conn.on('data', (chunk: string) => {
                for (const line of chunk.split('\n').filter(Boolean)) {
                    const msg = JSON.parse(line) as { id: number; code: string };
                    events.push(`got ${msg.code}`);
                    // Acknowledge the first request slowly: the second send
                    // must not overtake it.
                    const delay = first ? 150 : 0;
                    first = false;
                    setTimeout(() => {
                        events.push(`ack ${msg.code}`);
                        conn.write(JSON.stringify({ id: msg.id, status: 'queued' }) + '\n');
                    }, delay);
                }
            });
        });
        await new Promise<void>((resolve) => server.listen(socket, resolve));
        register_console_terminal(terminal, socket);
        try {
            send_code(terminal, 'x <- 1', OPTIONS);
            send_code(terminal, 'print(x)', OPTIONS);
            for (let i = 0; i < 100 && events.length < 4; i++) {
                await new Promise((r) => setTimeout(r, 20));
            }
            assert.deepStrictEqual(events, ['got x <- 1', 'ack x <- 1', 'got print(x)', 'ack print(x)']);
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            forget_console_terminal(terminal);
        }
    });

    test('socket paths fit the macOS sun_path limit and live in a private directory', () => {
        const socket = make_console_socket_path();
        try {
            assert.ok(Buffer.byteLength(socket) < 104, socket);
            assert.strictEqual(fs.statSync(path.dirname(socket)).mode & 0o777, 0o700);
        } finally {
            fs.rmSync(path.dirname(socket), { recursive: true, force: true });
        }
    });
});
