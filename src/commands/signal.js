import chalk from 'chalk';
import { apiGet } from '../lib/api-client.js';
import { renderOk, renderErr, spinner } from '../lib/output.js';
import { withSchema } from '../lib/schema.js';
import { ApiError } from '../lib/api-client.js';

/**
 * True when the synthesis ran but nothing actually resolved the symbol.
 *
 * `/api/cli/signal/<symbol>` answers 200 for a symbol that does not exist. It
 * reports the miss honestly inside the bundle — raw.risk carries
 * `{ error: 'Unknown symbol: …', data: null }` — but the envelope around it
 * still says verdict "neutral", score 0, confidence "medium", and marks
 * risk_context "fulfilled", because the HTTP call itself settled. Rendering
 * that verbatim turns a typo into a confident-looking reading of a coin that
 * does not exist: `shumi marekt health` printed a neutral verdict for
 * "MAREKT" and exited 0.
 *
 * Detected on the bundle rather than on a message string: a verdict with no
 * evidence and no resolved risk data is not a verdict, whatever the upstream
 * wording is.
 */
export function symbolDidNotResolve(d) {
  if (!d || typeof d !== 'object') return false;
  const risk = d.raw?.risk;
  const riskMissing = Boolean(risk && risk.error && risk.data == null);
  const noEvidence = Array.isArray(d.evidence) && d.evidence.length === 0;
  return riskMissing && noEvidence && !d.as_of;
}

const VERDICT_COLOR = {
  'strong-bull': chalk.green.bold,
  'bull': chalk.green,
  'neutral': chalk.dim,
  'bear': chalk.red,
  'strong-bear': chalk.red.bold,
};

/**
 * Fetch + render a synthesized signal for one symbol. Shared by the `signal`
 * command and the bare-ticker shortcut (`shumi BTC`) so both behave identically.
 */
export async function runSignal(symbol, opts) {
  const sp = spinner(`synthesizing signal for ${symbol}…`, opts);
  try {
    const env = await apiGet(`signal/${encodeURIComponent(symbol)}`);
    sp.stop();

    if (symbolDidNotResolve(env?.data)) {
      const detail = env.data.raw?.risk?.error || `Unknown symbol: ${symbol}`;
      throw new ApiError(404, {
        error: {
          code: 'UPSTREAM_4XX',
          message: `${detail}. Try \`shumi resolve ${symbol}\` to find the right ticker.`,
        },
      });
    }

    renderOk(env, opts, (d) => {
      const color = VERDICT_COLOR[d.verdict] || chalk.dim;
      process.stdout.write(`\n${chalk.bold(d.symbol)}  ${color(d.verdict.toUpperCase())}  ${chalk.dim(`(score ${d.score}, confidence ${d.confidence})`)}\n`);
      if (d.as_of) process.stdout.write(chalk.dim(`as of ${d.as_of}\n`));
      process.stdout.write('\n');
      for (const line of d.evidence) {
        process.stdout.write(`  ${chalk.cyan('•')} ${line}\n`);
      }
      process.stdout.write('\n');
      const failed = Object.entries(d.sources).filter(([, s]) => s !== 'fulfilled').map(([k]) => k);
      if (failed.length) {
        process.stdout.write(chalk.yellow(`(missing inputs: ${failed.join(', ')} — verdict confidence reduced)\n`));
      }
      process.stdout.write(chalk.dim('full bundle: shumi signal ' + d.symbol + ' --json | jq .data.raw\n'));
    });
  } catch (err) { sp.stop(); renderErr(err, opts); }
}

export function registerSignalCommand(program) {
  const cmd = program
    .command('signal')
    .argument('<symbol>', 'coin symbol (e.g. BTC)')
    .description('synthesized verdict for a coin (trend + funding + sentiment + regime)')
    .action(async function (symbol) {
      await runSignal(symbol, this.optsWithGlobals());
    });

  withSchema(cmd, {
    kind: 'object',
    fields: {
      symbol: 'string',
      verdict: 'enum: strong-bull | bull | neutral | bear | strong-bear',
      score: 'number (-4 to +4)',
      confidence: 'enum: high | medium | low',
      as_of: 'ISO timestamp of freshest underlying data',
      evidence: 'string[] (human-readable bullet points)',
      sources: 'object — fulfilled/rejected status per upstream',
      raw: 'object — risk, funding, regime, sentiment bundles',
    },
    example: {
      symbol: 'BTC',
      verdict: 'bull',
      score: 1.5,
      confidence: 'high',
      as_of: '2026-05-17T08:12:00Z',
      evidence: ['trend (daily) is UP since 2026-05-12', 'funding APR 8.3% (percentile 65, tier warm)'],
    },
  });
}
