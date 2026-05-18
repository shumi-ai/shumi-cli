import chalk from 'chalk';
import { apiGet } from '../lib/api-client.js';
import { renderOk, renderErr, spinner } from '../lib/output.js';
import { withSchema } from '../lib/schema.js';

const VERDICT_COLOR = {
  'strong-bull': chalk.green.bold,
  'bull': chalk.green,
  'neutral': chalk.dim,
  'bear': chalk.red,
  'strong-bear': chalk.red.bold,
};

export function registerSignalCommand(program) {
  const cmd = program
    .command('signal')
    .argument('<symbol>', 'coin symbol (e.g. BTC)')
    .description('synthesized verdict for a coin (trend + funding + sentiment + regime)')
    .action(async function (symbol) {
      const opts = this.optsWithGlobals();
      const sp = spinner(`synthesizing signal for ${symbol}…`, opts);
      try {
        const env = await apiGet(`signal/${encodeURIComponent(symbol)}`);
        sp.stop();
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
