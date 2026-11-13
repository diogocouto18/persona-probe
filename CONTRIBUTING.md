# Contributing

Thanks for your interest in persona-probe.

1. Fork and create a branch from `master`.
2. `npm ci && npx playwright install chromium`.
3. Write a failing test first, then the change. Tests live in `test/` and run
   against a local fixture site; please keep them free of network and LLM calls.
4. Run the full gate before opening a pull request:
   `npm run lint && npm run typecheck && npm run format:check && npm run test:coverage`.
5. Open a pull request against `master` describing the behaviour change.

Changes that weaken a safety rail (origin lock, write guard, input-mode
enforcement, output containment) need a clear justification and an opt-in flag.

New personas are welcome: add a Markdown file under `personas/` and extend
`test/personas.test.ts`.
