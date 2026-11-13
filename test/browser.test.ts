import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { BrowserSession, SNAPSHOT_CAP, ToolUseError, type SessionConfig } from "../src/browser.js";
import type { Persona } from "../src/personas.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

function persona(over: Partial<Persona> = {}): Persona {
  return {
    name: "first-timer",
    title: "First-time visitor",
    goal: "Explore",
    input: ["mouse", "keyboard"],
    viewport: { width: 1280, height: 800 },
    touch: false,
    reducedMotion: false,
    stepBudget: 40,
    brief: "brief",
    ...over,
  };
}

/** Finds the ref of an element in an AI-mode aria snapshot, e.g. link "About" [ref=e5]. */
function refFor(snapshot: string, role: string, name: string): string {
  const line = snapshot.split("\n").find((l) => l.includes(`${role} "${name}"`));
  const ref = line?.match(/\[ref=([a-z0-9]+)\]/)?.[1];
  if (!ref) throw new Error(`no ref for ${role} "${name}" in:\n${snapshot}`);
  return ref;
}

let server: FixtureServer;
let session: BrowserSession | undefined;

function config(over: Partial<SessionConfig> = {}): SessionConfig {
  return {
    target: new URL(server.origin),
    allowOrigins: [],
    allowWrites: false,
    allowWritePaths: [],
    ...over,
  };
}

beforeAll(async () => {
  server = await startFixtureServer();
});
afterAll(async () => {
  await server.close();
});
afterEach(async () => {
  await session?.close();
  session = undefined;
  server.requests.length = 0;
});

