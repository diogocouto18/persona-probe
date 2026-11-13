import { describe, expect, it } from "vitest";
import {
  GuardError,
  isAllowedOrigin,
  isLoopback,
  parseTarget,
  resolveSamePath,
  sanitizeName,
  writeDecision,
} from "../src/guards.js";

describe("parseTarget", () => {
  it("returns the origin of a loopback target", () => {
    expect(parseTarget("http://localhost:3000/x", { iOwnThisSite: false }).origin).toBe(
      "http://localhost:3000",
    );
  });

  it("refuses a non-loopback target without --i-own-this-site", () => {
    expect(() => parseTarget("https://diogocouto.dev", { iOwnThisSite: false })).toThrow(
      /--i-own-this-site/,
    );
    expect(() => parseTarget("https://diogocouto.dev", { iOwnThisSite: false })).toThrow(
      GuardError,
    );
  });

  it("accepts a non-loopback target with --i-own-this-site", () => {
    expect(parseTarget("https://diogocouto.dev/a", { iOwnThisSite: true }).origin).toBe(
      "https://diogocouto.dev",
    );
  });

  it("rejects non-http schemes", () => {
    expect(() => parseTarget("file:///etc/passwd", { iOwnThisSite: true })).toThrow(GuardError);
  });

  it("rejects malformed URLs", () => {
    expect(() => parseTarget("not a url", { iOwnThisSite: true })).toThrow(GuardError);
  });
});

describe("isLoopback", () => {
  it.each(["localhost", "127.0.0.1", "::1", "[::1]", "app.localhost"])("%s is loopback", (h) => {
    expect(isLoopback(h)).toBe(true);
  });
  it.each(["example.com", "10.0.0.1", "localhost.evil.test"])("%s is not loopback", (h) => {
    expect(isLoopback(h)).toBe(false);
  });
});

describe("isAllowedOrigin", () => {
  const allowed = ["http://localhost:3000"];
  it("allows same-origin requests", () => {
    expect(isAllowedOrigin("http://localhost:3000/a.js", allowed)).toBe(true);
  });
  it("blocks other origins", () => {
    expect(isAllowedOrigin("http://evil.test/x", allowed)).toBe(false);
    expect(isAllowedOrigin("http://localhost:3001/x", allowed)).toBe(false);
  });
  it("allows inline schemes", () => {
    expect(isAllowedOrigin("data:image/png;base64,AA", allowed)).toBe(true);
    expect(isAllowedOrigin("blob:http://localhost:3000/uuid", allowed)).toBe(true);
    expect(isAllowedOrigin("about:blank", allowed)).toBe(true);
  });
  it("blocks unparseable URLs", () => {
    expect(isAllowedOrigin("::::", allowed)).toBe(false);
  });
});

describe("writeDecision", () => {
  const post = {
    method: "POST",
    resourceType: "fetch",
    url: "http://localhost:3000/api/contact",
    isNavigationRequest: false,
  };
  it("blocks writes by default", () => {
    expect(writeDecision(post, { allowWrites: false, allowWritePaths: [] })).toBe("block");
  });
  it("allows writes on an allowed path glob", () => {
    expect(writeDecision(post, { allowWrites: false, allowWritePaths: ["/api/**"] })).toBe("allow");
    expect(writeDecision(post, { allowWrites: false, allowWritePaths: ["/other/*"] })).toBe(
      "block",
    );
  });
  it("single star does not cross path segments", () => {
    expect(writeDecision(post, { allowWrites: false, allowWritePaths: ["/*"] })).toBe("block");
  });
  it("allows reads", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(writeDecision({ ...post, method }, { allowWrites: false, allowWritePaths: [] })).toBe(
        "allow",
      );
    }
  });
  it("allows writes when allowWrites is set", () => {
    expect(writeDecision(post, { allowWrites: true, allowWritePaths: [] })).toBe("allow");
  });
  it("blocks form navigations", () => {
    expect(
      writeDecision(
        { ...post, resourceType: "document", isNavigationRequest: true },
        { allowWrites: false, allowWritePaths: [] },
      ),
    ).toBe("block");
  });
});

describe("resolveSamePath", () => {
  const target = new URL("http://localhost:3000");
  it("resolves a same-origin path", () => {
    expect(resolveSamePath(target, "/blog").href).toBe("http://localhost:3000/blog");
    expect(resolveSamePath(target, "blog?x=1").href).toBe("http://localhost:3000/blog?x=1");
  });
  it.each(["//evil.test/x", "http://evil.test", "javascript:alert(1)"])("rejects %s", (p) => {
    expect(() => resolveSamePath(target, p)).toThrow(GuardError);
  });
});

describe("sanitizeName", () => {
  it("strips traversal and unsafe characters", () => {
    expect(sanitizeName("../../Etc/Passwd!!")).toBe("etc-passwd");
  });
  it("falls back for empty input", () => {
    expect(sanitizeName("")).toBe("item");
    expect(sanitizeName("../..")).toBe("item");
  });
  it("caps length at 64", () => {
    expect(sanitizeName("a".repeat(200)).length).toBe(64);
  });
});
