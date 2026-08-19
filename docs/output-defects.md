# CLI output defects — observed 2026-08-19

Captured from a real paid run of `shumi ask "why is HYPE pumping?"` on 0.8.0.
One is fixed in this PR; the rest need work this branch does not attempt.

## Fixed here

**Receipt collided with the spinner.** The `💸 Paid …` line was written while the
spinner was still running:

```
⠋ generating response💸 Paid 0.05 USDC on Base · tx 0x82f49af1…
```

`pauseActiveSpinner()` already existed — it was added when the payment *prompt*
had this exact defect. This write site was missed at the time.

## Open

### 1. Tables exceed terminal width and wrap destructively
The Driver/Evidence table wraps mid-cell, so a row's structure is lost and the
column boundary no longer lines up with the content. The summary table at the
end (Coin/Price/24h/Trend/Bands/Funding) renders correctly — the difference is
only total column width.

Two plausible fixes: clamp column widths to `process.stdout.columns`, or fall
back to a definition-list layout below some width. Whichever, it needs to be
driven by the actual terminal width, not a constant.

### 2. Inline markdown is not applied inside ordered lists
`**Main cause:**` renders as literal asterisks under "What matters most", while
bold works inside table cells in the same response. So the renderer applies
inline formatting in some block contexts and not others.

### 3. An empty table renders above the Driver table
A header row with no columns and no rows is emitted before the real table. Looks
like an empty markdown block being rendered rather than skipped.

## Not a rendering problem

Two defects in the same output are wrong *content*, not wrong formatting, and
belong to the server. See `coinrotator-ai/docs/answer-quality-defects.md`.
