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
}

/** Serves test/fixtures/site on an ephemeral loopback port. Tests only. */
export async function startFixtureServer(): Promise<FixtureServer> {
  const requests: Array<{ method: string; path: string }> = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    requests.push({ method: req.method ?? "GET", path: url.pathname });
    if (req.method === "POST") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><title>Sent</title><h1>Thanks, message sent</h1>");
      return;
    }
    if (url.pathname === "/slow") {
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
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
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
