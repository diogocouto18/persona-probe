import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { BrowserSession, type SessionConfig } from "../src/browser.js";
import type { Persona } from "../src/personas.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

// The "evil" server shares the target's host but not its port: the hardest case,
// since host-level blocking cannot tell them apart.
let target: FixtureServer;
let evil: FixtureServer;
let session: BrowserSession | undefined;

const persona: Persona = {
  name: "first-timer",
  title: "First-time visitor",
  goal: "Explore",
  input: ["mouse", "keyboard"],
  viewport: { width: 1280, height: 800 },
  touch: false,
  reducedMotion: false,
  stepBudget: 40,
  brief: "brief",
};

function config(over: Partial<SessionConfig> = {}): SessionConfig {
  return {
    target: new URL(target.origin),
    allowOrigins: [],
    allowWrites: false,
    allowWritePaths: [],
    ...over,
  };
}

function refFor(snapshot: string, role: string, name: string): string {
  const ref = snapshot
    .split("\n")
    .find((l) => l.includes(`${role} "${name}"`))
    ?.match(/\[ref=([a-z0-9]+)\]/)?.[1];
  if (!ref) throw new Error(`no ref for ${role} "${name}"`);
  return ref;
}

const evilHits = () => evil.requests.length + evil.sockets.length;
const settle = () => new Promise((resolve) => setTimeout(resolve, 800));

beforeAll(async () => {
  target = await startFixtureServer();
  evil = await startFixtureServer();
});
afterAll(async () => {
  await target.close();
  await evil.close();
});
afterEach(async () => {
  await session?.close();
  session = undefined;
  target.requests.length = 0;
  target.sockets.length = 0;
  evil.requests.length = 0;
  evil.sockets.length = 0;
});

describe("origin lock across redirects and sockets", () => {
  it("blocks a goto that redirects off-origin and stays on the target", async () => {
    session = await BrowserSession.start(persona, config());
    const to = encodeURIComponent(`${evil.origin}/login`);
    const result = await session.goto(`/redirect?to=${to}`);
    expect(result).toContain(`blocked: off-origin navigation to ${evil.origin}`);
    expect(session.url.startsWith(target.origin)).toBe(true);
    expect(evilHits()).toBe(0);
  });

  it("blocks a link whose same-origin target redirects off-origin", async () => {
    session = await BrowserSession.start(persona, config());
    await session.goto(`/link-page?to=${encodeURIComponent(`${evil.origin}/oauth`)}`);
    const result = await session.click(refFor(await session.snapshot(), "link", "Sign in"));
    expect(result).toContain("blocked: off-origin navigation");
    expect(session.url.startsWith(target.origin)).toBe(true);
    expect(evilHits()).toBe(0);
  });

  it("blocks multi-hop redirects that leave the origin on a later hop", async () => {
    session = await BrowserSession.start(persona, config());
    const offsite = `${evil.origin}/deep`;
    const hop = `/redirect?to=${encodeURIComponent(offsite)}`;
    await session.goto(`/redirect?to=${encodeURIComponent(hop)}`);
    expect(session.url.startsWith(target.origin)).toBe(true);
    expect(evilHits()).toBe(0);
  });

  it("follows same-origin redirects normally", async () => {
    session = await BrowserSession.start(persona, config());
    await session.goto(`/redirect?to=${encodeURIComponent("/about.html")}`);
    expect(session.url).toBe(`${target.origin}/about.html`);
  });

  it("blocks subresources that redirect off-origin", async () => {
    session = await BrowserSession.start(persona, config());
    const result = await session.goto(`/img-page?to=${encodeURIComponent(`${evil.origin}/t.png`)}`);
    await settle();
    expect(result).toContain(`blocked: off-origin request to ${evil.origin}`);
    expect(evilHits()).toBe(0);
  });

  it("refuses to start when the target root redirects off-origin", async () => {
    const start = BrowserSession.start(
      persona,
      config({
        target: new URL(`${target.origin}/redirect?to=${encodeURIComponent(evil.origin)}`),
      }),
    );
    await expect(start).rejects.toThrow(/redirects off-origin/);
    expect(evilHits()).toBe(0);
  });

  it("blocks off-origin WebSockets", async () => {
    session = await BrowserSession.start(persona, config());
    const wsUrl = `${evil.origin.replace("http", "ws")}/exfil`;
    const result = await session.goto(`/ws-page?to=${encodeURIComponent(wsUrl)}`);
    await settle();
    expect(evil.sockets).toHaveLength(0);
    expect(result + (await session.goto("/about.html"))).toContain(
      `blocked: off-origin websocket to ${evil.origin.replace("http", "ws")}`,
    );
  });

  it.each([false, true])(
    "keeps same-origin WebSockets away from the server (allowWrites=%s)",
    async (allowWrites) => {
      session = await BrowserSession.start(persona, config({ allowWrites }));
      const wsUrl = `${target.origin.replace("http", "ws")}/live`;
      const result = await session.goto(`/ws-page?to=${encodeURIComponent(wsUrl)}`);
      await settle();
      expect(target.sockets).toHaveLength(0);
      expect(result).toContain("blocked: websocket to /live (not supported)");
    },
  );
});
