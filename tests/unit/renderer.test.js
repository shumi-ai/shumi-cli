import { describe, it, expect, vi } from 'vitest';

/**
 * Rendering defects observed on a real paid `shumi ask` run (0.8.0, 2026-08-19).
 * All three were silent: the CLI exited 0 and printed something plausible, so
 * only assertions about the printed characters catch them.
 */

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');

const WIDE_TABLE = `| Driver | Evidence | Read |
|---|---|---|
| US regulatory access | Trump said the CFTC is working to bring Hyperliquid into the US compliantly, which traders priced as institutional access | Structural repricing, not a flow blip |
| Short liquidation | Roughly $1B+ of shorts were liquidated across the market, forcing buybacks into thin books | Mechanical acceleration |
`;

async function render(markdown, columns) {
  vi.resetModules();
  // Not spyOn: under vitest stdout is not a TTY and `columns` has no getter to
  // spy on, so the property is defined outright and restored afterwards.
  const had = Object.prototype.hasOwnProperty.call(process.stdout, 'columns');
  const previous = process.stdout.columns;
  Object.defineProperty(process.stdout, 'columns', { value: columns, configurable: true, writable: true });
  const lines = [];
  const log = vi.spyOn(console, 'log').mockImplementation((s) => lines.push(String(s)));
  const { renderText } = await import('../../src/lib/renderer.js');
  renderText(markdown);
  log.mockRestore();
  if (had) Object.defineProperty(process.stdout, 'columns', { value: previous, configurable: true, writable: true });
  else delete process.stdout.columns;
  return lines.join('\n');
}

const widest = (out) => Math.max(...out.split('\n').map((l) => [...l.replace(ANSI, '')].length));

describe('tables fit the terminal', () => {
  // The Driver/Evidence table rendered ~290 characters wide, so the terminal
  // wrapped it mid-cell and the column rules stopped lining up with content.
  for (const columns of [60, 80, 100, 120, 200]) {
    it(`does not overflow at ${columns} columns`, async () => {
      const out = await render(WIDE_TABLE, columns);
      expect(widest(out)).toBeLessThanOrEqual(columns);
    });
  }

  it('keeps every row intact rather than losing structure to wrapping', async () => {
    const out = await render(WIDE_TABLE, 100);
    // Content is wrapped inside cells, so both rows' first cells survive whole.
    expect(out).toContain('Structural');
    expect(out).toContain('Mechanical');
    // Every border line is the same width — the thing destructive wrapping breaks.
    const borders = out.split('\n').filter((l) => /^[┌├└]/.test(l)).map((l) => [...l].length);
    expect(new Set(borders).size).toBe(1);
  });

  it('leaves a table that already fits alone, and honours column alignment', async () => {
    const out = await render('| Coin | Price |\n|---|---:|\n| HYPE | $71.73 |\n', 100);
    expect(widest(out)).toBeLessThan(30);
    // `---:` means right-aligned: the padding lands before the value, inside
    // the box-drawing borders cli-table3 uses.
    expect(out).toMatch(/│\s+\$71\.73 │/);
  });
});

describe('inline formatting inside lists', () => {
  // `**Main cause:**` printed its asterisks literally, while the same markup
  // rendered bold in a table cell in the same response. marked-terminal's text
  // renderer reads the raw token and never parses token.tokens.
  it('applies bold and italic in ordered lists', async () => {
    const out = await render('1. **Main cause:** it jumped.\n2. *Risk:* funding.\n', 100);
    expect(out).not.toContain('**Main cause:**');
    expect(out).not.toContain('*Risk:*');
    expect(out.replace(ANSI, '')).toContain('Main cause:');
  });

  it('applies them in bulleted lists too', async () => {
    const out = await render('- **Immediate catalyst:** remarks.\n', 100);
    expect(out).not.toContain('**Immediate catalyst:**');
    expect(out.replace(ANSI, '')).toContain('Immediate catalyst:');
  });

  it('still renders paragraphs and table cells, which already worked', async () => {
    const out = await render('**para**\n\n| A |\n|---|\n| **cell** |\n', 100);
    expect(out).not.toContain('**para**');
    expect(out).not.toContain('**cell**');
  });
});

describe('empty tables', () => {
  it('suppresses a headerless, rowless table instead of drawing an empty box', async () => {
    const out = await render('|  |\n|---|\n\n| Coin | Price |\n|---|---|\n| HYPE | $71 |\n', 100);
    const boxes = out.split('\n').filter((l) => l.startsWith('┌')).length;
    expect(boxes).toBe(1);
    expect(out).toContain('Coin');
  });
});

describe('robustness', () => {
  it('falls back to a sane width when columns is unavailable (pipes, CI)', async () => {
    const out = await render(WIDE_TABLE, undefined);
    expect(widest(out)).toBeLessThanOrEqual(80);
  });

  it('renders an empty response as a notice, not a crash', async () => {
    const out = await render('', 100);
    expect(out.replace(ANSI, '')).toContain('No response received.');
  });
});

describe('long list items wrap to the terminal', () => {
  // marked-terminal's reflowText only reaches paragraphs and blockquotes, so a
  // bullet ran to 184 characters in a 100-column terminal on a real answer.
  const LONG = `- ${'word '.repeat(60)}\n- short\n\n1. ${'token '.repeat(50)}\n`;

  for (const columns of [60, 80, 100, 120]) {
    it(`keeps every line inside ${columns} columns`, async () => {
      const out = await render(LONG, columns);
      expect(widest(out)).toBeLessThanOrEqual(columns);
    });
  }

  it('hangs the continuation under the text, not under the bullet', async () => {
    const out = await render(LONG, 60);
    const lines = out.split('\n').filter((l) => l.trim());
    const bullet = lines.findIndex((l) => /[*\u2022]\s/.test(l));
    const indentOf = (l) => (l.match(/^\s*/) || [''])[0].length;
    // The wrapped line starts further in than the bullet line, lining up with
    // the text rather than the marker.
    expect(indentOf(lines[bullet + 1])).toBeGreaterThan(indentOf(lines[bullet]));
  });

  it('does not touch a list that already fits', async () => {
    const out = await render('- short one\n- short two\n', 100);
    expect(out.replace(ANSI, '')).toContain('short one');
    expect(out.split('\n').filter((l) => l.includes('short one')).length).toBe(1);
  });

  it('measures visible width, so colour codes neither count nor get split', async () => {
    const { __internal } = await import('../../src/lib/renderer.js');
    const coloured = `${ESC}[1mbold${ESC}[0m`;
    expect(__internal.visibleLength(coloured)).toBe(4);
    const wrapped = __internal.wrapBlock(`  * ${coloured} ${'x'.repeat(90)}`, 40);
    // The escape sequence survives intact rather than being cut mid-code.
    expect(wrapped).toContain(coloured);
  });
});
