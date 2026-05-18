import { apiGet } from '../lib/api-client.js';
import { renderOk, renderErr, spinner } from '../lib/output.js';
import { typedAction, addUniversalFlags } from '../lib/typedCmd.js';
import { withSchema } from '../lib/schema.js';

export function registerFundingCommand(program) {
  const funding = program
    .command('funding')
    .description('perpetual funding-rate intelligence');

  const alerts = funding
    .command('alerts')
    .description('discrete funding-rate alert events')
    .action(typedAction({ route: 'funding/alerts', spinner: 'funding alerts…' }));
  withSchema(alerts, {
    kind: 'object',
    fields: { events: 'array of {asset, triggerZone, fundingAtTrigger, firedAt}', meta: 'object — { total }' },
  });

  const momentum = funding
    .command('momentum')
    .description('market-wide or per-symbol funding momentum')
    .option('--symbol <symbol>', 'restrict to one symbol (e.g. BTC)')
    .action(async function () {
      const opts = this.optsWithGlobals();
      const sp = spinner(opts.symbol ? `funding momentum for ${opts.symbol}…` : 'market funding momentum…', opts);
      try {
        const env = await apiGet('funding/momentum', opts.symbol ? { symbol: opts.symbol } : {});
        sp.stop();
        renderOk(env, opts, (data) => {
          const d = data;
          if (d.symbol) {
            process.stdout.write(`${d.symbol}  apr=${pct(d.apr)}  percentile=${d.percentile}  tier=${d.tier}  size×=${d.sizeMult}\n`);
            const m = d.market || {};
            process.stdout.write(`market   temp=${m.temperature}  avgApr=${pct(m.avgApr)}  +${m.positive}/-${m.negative} of ${m.total}\n`);
          } else if (d.market) {
            const m = d.market;
            process.stdout.write(`market temp=${m.temperature}  avgApr=${pct(m.avgApr)}  +${m.positive}/-${m.negative} of ${m.total}\n`);
            const dist = d.distribution || {};
            process.stdout.write(`distribution  p10=${pct(dist.p10)}  p50=${pct(dist.p50)}  p90=${pct(dist.p90)}\n`);
          } else {
            process.stdout.write(JSON.stringify(d, null, 2) + '\n');
          }
        });
      } catch (err) { sp.stop(); renderErr(err, opts); }
    });
  withSchema(momentum, {
    kind: 'object',
    fields: {
      symbol: 'string (when --symbol provided)',
      apr: 'number — annualized funding rate in PERCENT units (1.7 = 1.7%)',
      percentile: 'number 0..1 — rank vs other tracked assets',
      tier: 'enum: cool | neutral | warm | hot',
      market: 'object — { temperature, avgApr, positive, negative, total }',
      distribution: 'object — p10/p25/p50/p75/p90/min/max/totalAssets',
      assets: 'array (market-wide mode only)',
    },
  });
}

function pct(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return `${(Number(n) * 100).toFixed(2)}%`;
}
