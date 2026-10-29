/**
 * Where to connect for a Raven console socket path (`--ipc`/`--dap`).
 *
 * On Unix the path is the Unix socket itself. On Windows the console listens
 * on a named pipe whose name is derived from the path — this must match
 * `pipe_name` in `crates/raven/src/console/local_socket.rs` exactly — and
 * creates an empty file at the path once the pipe is listening, so "the path
 * exists" means "the console is listening" on every platform.
 */
export function socket_endpoint(socket_path: string, platform: string = process.platform): string {
    if (platform !== 'win32' || socket_path.startsWith('\\\\.\\pipe\\')) return socket_path;
    const mangled = Array.from(socket_path, (c) => (/^[A-Za-z0-9._-]$/.test(c) ? c : '-')).join('');
    return `\\\\.\\pipe\\raven-${mangled}`;
}
