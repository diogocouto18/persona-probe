import {
  chromium,
  type APIResponse,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  type Route,
} from "playwright";
import { GuardError, isAllowedOrigin, resolveSamePath, writeDecision } from "./guards.js";
import { isToolAllowed, type ActionTool, type Persona } from "./personas.js";

/** Maximum characters returned by snapshot() before truncation. */
export const SNAPSHOT_CAP = 12_000;
const ACTION_TIMEOUT_MS = 5_000;
const NAV_TIMEOUT_MS = 15_000;
const NAV_WINDOW_MS = 600;
/** Max wait for the network to go quiet after an action (covers slow client-side routing). */
const IDLE_TIMEOUT_MS = 5_000;
const QUIET_MS = 300;
const MAX_REDIRECT_HOPS = 10;

/** Splits text into chunks of whole lines, each at most `max` characters (long lines are cut). */
function splitLines(text: string, max: number): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const raw of text.split("\n")) {
    const line = raw.length > max ? raw.slice(0, max) : raw;
    if (current && current.length + 1 + line.length > max) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  chunks.push(current);
  return chunks;
}

function wsToHttp(url: string): string {
  return url.replace(/^ws(s?):/, "http$1:");
}

/** True when the document itself (not a control) has focus. Runs in the page. */
const NOTHING_FOCUSED = "!document.activeElement || document.activeElement === document.body";

/**
 * Finds the focused element in an AI-mode aria snapshot, which marks it with an
 * `[active]` attribute. Quoted names are ignored so page text cannot fake the marker.
 */
export function focusedFromSnapshot(aria: string): string {
  const active = aria
    .split("\n")
    .filter((l) => l.replace(/"(?:[^"\\]|\\.)*"/g, '""').includes("[active]"));
  const line = active[active.length - 1];
  if (!line) return "none";
  return line
    .trim()
    .replace(/^- /, "")
    .replace(/:$/, "")
    .replace(/ \[(active|cursor=[^\]]*)\]/g, "");
}

export interface SessionConfig {
  target: URL;
  allowOrigins: string[];
  allowWrites: boolean;
  allowWritePaths: string[];
  headless?: boolean;
}

/** An expected, agent-facing failure: the message is meant to be shown to the agent. */
export class ToolUseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolUseError";
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

async function launchChromium(headless: boolean): Promise<Browser> {
  try {
    return await chromium.launch({ headless });
  } catch (err) {
    const message = (err as Error).message;
    if (/Executable doesn't exist|install/i.test(message)) {
      throw new Error("Chromium is not installed. Run: npx playwright install chromium", {
        cause: err,
      });
    }
    throw err;
  }
}

/** One persona's locked-down browser: fixed origin, write guard, input-mode and budget rules. */
export class BrowserSession {
  private notices: string[] = [];
  private steps = 0;
  private inFlight = 0;

  private constructor(
    private readonly persona: Persona,
    private readonly cfg: SessionConfig,
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly page: Page,
  ) {}

  static async start(persona: Persona, cfg: SessionConfig): Promise<BrowserSession> {
    const browser = await launchChromium(cfg.headless ?? true);
    try {
      const context = await browser.newContext({
        viewport: persona.viewport,
        hasTouch: persona.touch,
        isMobile: persona.touch,
        reducedMotion: persona.reducedMotion ? "reduce" : "no-preference",
        acceptDownloads: false,
        serviceWorkers: "block",
      });
      const page = await context.newPage();
      const session = new BrowserSession(persona, cfg, browser, context, page);
      await session.installGuards();
      await session.openTarget();
      return session;
    } catch (err) {
      await browser.close();
      throw err;
    }
  }

  private allowedOrigins(): string[] {
    return [this.cfg.target.origin, ...this.cfg.allowOrigins];
  }

  /** Blocks an off-origin request: navigations get a 204 so the current page stays. */
  private blockOffOrigin(route: Route, url: string): Promise<void> {
    if (route.request().isNavigationRequest()) {
      this.notice(`blocked: off-origin navigation to ${originOf(url)}`);
      return route.fulfill({ status: 204 });
    }
    this.notice(`blocked: off-origin request to ${originOf(url)}`);
    return route.abort("blockedbyclient");
  }

