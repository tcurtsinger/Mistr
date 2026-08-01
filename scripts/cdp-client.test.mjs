import { describe, expect, it } from "vitest";
import { CdpClient } from "./cdp-client.mjs";

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

function fakeSocket() {
  return {
    send() {},
    close() {},
    onmessage: null,
    onerror: null,
    onclose: null,
  };
}
