import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const siteDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "site",
);

export interface FixtureServer {
  origin: string;
  close(): Promise<void>;
  requests: Array<{ method: string; path: string }>;
  /** WebSocket upgrades received (path) and raw bytes received after the handshake. */
  sockets: Array<{ path: string; bytes: number }>;
}

function html(body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Dynamic</title></head><body>${body}</body></html>`;
}

/** Serves test/fixtures/site plus a few dynamic routes on an ephemeral loopback port. Tests only. */
export async function startFixtureServer(): Promise<FixtureServer> {
  const requests: Array<{ method: string; path: string }> = [];
  const sockets: Array<{ path: string; bytes: number }> = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    requests.push({ method: req.method ?? "GET", path: url.pathname });
    const to = url.searchParams.get("to") ?? "/";
    if (url.pathname === "/redirect") {
      res.writeHead(302, { location: to });
      res.end();
      return;
    }
    if (url.pathname === "/img-page") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        html(`<h1>Image page</h1><img alt="pic" src="/redirect?to=${encodeURIComponent(to)}">`),
      );
      return;
    }
    if (url.pathname === "/link-page") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        html(`<h1>Link page</h1><a href="/redirect?to=${encodeURIComponent(to)}">Sign in</a>`),
      );
      return;
    }
    if (url.pathname === "/ws-page") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        html(
          `<h1>Socket page</h1><script>const s = new WebSocket(${JSON.stringify(to)});` +
            `s.onopen = () => s.send("secret-payload");</script>`,
        ),
      );
      return;
    }
    if (url.pathname === "/slow") {
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    if (req.method === "POST") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><title>Sent</title><h1>Thanks, message sent</h1>");
      return;
    }
    const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = path.join(siteDir, path.basename(name));
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(body);
    } catch {
      res.writeHead(404, { "content-type": "text/html" });
      res.end("<!doctype html><title>Not found</title><h1>Not found</h1>");
    }
  });
  // Minimal WebSocket handshake: accept the upgrade and count bytes the client sends.
  const upgraded = new Set<import("node:stream").Duplex>();
  server.on("upgrade", (req, socket) => {
    upgraded.add(socket);
    socket.on("close", () => upgraded.delete(socket));
    const entry = { path: new URL(req.url ?? "/", "http://127.0.0.1").pathname, bytes: 0 };
    sockets.push(entry);
    const key = String(req.headers["sec-websocket-key"] ?? "");
    const accept = createHash("sha1")
      .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.on("data", (chunk: Buffer) => {
      entry.bytes += chunk.length;
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    sockets,
    close: () =>
      new Promise((resolve, reject) => {
        for (const socket of upgraded) socket.destroy();
        server.closeAllConnections();
        server.close((e) => (e ? reject(e) : resolve()));
      }),
  };
}
