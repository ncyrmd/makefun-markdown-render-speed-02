# Make Markdown rendering faster — fast `marked` clone

[![make.fun](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/ncyrmd/makefun-markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/ncyrmd/makefun-markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02)

A dependency-free, single-file Markdown parser (`parse.js`, ES module) whose
`parse(markdown)` returns **byte-for-byte the same HTML as `marked` 18.1.3**
with default options — on all 720 practice cases (680 CommonMark 0.31.2 + GFM
0.29 spec examples + 40 generated READMEs of 20k–100k chars) — while running
~18% faster than `marked` itself (median ~615 ms vs ~746 ms over the practice
set on this machine).

Built for the [make.fun bounty](https://make.fun/bounty/markdown-render-speed-02)
"Make Markdown rendering faster" ($250, top 20). The scored set is drawn from
a drand round at deadline; the entry must match `marked` on every case before
speed counts, so correctness first, speed second.

## Files

- `parse.js` — the parser. No dependencies, no network, no WASM, no native
  code. Exports `parse(markdown)` (string in, HTML string out).
- `main.ts` — Node 22 entry point: reads `/input/cases.json`, writes
  `/output/html.json` (the competition harness contract).
- `LICENSE` — MIT (`SPDX-License-Identifier: MIT`).

## Usage

```js
import { parse } from './parse.js';

parse('# hello\n\nsome *emph* text');
// '<h1>hello</h1>\n<p>some <em>emph</em> text</p>\n'
```

Grade locally against the practice set (from the kit):

```sh
MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=<out> node main.ts
# then run the kit scorer over <out>
```

## How it stays byte-identical

The parser re-implements `marked`'s block + inline lexers, including the
sharp edges that only show up in long generated documents:

- **Emphasis masking** — `marked` scans for `*`/`_` delimiters over text
  masked by its `blockSkip` + code-span/escape masking, so a dangling
  backtick run inside a link label can hide delimiters that would otherwise
  form `<em>`/`<strong>`. The parser reproduces that mask (same regexes,
  same length-preserving replacements) and skips masked delimiters.
- **Fenced-code dedent** — backtick fences strip their indent by
  *character* count (a tab counts as one), tilde fences do not dedent; a
  tab after a `>` marker expands from the column in the container-stripped
  source, not the absolute column.
- **Fence/list absorption** — a fenced block inside a list item only absorbs
  a following line when the fence sits directly in the item and the line is
  plain content; a fence close/open, heading, hr, blockquote, list marker
  or HTML block closes the fence instead.
- **HTML blocks** — a comment block that ends on its opening line
  (`<!-- note --> …`) does not carry a trailing newline past a
  container-only line (`>`).

Nothing is copied from `marked`'s source; the behaviour was pinned by
probing the vendored `marked` in the kit and re-implementing the rules.

## License

MIT — see [LICENSE](LICENSE).
