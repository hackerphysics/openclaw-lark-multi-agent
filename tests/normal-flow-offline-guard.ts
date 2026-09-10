import net from "node:net";
// Hard boundary independent of Vitest mocks (including the two-SDK symlink case).
// No test in the regression suite may open localhost OR external TCP connections.
Object.defineProperty(net.Socket.prototype, "connect", {
  configurable: true,
  value() { throw new Error("OFFLINE NORMAL-FLOW TEST: real sockets are forbidden"); },
});
globalThis.fetch = (() => { throw new Error("OFFLINE NORMAL-FLOW TEST: real fetch is forbidden"); }) as typeof fetch;
