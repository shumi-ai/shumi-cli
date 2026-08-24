import chalk from 'chalk';
import ora from 'ora';
import { healthCheck } from '../lib/api-client.js';
import { getToken, getWalletAddress, getDeviceId } from '../lib/config.js';
import { renderOk, resolveMode } from '../lib/output.js';

export function registerHealthCommand(program) {
  program
    .command('health')
    .description('check shumi service connectivity')
    .action(async (_options, cmd) => {
      const opts = cmd.optsWithGlobals();
      const mode = resolveMode(opts);

      // The spinner is a TTY affordance. It used to start unconditionally, so
      // `--agent` runs got "- checking..." written to stderr on every call.
      const spinner = mode.json ? null : ora({ text: 'checking...', spinner: 'dots' }).start();

      const result = await healthCheck();
      if (spinner) spinner.stop();

      const token = getToken();
      const wallet = getWalletAddress();

      // Shape fixed by the manifest: { service, auth, wallet, device }.
      const data = {
        service: result.ok ? 'online' : 'offline',
        auth: token ? 'authenticated' : 'unauthenticated',
        wallet: token ? wallet : null,
        device: getDeviceId(),
        ...(result.ok ? {} : { error: result.error || result.status || null }),
      };

      renderOk({ schemaVersion: 1, data }, opts, (d) => {
        process.stdout.write('\n');
        process.stdout.write(chalk.bold('Shumi Health Check\n'));
        process.stdout.write('─'.repeat(40) + '\n');
        process.stdout.write(
          d.service === 'online'
            ? `Service:  ${chalk.green('online')}\n`
            : `Service:  ${chalk.red('offline')} (${d.error})\n`,
        );
        if (d.auth === 'authenticated') {
          process.stdout.write(`Auth:     ${chalk.green('authenticated')}\n`);
          process.stdout.write(`Wallet:   ${d.wallet}\n`);
        } else {
          process.stdout.write(`Auth:     ${chalk.yellow('not authenticated')}\n`);
        }
        process.stdout.write(`Device:   ${d.device}\n`);
        process.stdout.write('\n');
      });
    });
}