  /** Loads the target; refuses to start if it is unreachable or leaves the allowed origins. */
  private async openTarget(): Promise<void> {
    const href = this.cfg.target.href;
    try {
      await this.page.goto(href, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    } catch (err) {
      const blocked = this.notices.find((n) => n.startsWith("blocked: off-origin navigation"));
      if (blocked) {
        throw new ToolUseError(
          `target ${href} redirects off-origin (${blocked}); refusing to start`,
        );
      }
      throw new ToolUseError(
        `cannot open target ${href}: ${(err as Error).message.split("\n")[0]}`,
      );
    }
  }

  /**
   * Follows a redirect chain without letting the browser do it, and returns the first
   * hop outside the allowed origins (or undefined if the chain stays inside).
   * Hops after the first are requested once here and again by the browser.
   */
  private async firstOffOriginHop(
    route: Route,
    url: string,
    first: APIResponse,
    allowed: string[],
  ): Promise<string | undefined> {
    let current = url;
    let response = first;
    for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop++) {
      const location = response.headers()["location"];
      if (response.status() < 300 || response.status() >= 400 || !location) return undefined;
      let next: string;
      try {
        next = new URL(location, current).href;
      } catch {
        return location;
      }
      if (!isAllowedOrigin(next, allowed)) return next;
      current = next;
      try {
        response = await route.fetch({
          url: next,
          method: "GET",
          maxRedirects: 0,
          timeout: NAV_TIMEOUT_MS,
        });
      } catch {
        return undefined;
      }
    }
    return current;
  }

  private async installGuards(): Promise<void> {
    const allowed = this.allowedOrigins();
    await this.context.route("**/*", async (route) => {
      const req = route.request();
      const url = req.url();
      // WebSocket handshakes are guarded by routeWebSocket below.
      if (/^wss?:/.test(url)) return route.fallback();
      if (!isAllowedOrigin(url, allowed)) return this.blockOffOrigin(route, url);
      const decision = writeDecision(
        {
          method: req.method(),
          resourceType: req.resourceType(),
          url,
          isNavigationRequest: req.isNavigationRequest(),
        },
        { allowWrites: this.cfg.allowWrites, allowWritePaths: this.cfg.allowWritePaths },
      );
      if (decision === "block") {
        this.notice(`blocked: write ${req.method()} ${new URL(url).pathname}`);
        return route.fulfill({
          status: 403,
          contentType: "text/plain",
          body: "Blocked by persona-probe write guard",
        });
      }
      // Playwright only routes the first request of a redirect chain, so the whole chain
      // is resolved here hop by hop and refused if any hop leaves the allowed origins.
      let response: APIResponse;
      try {
        response = await route.fetch({ maxRedirects: 0, timeout: NAV_TIMEOUT_MS });
      } catch {
        return route.abort("failed").catch(() => {});
      }
      const offOrigin = await this.firstOffOriginHop(route, url, response, allowed);
      if (offOrigin) return this.blockOffOrigin(route, offOrigin);
      return route.fulfill({ response });
    });
    // WebSockets never reach a server: off-origin ones are refused, same-origin ones are
    // answered by an in-page mock. (Chromium cannot open real sockets from documents
    // served through route.fulfill, which the redirect check above requires.)
    await this.context.routeWebSocket(
      () => true,
      (ws) => {
        if (!isAllowedOrigin(wsToHttp(ws.url()), allowed)) {
          this.notice(`blocked: off-origin websocket to ${originOf(ws.url())}`);
          return ws.close({ code: 1008, reason: "blocked by persona-probe" });
        }
        this.notice(`blocked: websocket to ${new URL(ws.url()).pathname} (not supported)`);
        ws.onMessage(() => {});
      },
    );
    this.context.on("page", (popup) => {
      if (popup !== this.page) {
        this.notice("blocked: popup closed");
        void popup.close();
      }
    });
    this.page.on("request", () => {
      this.inFlight += 1;
    });
    const done = () => {
      this.inFlight = Math.max(0, this.inFlight - 1);
    };
    this.page.on("requestfinished", done);
    this.page.on("requestfailed", done);
  }

  private notice(text: string): void {
    if (!this.notices.includes(text)) this.notices.push(text);
  }

  get stepsUsed(): number {
    return this.steps;
  }

  get url(): string {
    return this.page.url();
  }

  private begin(tool: ActionTool): void {
    if (!isToolAllowed(this.persona, tool)) {
      throw new ToolUseError(`${tool} is not available for persona ${this.persona.name}`);
    }
    if (this.steps >= this.persona.stepBudget) {
      throw new ToolUseError("step budget exhausted — call finish_persona");
    }
    this.steps += 1;
  }

  private async settle(): Promise<void> {
    await this.page
      .waitForLoadState("domcontentloaded", { timeout: NAV_TIMEOUT_MS })
      .catch(() => {});
    await this.waitForQuiet();
  }

