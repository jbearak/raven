import { describe, expect, test } from "bun:test";

import { socket_endpoint } from "../../editors/vscode/src/send-to-r/console-endpoint";

describe("socket_endpoint", () => {
  test("is the socket path itself off Windows", () => {
    expect(socket_endpoint("/tmp/raven-cAb1/s", "darwin")).toBe("/tmp/raven-cAb1/s");
  });

  // Same vector as `pipe_names_are_derived_from_the_path` in
  // crates/raven/src/console/local_socket.rs: the two must agree.
  test("is the pipe the console derives from the path on Windows", () => {
    expect(socket_endpoint("C:\\Users\\Ana Lí\\Temp\\raven-cAb1\\s", "win32")).toBe(
      "\\\\.\\pipe\\raven-C--Users-Ana-L--Temp-raven-cAb1-s",
    );
    expect(socket_endpoint("\\\\.\\pipe\\mine", "win32")).toBe("\\\\.\\pipe\\mine");
  });
});