describe("BrowserSession", () => {
  it("opens the target and returns a labelled AI snapshot with refs and focus", async () => {
    session = await BrowserSession.start(persona(), config());
    const snap = await session.snapshot();
    expect(snap).toContain("[untrusted page content below]");
    expect(snap).toContain("Focused:");
    expect(snap).toContain("[ref=");
    expect(snap).toContain("Welcome to the fixture");
  });

  it("navigates within the site with click", async () => {
    session = await BrowserSession.start(persona(), config());
    const result = await session.click(refFor(await session.snapshot(), "link", "About"));
    expect(result).toContain("/about.html");
    expect(session.url).toContain("/about.html");
    expect(session.stepsUsed).toBe(1);
  });

  it("blocks form submissions while writes are off", async () => {
    session = await BrowserSession.start(persona(), config());
    const snap = await session.snapshot();
    await session.fill(refFor(snap, "textbox", "Name"), "Ana");
    const result = await session.click(refFor(snap, "button", "Send"));
    expect(result).toContain("blocked: write POST /api/contact");
    expect(server.requests.some((r) => r.method === "POST")).toBe(false);
  });

  it("lets form submissions through with allowWrites", async () => {
    session = await BrowserSession.start(persona(), config({ allowWrites: true }));
    const snap = await session.snapshot();
    await session.click(refFor(snap, "button", "Send"));
    expect(server.requests.some((r) => r.method === "POST" && r.path === "/api/contact")).toBe(
      true,
    );
  });

  it("blocks off-origin navigation from links and scripts", async () => {
    session = await BrowserSession.start(persona(), config());
    const snap = await session.snapshot();
    const viaLink = await session.click(refFor(snap, "link", "External site"));
    expect(viaLink).toContain("blocked: off-origin");
    expect(session.url.startsWith(server.origin)).toBe(true);
    const viaScript = await session.click(
      refFor(await session.snapshot(), "button", "Go external"),
    );
    expect(viaScript).toContain("blocked: off-origin");
    expect(session.url.startsWith(server.origin)).toBe(true);
  });

  it("enforces persona input modes", async () => {
    session = await BrowserSession.start(persona({ input: ["keyboard"] }), config());
    const snap = await session.snapshot();
    await expect(session.click(refFor(snap, "link", "About"))).rejects.toThrow(ToolUseError);
    await expect(session.click(refFor(snap, "link", "About"))).rejects.toThrow(/not available/);
    const before = (await session.snapshot()).split("\n").find((l) => l.startsWith("Focused:"));
    await session.press("Tab");
    const after = (await session.snapshot()).split("\n").find((l) => l.startsWith("Focused:"));
    expect(after).not.toBe(before);
    expect(after).toContain("Home");
  });

  it("supports tap for touch personas", async () => {
    session = await BrowserSession.start(
      persona({ input: ["touch"], touch: true, viewport: { width: 390, height: 844 } }),
      config(),
    );
    const result = await session.tap(refFor(await session.snapshot(), "link", "About"));
    expect(result).toContain("/about.html");
  });

  it("reports stale refs with a hint instead of crashing", async () => {
    session = await BrowserSession.start(persona(), config());
    await session.snapshot();
    await expect(session.click("e9999")).rejects.toThrow(/call snapshot again/);
  });

  it("stops actions once the step budget is used", async () => {
    session = await BrowserSession.start(persona({ stepBudget: 2 }), config());
    await session.goto("/about.html");
    await session.back();
    await expect(session.goto("/")).rejects.toThrow(/budget exhausted/);
  });

  it("refuses goto outside the target origin", async () => {
    session = await BrowserSession.start(persona(), config());
    await expect(session.goto("//evil.test")).rejects.toThrow(ToolUseError);
  });

  it("caps very large snapshots", async () => {
    session = await BrowserSession.start(persona(), config());
    await session.goto("/big.html");
    const snap = await session.snapshot();
    expect(snap.endsWith("[snapshot truncated]")).toBe(true);
    expect(snap.length).toBeLessThanOrEqual(SNAPSHOT_CAP + "\n… [snapshot truncated]".length);
  });

  it("closes popups and keeps the main page", async () => {
    session = await BrowserSession.start(persona(), config());
    const result = await session.click(refFor(await session.snapshot(), "link", "Open in new tab"));
    expect(result).toContain("blocked: popup closed");
    expect(session.url.startsWith(server.origin)).toBe(true);
  });

  it("blocks off-origin subresources and reports it", async () => {
    session = await BrowserSession.start(persona(), config());
    const result = await session.goto("/");
    expect(result).toContain("blocked: off-origin request to http://evil.test");
  });

  it("allows writes only on allowed paths", async () => {
    session = await BrowserSession.start(persona(), config({ allowWritePaths: ["/api/**"] }));
    await session.click(refFor(await session.snapshot(), "button", "Send"));
    expect(server.requests.some((r) => r.method === "POST")).toBe(true);
  });

  it("explains when there is no previous page", async () => {
    session = await BrowserSession.start(persona(), config());
    expect(await session.back()).toMatch(/no previous page/);
  });

  it("names a focused form field by its label", async () => {
    session = await BrowserSession.start(persona(), config());
    await session.fill(refFor(await session.snapshot(), "textbox", "Name"), "Ana");
    const focused = (await session.snapshot()).split("\n").find((l) => l.startsWith("Focused:"));
    expect(focused).toBe('Focused: input "Name"');
  });

  it("rejects unknown keys", async () => {
    session = await BrowserSession.start(persona(), config());
    await expect(session.press("NotARealKey")).rejects.toThrow(/cannot press/);
  });

  it("rejects fill on a stale ref", async () => {
    session = await BrowserSession.start(persona(), config());
    await expect(session.fill("e9999", "x")).rejects.toThrow(/call snapshot again/);
  });

  it("applies reduced motion and touch settings", async () => {
    session = await BrowserSession.start(
      persona({ input: ["touch"], touch: true, reducedMotion: true }),
      config(),
    );
    expect(await session.snapshot()).toContain("Welcome to the fixture");
  });

  it("takes a PNG screenshot", async () => {
    session = await BrowserSession.start(persona(), config());
    const png = await session.screenshot();
    expect(png.subarray(1, 4).toString()).toBe("PNG");
  });
});
