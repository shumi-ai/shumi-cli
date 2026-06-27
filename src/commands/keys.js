import chalk from 'chalk';
import ora from 'ora';
import { createKey, listKeys, revokeKey } from '../lib/api-client.js';
import { capture } from '../lib/telemetry.js';

/** Emit api_key_lifecycle. Never the key value — action + success only. */
function captureKeyLifecycle(action, success) {
  try {
    capture('api_key_lifecycle', { action, success });
  } catch { /* telemetry must never affect the command */ }
}

export function registerKeysCommand(program) {
  const keys = program
    .command('keys')
    .description('manage API keys for server/bot deployments');

  keys
    .command('create')
    .argument('[name]', 'key name for identification', 'Default')
    .description('create a new API key')
    .action(async (name) => {
      const spinner = ora({ text: 'creating key...', spinner: 'dots' }).start();

      try {
        const result = await createKey(name);
        spinner.stop();

        console.log('');
        console.log(chalk.green.bold('API key created'));
        console.log('─'.repeat(60));
        console.log('');
        console.log(chalk.bold('Key:  ') + chalk.cyan(result.key));
        console.log(chalk.bold('Name: ') + result.name);
        console.log('');
        console.log(chalk.yellow('Save this key now — it will not be shown again.'));
        console.log('');
        console.log(chalk.dim('Usage:'));
        console.log(chalk.dim(`  SHUMI_TOKEN=${result.key} shumi coin BTC`));
        console.log('');
        captureKeyLifecycle('create', true);
      } catch (error) {
        spinner.fail(error.message);
        captureKeyLifecycle('create', false);
        process.exitCode = 1;
      }
    });

  keys
    .command('list')
    .description('list your API keys')
    .action(async () => {
      const spinner = ora({ text: 'fetching keys...', spinner: 'dots' }).start();

      try {
        const result = await listKeys();
        spinner.stop();

        captureKeyLifecycle('list', true);

        if (!result.keys || result.keys.length === 0) {
          console.log(chalk.dim('No API keys found. Create one with: shumi keys create'));
          return;
        }

        console.log('');
        console.log(chalk.bold('Your API Keys'));
        console.log('─'.repeat(60));

        for (const key of result.keys) {
          const status = key.revoked_at
            ? chalk.red('revoked')
            : key.expires_at && new Date(key.expires_at) < new Date()
              ? chalk.yellow('expired')
              : chalk.green('active');

          const date = new Date(key.created_at).toLocaleDateString();
          console.log(`  ${chalk.cyan(key.prefix)}  ${key.name.padEnd(20)}  ${status}  ${chalk.dim(date)}`);
        }
        console.log('');
      } catch (error) {
        spinner.fail(error.message);
        captureKeyLifecycle('list', false);
        process.exitCode = 1;
      }
    });

  keys
    .command('revoke')
    .argument('<prefix>', 'key prefix to revoke (from "shumi keys list")')
    .description('revoke an API key')
    .action(async (prefix) => {
      const spinner = ora({ text: 'revoking key...', spinner: 'dots' }).start();

      try {
        await revokeKey(prefix);
        spinner.succeed(`Key ${chalk.cyan(prefix)} revoked`);
        captureKeyLifecycle('revoke', true);
      } catch (error) {
        spinner.fail(error.message);
        captureKeyLifecycle('revoke', false);
        process.exitCode = 1;
      }
    });
}
