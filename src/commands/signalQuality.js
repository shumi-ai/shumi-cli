import { apiGet } from '../lib/api-client.js';
import { renderOk, renderErr, spinner } from '../lib/output.js';

export function registerSignalQualityCommand(program) {
  program
    .command('signal-quality')
    .description('signal validation envelope (Sharpe, win rate, sample size)')
    .requiredOption('--asset <symbol>', 'asset symbol (e.g. BTC, ETH)')
    .option('--signal-type <type>', 'signal type (default: mean_reversion)')
    .action(async function () {
      const opts = this.optsWithGlobals();
      const sp = spinner(`signal quality for ${opts.asset}…`, opts);
      try {
        const env = await apiGet('signal-quality', {
          asset: opts.asset,
          ...(opts.signalType && { signal_type: opts.signalType }),
        });
        sp.stop();
        renderOk(env, opts, (d) => process.stdout.write(JSON.stringify(d, null, 2) + '\n'));
      } catch (err) { sp.stop(); renderErr(err, opts); }
    });
}
