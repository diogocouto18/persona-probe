/** Error raised when an input violates a safety rule (target, origin, path). */
export class GuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardError";
  }
}

const INLINE_SCHEMES = new Set(["data:", "blob:", "about:"]);
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** True for hostnames that resolve to the local machine. */
export function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    /^127(\.\d{1,3}){3}$/.test(host)
  );
}

/**
 * Validates the target given at launch and returns its origin as a URL.
 * Non-loopback targets need an explicit ownership acknowledgement.
 */
export function parseTarget(url: string, opts: { iOwnThisSite: boolean }): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new GuardError(`Invalid target URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new GuardError(`Target must be http(s), got ${parsed.protocol}`);
  }
  if (!isLoopback(parsed.hostname) && !opts.iOwnThisSite) {
    throw new GuardError(
      `Refusing non-local target ${parsed.origin}. Pass --i-own-this-site if you own it and accept the side effects.`,
    );
  }
  return new URL(parsed.origin);
}

/** True when a request URL belongs to one of the allowed origins (or is inline data). */
export function isAllowedOrigin(requestUrl: string, allowed: string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(requestUrl);
  } catch {
    return false;
  }
  if (INLINE_SCHEMES.has(parsed.protocol)) return true;
  return allowed.includes(parsed.origin);
}

function globToRegExp(glob: string): RegExp {
  let pattern = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] as string;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        pattern += ".*";
        i++;
      } else {
        pattern += "[^/]*";
      }
    } else {
      pattern += ch.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${pattern}$`);
}

/** Decides whether a request may reach the target when writes are restricted. */
export function writeDecision(
  req: { method: string; resourceType: string; url: string; isNavigationRequest: boolean },
  cfg: { allowWrites: boolean; allowWritePaths: string[] },
): "allow" | "block" {
  if (READ_METHODS.has(req.method.toUpperCase())) return "allow";
  if (cfg.allowWrites) return "allow";
  let path: string;
  try {
    path = new URL(req.url).pathname;
  } catch {
    return "block";
  }
  return cfg.allowWritePaths.some((glob) => globToRegExp(glob).test(path)) ? "allow" : "block";
}

/** Resolves a path against the target, refusing anything that leaves its origin. */
export function resolveSamePath(target: URL, path: string): URL {
  let resolved: URL;
  try {
    resolved = new URL(path, target);
  } catch {
    throw new GuardError(`Invalid path: ${path}`);
  }
  if (resolved.origin !== target.origin) {
    throw new GuardError(`Path leaves the target origin: ${path}`);
  }
  return resolved;
}

/** Turns arbitrary text into a safe file-name segment. */
export function sanitizeName(input: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return cleaned.length > 0 ? cleaned : "item";
}
