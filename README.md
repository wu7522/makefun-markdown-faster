# makefun-markdown-faster

A zero-dependency Markdown renderer written from scratch, a drop-in
replacement for marked 18.1.3 (default options: GFM on, breaks off,
pedantic off). It produces byte-identical HTML on the bounty practice
set (652 CommonMark 0.31.2 cases, 28 GFM cases, 40 generated README
documents) while rendering noticeably faster than marked.

## Layout

- `parse.js` — the renderer. `parse(markdown)` returns HTML.
  Two phases: a line-oriented block lexer (headings, fences, lists,
  blockquotes, tables, link reference definitions, …) followed by a
  position-indexed inline scanner (emphasis/strong via a forward
  scan with a delimiter budget, links, code spans, autolinks, …).
  No dependencies, no cross-case caching.
- `main.ts` — the driver. Reads `cases.json` from `/input`
  (or `$MAKEFUN_INPUT_DIR`), writes `html.json` to `/output`
  (or `$MAKEFUN_OUTPUT_DIR`). Run with plain `node main.ts`.

## Bounty

[![bounty](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/wu7522/makefun-markdown-faster/rank.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/wu7522/makefun-markdown-faster/reward.svg)](https://make.fun/bounty/markdown-render-speed-02)
