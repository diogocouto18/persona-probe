import { describe, expect, it } from "vitest";
import { looksLikeDevServerSocket } from "../src/browser.js";

describe("looksLikeDevServerSocket", () => {
  it.each([
    "ws://localhost:3000/_next/webpack-hmr",
    "ws://localhost:3000/_next/hmr?id=abc",
    "ws://localhost:8080/sockjs-node/123/abc/websocket",
    "ws://localhost:5173/?token=abc123",
    "ws://localhost:4321/@vite/client",
  ])("recognises %s", (url) => {
    expect(looksLikeDevServerSocket(url)).toBe(true);
  });

  it.each([
    "ws://localhost:3000/live",
    "ws://localhost:3000/socket.io/?EIO=4&transport=websocket",
    "wss://example.com/chat",
    "not a url",
  ])("does not flag %s", (url) => {
    expect(looksLikeDevServerSocket(url)).toBe(false);
  });
});
