import chalk from 'chalk';
import Table from 'cli-table3';
import { Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';

/**
 * Terminal rendering for model answers.
 *
 * marked-terminal 7.3.0 predates marked 15's token-based renderer API in two
 * places that matter for the kind of answer Shumi returns, so both are patched
 * below rather than worked around in prompts. See each patch for the evidence.
 */


const ESC = String.fromCharCode(27);
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');

/** Visible width, ignoring SGR escape sequences. */
function visibleLength(text) {
  return [...String(text).replace(ANSI_RE, '')].length;
}

/**
 * Re-wrap an already-rendered block to the terminal, preserving each line's
 * leading whitespace and hanging the continuation under the text rather than
 * under the bullet.
 *
 * marked-terminal's `reflowText` only reaches paragraphs and blockquotes. List
 * items are assembled in `listitem`/`list` and never reflowed, so a long bullet
 * ran to 184 characters in a 100-column terminal — measured on a real
 * `shumi ask` answer. Wrapping happens after rendering because that is the only
 * point where the indent marked-terminal adds is known.
 *
 * Words are measured by VISIBLE length so colour codes neither count toward the
 * budget nor get split in half.
 */
function wrapBlock(block, width) {
  if (!Number.isFinite(width) || width < 20) return block;
  return block
    .split('\n')
    .map((line) => {
      if (visibleLength(line) <= width) return line;
      const indent = (line.match(/^\s*/) || [''])[0];
      // Hang continuations past a bullet or "1." marker so the text lines up.
      const marker = (line.slice(indent.length).match(/^(?:[*\-\u2022]\s+|\d+\.\s+)/) || [''])[0];
      const hang = indent + ' '.repeat(visibleLength(marker));
      const words = line.trim().split(/\s+/);
      const out = [];
      let current = indent;
      let currentIsFirst = true;
      for (const word of words) {
        const candidate = current === (currentIsFirst ? indent : hang) ? current + word : `${current} ${word}`;
        if (visibleLength(candidate) > width && current.trim()) {
          out.push(current);
          current = hang + word;
          currentIsFirst = false;
        } else {
          current = candidate;
        }
      }
      if (current.trim()) out.push(current);
      return out.join('\n');
    })
    .join('\n');
}

/** Terminal width, with a sane floor for pipes and CI where columns is undefined. */
function terminalWidth() {
  const cols = process.stdout.columns;
  return Number.isFinite(cols) && cols > 20 ? cols : 80;
}

/** Rough display width of a markdown cell: emphasis markers do not survive rendering. */
function cellWidth(text) {
  return String(text ?? '')
    .replace(/\*\*|__|[*_`]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .length;
}

/**
 * Column widths that fit the actual terminal.
 *
 * cli-table3 sizes to content and will happily emit a 290-character table,
 * which the terminal then wraps mid-cell — the row structure is destroyed and
 * the column rules no longer line up with anything. Observed on a real
 * `shumi ask` answer: a three-column Driver/Evidence/Read table where one cell
 * held a full sentence.
 *
 * Returns null when the natural table already fits, so narrow tables keep
 * cli-table3's own tighter sizing and are byte-identical to before.
 */
function fitColumns(token) {
  const cols = token.header.length;
  if (!cols) return null;
  const natural = token.header.map((h, i) =>
    Math.max(cellWidth(h.text), ...token.rows.map((r) => cellWidth(r[i]?.text))),
  );
  // cli-table3 chrome: one border per column plus a trailing one, and one space
  // of padding either side of every cell.
  const chrome = cols + 1 + 2 * cols;
  const budget = terminalWidth() - chrome - 1;
  const total = natural.reduce((a, b) => a + b, 0);
  if (total <= budget) return null;

  const MIN = 6;
  if (budget < cols * MIN) return natural.map(() => MIN + 2);

  // Give every column its minimum, then share what is left in proportion to how
  // much each column actually wants — so a one-word column stays narrow and the
  // prose column absorbs the squeeze.
  const spare = budget - cols * MIN;
  const want = natural.map((n) => Math.max(0, n - MIN));
  const wantTotal = want.reduce((a, b) => a + b, 0) || 1;
  const widths = want.map((w) => MIN + Math.floor((w / wantTotal) * spare));
  // Hand any rounding remainder to the widest column.
  const used = widths.reduce((a, b) => a + b, 0);
  if (used < budget) widths[natural.indexOf(Math.max(...natural))] += budget - used;
  return widths.map((w) => w + 2); // cli-table3 counts padding inside colWidths
}

function buildMarked() {
  const extension = markedTerminal({
    width: terminalWidth(),
    reflowText: true,
  });
  const renderer = extension.renderer;

  // NOTE: these wrappers must be called with marked's own renderer as `this`,
  // never bound. Each function markedTerminal installs copies `this.parser`
  // onto its internal Renderer before delegating; bind it to the wrong object
  // and that copy becomes undefined, which surfaces much later as
  // "Cannot read properties of undefined (reading 'parse')" inside listitem.

  // Patch 1 — inline formatting inside list items.
  //
  // marked-terminal's `text` renderer reads `token.text`, the RAW source, and
  // never looks at `token.tokens`. Paragraphs escape this because marked calls
  // parseInline before reaching the paragraph renderer; list items do not, so
  // `**Main cause:**` reached the terminal as literal asterisks while the very
  // same markup rendered bold in a table cell one line above. Affects bulleted
  // and ordered lists alike.
  const baseText = renderer.text;
  renderer.text = function patchedText(token) {
    if (token && typeof token === 'object' && Array.isArray(token.tokens) && token.tokens.length) {
      // Leaf text tokens carry no `tokens`, so this terminates.
      return this.parser.parseInline(token.tokens);
    }
    return baseText.call(this, token);
  };

  // Patch 2 — tables are rendered here rather than by marked-terminal.
  //
  // Not preference: marked-terminal reads `tableOptions` ONCE, in its
  // constructor, into a Renderer instance it does not expose. Column widths
  // have to be computed per table from the content, so there is no way to hand
  // them over after construction. Owning the ~15 lines is simpler and less
  // fragile than reaching into the library's internals.
  renderer.table = function patchedTable(token) {
    // A table with no rows and nothing in its header is not a table. Models
    // emit these as a stray delimiter line, and it renders as an empty box
    // above the real content.
    const headerEmpty = (token.header || []).every((h) => !String(h?.text ?? '').trim());
    if (headerEmpty && !(token.rows || []).length) return '';

    const inline = (cell) => (cell?.tokens ? this.parser.parseInline(cell.tokens) : String(cell?.text ?? ''));
    const colWidths = fitColumns(token);
    const table = new Table({
      head: token.header.map(inline),
      colAligns: (token.align || []).map((a) => a || 'left'),
      // The key must be ABSENT when the table already fits — cli-table3 indexes
      // into colWidths unconditionally once the property exists, so passing
      // `undefined` throws on every narrow table.
      ...(colWidths ? { colWidths } : {}),
      wordWrap: true,
      wrapOnWordBoundary: true,
      style: { head: [], border: [] },
    });
    for (const row of token.rows) table.push(row.map(inline));
    return `\n${table.toString()}\n\n`;
  };

  // Patch 3 — wrap list blocks to the terminal.
  //
  // marked-terminal's reflowText only reaches paragraphs and blockquotes, so a
  // long bullet ran to 184 characters in a 100-column terminal. Wrapping after
  // the base renderer runs is the only point at which the indent it adds is known.
  const baseList = renderer.list;
  renderer.list = function patchedList(token) {
    return wrapBlock(baseList.call(this, token), terminalWidth());
  };

  return new Marked(extension);
}

// Width is read when the renderer is built. Rebuild on resize so a table
// rendered after the user drags the window still fits it.
let marked = buildMarked();
let lastWidth = terminalWidth();

export function renderText(text) {
  if (!text) {
    console.log(chalk.yellow('No response received.'));
    return;
  }
  if (terminalWidth() !== lastWidth) {
    lastWidth = terminalWidth();
    marked = buildMarked();
  }
  console.log(marked.parse(text));
}

export function renderRaw(data) {
  console.log(JSON.stringify(data, null, 2));
}

export const __internal = { fitColumns, cellWidth, terminalWidth, wrapBlock, visibleLength };
