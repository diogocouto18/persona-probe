import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import { GuardError, isAllowedOrigin, resolveSamePath, writeDecision } from "./guards.js";
import { isToolAllowed, type ActionTool, type Persona } from "./personas.js";

/** Maximum characters returned by snapshot() before truncation. */
export const SNAPSHOT_CAP = 12_000;
const TRUNCATED = "\n… [snapshot truncated]";
const ACTION_TIMEOUT_MS = 5_000;
const NAV_TIMEOUT_MS = 15_000;
const NAV_WINDOW_MS = 600;
/** Max wait for the network to go quiet after an action (covers slow client-side routing). */
const IDLE_TIMEOUT_MS = 5_000;
const QUIET_MS = 300;

/**
 * Finds the focused element in an AI-mode aria snapshot, which marks it with
 * `[active]`. The top-level node is marked when nothing has focus.
 */
export function focusedFromSnapshot(aria: string): string {
  const active = aria.split("\n").filter((l) => l.includes("[active]"));
  const line = active[active.length - 1];
  if (!line || /^- /.test(line)) return "none";
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
      await page.goto(cfg.target.href, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
      return session;
    } catch (err) {
      await browser.close();
      throw err;
    }
  }

  private async installGuards(): Promise<void> {
    const allowed = [this.cfg.target.origin, ...this.cfg.allowOrigins];
    await this.context.route("**/*", async (route) => {
      const req = route.request();
      const url = req.url();
      if (!isAllowedOrigin(url, allowed)) {
        if (req.isNavigationRequest()) {
          this.notice(`blocked: off-origin navigation to ${originOf(url)}`);
          // 204 on a navigation keeps the current page instead of showing an error page.
          return route.fulfill({ status: 204 });
        }
        this.notice(`blocked: off-origin request to ${originOf(url)}`);
        return route.abort("blockedbyclient");
      }
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
      return route.continue();
    });
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

  async snapshot(): Promise<string> {
    await this.settle();
    const aria = await this.page.ariaSnapshot({ mode: "ai" });
    const text = [
      `Focused: ${focusedFromSnapshot(aria)}`,
      `URL: ${this.page.url()}`,
      "[untrusted page content below]",
      aria,
    ].join("\n");
    return text.length > SNAPSHOT_CAP ? text.slice(0, SNAPSHOT_CAP) + TRUNCATED : text;
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
