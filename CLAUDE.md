# tweetmd

Converts a tweet + its conversation into Markdown via a local Playwright
session, with image OCR, diagram-to-mermaid, and AI alt-text through `claude -p`.

## TypeScript only — hard rule

**All source in this repo is TypeScript. Never add a `.js`, `.jsx`, `.mjs`, or
`.cjs` file, and never convert a `.ts`/`.tsx` file to JavaScript.**

This holds for every kind of source: CLI entrypoints, one-off helper scripts
under `scripts/`, config files that could be JS, and throwaway debugging
scratch files that end up committed. If a tool's docs show a `.js` config,
find its TypeScript form or use JSON instead. Shell scripts (`.sh`) are fine
where a shell script is genuinely the right tool.

The only JavaScript in the tree is `dist/` — compiled `tsc` output, gitignored,
never edited by hand.

Enforcement: `npm run guard:ts` fails if any tracked `.js`/`.jsx`/`.mjs`/`.cjs`
file exists. `tsconfig.json` leaves `allowJs` off, so JS in `src/` won't build.

## Layout

- `src/` — library + CLI (`cli.tsx`, Ink-based). Built to `dist/` by `tsc`.
- `scripts/` — standalone maintenance scripts, run with `tsx`, typechecked via
  `tsconfig.scripts.json` (they import types from `src/`, so they're outside
  the build's `rootDir`).
- `reports/` — compiled topic digests; see `reports/README.md`.

## Commands

```bash
npm run dev          # run the CLI from source
npm run build        # tsc -> dist/
npm run typecheck    # typecheck src/ and scripts/
npm run guard:ts     # enforce the TypeScript-only rule
npm run categorize   # regenerate ~/.tweetmd/out/categories.md
npm run report -- --config <path.json>
```
