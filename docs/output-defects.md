# CLI output defects — found 2026-08-19, all fixed

Captured from a real paid run of `shumi ask "why is HYPE pumping?"` on 0.8.0.
Every one of these exited 0 and printed something plausible, so nothing but
reading the actual characters would have caught them.

## 1. Receipt collided with the spinner

```
⠋ generating response💸 Paid 0.05 USDC on Base · tx 0x82f49af1…
```

`pauseActiveSpinner()` already existed — it was added when the payment *prompt*
had this same defect. This write site was missed at the time.

## 2. Tables rendered wider than the terminal

The Driver/Evidence table came out around 290 characters wide. The terminal then
wrapped it mid-cell, so row structure was lost and the column rules no longer
lined up with the content. The summary table at the end looked fine — the only
difference was total column width.

**Cause.** cli-table3 sizes to content and never consults the terminal.
marked-terminal exposes `tableOptions`, but reads it **once**, in its
constructor, into a `Renderer` instance it does not expose — and column widths
have to be computed per table from that table's content. There is no way to hand
them over after construction.

**Fix.** `renderer.table` is implemented in `src/lib/renderer.js` rather than
delegated. Columns get a 6-character minimum and then share the remaining budget
in proportion to how much each one actually wants, so a one-word column stays
narrow and the prose column absorbs the squeeze. Markdown alignment (`---:`)
is carried through to `colAligns`. A table that already fits is left entirely
alone — `colWidths` must be **absent**, not `undefined`, or cli-table3 indexes
into it and throws.

## 3. Inline markdown was dropped inside lists

`**Main cause:**` printed its asterisks literally, while the same markup rendered
bold in a table cell in the same response.

**Cause.** marked-terminal's `text` renderer reads `token.text` — the raw source —
and never looks at `token.tokens`. Paragraphs escape this because marked runs
`parseInline` before reaching the paragraph renderer; list items do not.

Note this affects **bulleted and ordered lists alike**. The original report said
ordered lists; that was too narrow.

**Fix.** `renderer.text` parses `token.tokens` when they are present.

## 4. An empty table rendered above the real one

A model emitting a stray delimiter line produces a table token with an empty
header and no rows, which was drawn as an empty box. Now suppressed.

## Trap worth remembering

Every function `markedTerminal()` installs copies `this.parser` onto its internal
renderer before delegating. Wrapping one of them with `.bind()` points that copy
at the wrong object, and the failure surfaces much later and somewhere else, as
`Cannot read properties of undefined (reading 'parse')` inside `listitem`. Wrap
with `.call(this, …)`.

## Not a rendering problem

Two defects in the same output are wrong *content*, not wrong formatting, and
belong to the server. See `coinrotator-ai/docs/answer-quality-defects.md`.
