# Security Policy

persona-probe lets an AI agent drive a real browser, so its safety rails (fixed
target origin, write guard, no network listener, contained output) are part of
its core functionality. Bypasses of any of them are treated as vulnerabilities.

Behaviour listed under "Known limits" in the [README](README.md#known-limits)
(GET side effects, double-requested redirect hops, WebRTC, DNS prefetch) is
documented scope, not a vulnerability; a way around the rails beyond those is.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's
[private vulnerability reporting](https://github.com/diogocouto18/persona-probe/security/advisories/new)
with steps to reproduce and the version or commit you tested.

You can expect an acknowledgement within a week. Fixes are released as soon as
practical, and reporters are credited unless they prefer otherwise.

## Supported versions

Only the latest release on `master` receives security fixes.
