import net from "node:net";
// Hard boundary independent of Vitest mocks (including the two-SDK symlink case).
// No test in this focused run may open localhost OR external TCP connections.
Object.defineProperty(net.Socket.prototype, "connect", {
  configurable: true,
  value() { throw new Error("OFFLINE QUESTION TEST: real sockets are forbidden"); },
});
globalThis.fetch = (() => { throw new Error("OFFLINE QUESTION TEST: real fetch is forbidden"); }) as typeof fetch;
