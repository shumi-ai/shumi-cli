import { apiGet } from '../lib/api-client.js';
import { renderOk, renderErr, spinner } from '../lib/output.js';

export function registerRegimeCommand(program) {
  const regime = program
    .command('regime')
    .description('market regime signals (active state, confidence, history)');

  regime
    .command('active')
    .description('current active regime positions')
    .action(action('active'));

  regime
    .command('signals')
    .description('all regime signals')
    .action(action('signals'));

  regime
    .command('confidence')
    .description('regime confidence scores')
    .action(action('confidence'));

  regime
    .command('history')
    .argument('<symbol>', 'coin symbol')
    .description('regime history for a symbol')
    .action(async function (symbol) {
      const opts = this.optsWithGlobals();
      const sp = spinner(`regime history for ${symbol}…`, opts);
      try {
        const env = await apiGet('regime', { action: 'history', symbol });
        sp.stop();
        renderOk(env, opts, (d) => process.stdout.write(JSON.stringify(d, null, 2) + '\n'));
      } catch (err) { sp.stop(); renderErr(err, opts); }
    });
}

function action(name) {
  return async function () {
    const opts = this.optsWithGlobals();
    const sp = spinner(`regime ${name}…`, opts);
    try {
      const env = await apiGet('regime', { action: name });
      sp.stop();
      renderOk(env, opts, (d) => process.stdout.write(JSON.stringify(d, null, 2) + '\n'));
    } catch (err) { sp.stop(); renderErr(err, opts); }
  };
}
