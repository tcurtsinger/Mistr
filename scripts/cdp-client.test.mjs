import { describe, expect, it } from "vitest";
import {
  CdpClient,
  fetchJsonWithTimeout,
  openWebSocketWithTimeout,
} from "./cdp-client.mjs";

describe("bounded CDP requests", () => {
  it("rejects a request that receives no response", async () => {
    const socket = fakeSocket();
    const client = new CdpClient(socket, 5);

    await expect(client.call("Runtime.evaluate")).rejects.toThrow(
      "Runtime.evaluate timed out after 5 ms",
    );
  });

  it.each([
    ["error", "CDP socket error"],
    ["close", "CDP socket closed"],
  ])("rejects pending requests when the socket emits %s", async (event, message) => {
    const socket = fakeSocket();
    const client = new CdpClient(socket);
    const pending = client.call("Page.captureScreenshot");

    socket[`on${event}`]();

    await expect(pending).rejects.toThrow(message);
  });
});

describe("bounded CDP WebSocket handshake", () => {
  it("rejects a handshake that never opens", async () => {
    const socket = fakeSocket();
    await expect(openWebSocketWithTimeout(socket, 5)).rejects.toThrow(
      "CDP WebSocket handshake timed out after 5 ms",
    );
  });

  it("rejects a clean close before the handshake opens", async () => {
    const socket = fakeSocket();
    const pending = openWebSocketWithTimeout(socket);

    socket.onclose();

    await expect(pending).rejects.toThrow(
      "CDP WebSocket closed before the handshake completed",
    );
  });
});

describe("bounded CDP target discovery", () => {
  it("aborts a fetch whose HTTP response never completes", async () => {
    const stalledFetch = (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });

    await expect(fetchJsonWithTimeout("http://127.0.0.1/json", 5, stalledFetch))
      .rejects.toThrow("HTTP request timed out after 5 ms");
  });
});

function fakeSocket() {
  return {
    send() {},
    close() {},
    onmessage: null,
    onerror: null,
    onclose: null,
  };
}
