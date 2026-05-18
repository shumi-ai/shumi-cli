import chalk from 'chalk';
import { apiGet } from '../lib/api-client.js';
import { renderOk, renderErr, spinner } from '../lib/output.js';

export function registerBillingCommand(program) {
  const billing = program
    .command('billing')
    .description('account entitlement and usage');

  billing
    .command('tier')
    .description('show current tier, source, and expiry')
    .action(async function () {
      const opts = this.optsWithGlobals();
      const sp = spinner('fetching tier…', opts);
      try {
        const env = await apiGet('billing/tier');
        sp.stop();
        renderOk(env, opts, (d) => {
          const tierColor = d.tier === 'pro' ? chalk.green : d.tier === 'access' ? chalk.cyan : chalk.dim;
          process.stdout.write(`tier      ${tierColor(d.tier || 'free')}\n`);
          process.stdout.write(`source    ${d.source || '—'}\n`);
          process.stdout.write(`expires   ${d.expiresAt ? new Date(d.expiresAt).toISOString() : 'never'}\n`);
          process.stdout.write(`identity  ${d.identity?.kind || '—'}\n`);
        });
      } catch (err) { sp.stop(); renderErr(err, opts); }
    });
}