  /**
   * Waits until no request has been in flight for QUIET_MS, or IDLE_TIMEOUT_MS
   * passes. Unlike Playwright's "networkidle" load state, this also covers
   * fetches started after the page loaded (client-side routing).
   */
  private async waitForQuiet(): Promise<void> {
    const deadline = Date.now() + IDLE_TIMEOUT_MS;
    let quietSince = this.inFlight === 0 ? Date.now() : 0;
    while (Date.now() < deadline) {
      if (this.inFlight > 0) {
        quietSince = 0;
      } else if (quietSince === 0) {
        quietSince = Date.now();
      } else if (Date.now() - quietSince >= QUIET_MS) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /**
   * Starts listening for a main-frame navigation that an action may trigger
   * asynchronously (e.g. touch taps); resolves once it has loaded, or after a
   * short window if no navigation starts.
   */
  private expectNavigation(): Promise<void> {
    return this.page
      .waitForRequest((r) => r.isNavigationRequest() && r.frame() === this.page.mainFrame(), {
        timeout: NAV_WINDOW_MS,
      })
      .then(async (req) => {
        const response = await req.response().catch(() => null);
        // A 204 (blocked off-origin navigation) leaves the current page in place.
        if (response?.status() === 204) return;
        await this.page.waitForEvent("framenavigated", {
          predicate: (frame) => frame === this.page.mainFrame(),
          timeout: NAV_TIMEOUT_MS,
        });
        await this.page.waitForLoadState("domcontentloaded", { timeout: NAV_TIMEOUT_MS });
      })
      .catch(() => {});
  }

  private async result(outcome: string, navigation?: Promise<void>): Promise<string> {
    await navigation;
    await this.settle();
    const lines = [outcome, ...this.notices, `URL: ${this.page.url()}`];
    this.notices = [];
    return lines.join("\n");
  }

  private async onRef(ref: string, act: (l: Locator) => Promise<void>): Promise<void> {
    try {
      await act(this.page.getByRef(ref));
    } catch (err) {
      if (err instanceof ToolUseError) throw err;
      const reason = (err as Error).message.split("\n")[0] ?? "unknown error";
      throw new ToolUseError(
        `ref ${ref} not found or not actionable (${reason}) — call snapshot again`,
      );
    }
  }

  /**
   * Accessibility snapshot of the page. Long snapshots are split at line
   * boundaries into parts of at most SNAPSHOT_CAP characters; `part` selects one.
   */
  async snapshot(part = 1): Promise<string> {
    await this.settle();
    const aria = await this.page.ariaSnapshot({ mode: "ai" });
    const nothingFocused = await this.page.evaluate<boolean>(NOTHING_FOCUSED);
    const header = [
      `URL: ${this.page.url()}`,
      "[untrusted page content below]",
      `Focused: ${nothingFocused ? "none" : focusedFromSnapshot(aria)}`,
    ];
    const parts = splitLines(aria, SNAPSHOT_CAP - header.join("\n").length - 1);
    const body = parts[part - 1];
    if (body === undefined)
      return `${header[0]}\nno part ${part}: this snapshot has ${parts.length}`;
    const lines = [...header, body];
    if (part < parts.length) {
      lines.push(`… [snapshot truncated — call snapshot with part=${part + 1} for more]`);
    }
    return lines.join("\n");
  }

  async click(ref: string): Promise<string> {
    this.begin("click");
    const nav = this.expectNavigation();
    await this.onRef(ref, (l) => l.click({ timeout: ACTION_TIMEOUT_MS }));
    return this.result(`clicked ${ref}`, nav);
  }

  async tap(ref: string): Promise<string> {
    this.begin("tap");
    const nav = this.expectNavigation();
    await this.onRef(ref, (l) => l.tap({ timeout: ACTION_TIMEOUT_MS }));
    return this.result(`tapped ${ref}`, nav);
  }

  async fill(ref: string, text: string): Promise<string> {
    this.begin("fill");
    await this.onRef(ref, (l) => l.fill(text, { timeout: ACTION_TIMEOUT_MS }));
    return this.result(`filled ${ref}`);
  }

  async press(key: string): Promise<string> {
    this.begin("press");
    const nav = this.expectNavigation();
    try {
      await this.page.keyboard.press(key);
    } catch (err) {
      throw new ToolUseError(`cannot press "${key}": ${(err as Error).message.split("\n")[0]}`);
    }
    return this.result(`pressed ${key}`, nav);
  }

  async goto(path: string): Promise<string> {
    this.begin("goto");
    let url: URL;
    try {
      url = resolveSamePath(this.cfg.target, path);
    } catch (err) {
      if (err instanceof GuardError) throw new ToolUseError(err.message);
      throw err;
    }
    await this.page
      .goto(url.href, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS })
      .catch((err: Error) => this.notice(`navigation failed: ${err.message.split("\n")[0]}`));
    return this.result(`navigated to ${url.pathname}${url.search}`);
  }

  async back(): Promise<string> {
    this.begin("back");
    const before = this.page.url();
    await this.page
      .goBack({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS })
      .catch(() => null);
    if (originOf(this.page.url()) !== this.cfg.target.origin) {
      // History reached the blank page the browser started on: return to where we were.
      await this.page
        .goto(before, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS })
        .catch(() => {});
      return this.result("no previous page on this site; stayed on the current page");
    }
    return this.result("went back");
  }

  async screenshot(): Promise<Buffer> {
    await this.settle();
    return this.page.screenshot({ type: "png" });
  }

  async close(): Promise<void> {
    await this.browser.close();
  }
}
