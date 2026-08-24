import chalk from 'chalk';
import ora from 'ora';
import { createKey, listKeys, revokeKey } from '../lib/api-client.js';
import { capture } from '../lib/telemetry.js';
import { renderOk, renderErr, resolveMode } from '../lib/output.js';

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
    .action(async (name, _options, cmd) => {
      const opts = cmd.optsWithGlobals();
      const mode = resolveMode(opts);
      const spinner = mode.json ? null : ora({ text: 'creating key...', spinner: 'dots' }).start();

      try {
        const result = await createKey(name);
        if (spinner) spinner.stop();

        // The key is shown exactly once. Printing it only as chalk-coloured
        // prose meant a caller automating key creation had no structured way
        // to capture it, despite the manifest advertising `{ key, name }`.
        renderOk({ schemaVersion: 1, data: { key: result.key, name: result.name } }, opts, (d) => {
          process.stdout.write('\n');
          process.stdout.write(chalk.green.bold('API key created\n'));
          process.stdout.write('─'.repeat(60) + '\n\n');
          process.stdout.write(chalk.bold('Key:  ') + chalk.cyan(d.key) + '\n');
          process.stdout.write(chalk.bold('Name: ') + d.name + '\n\n');
          process.stdout.write(chalk.yellow('Save this key now — it will not be shown again.\n\n'));
          process.stdout.write(chalk.dim('Usage:\n'));
          process.stdout.write(chalk.dim(`  SHUMI_TOKEN=${d.key} shumi coin BTC\n\n`));
        });
        captureKeyLifecycle('create', true);
      } catch (error) {
        if (spinner) spinner.stop();
        captureKeyLifecycle('create', false);
        renderErr(error, opts);
      }
    });

  keys
    .command('list')
    .description('list your API keys')
    .action(async (_options, cmd) => {
      const opts = cmd.optsWithGlobals();
      const mode = resolveMode(opts);
      const spinner = mode.json ? null : ora({ text: 'fetching keys...', spinner: 'dots' }).start();

      try {
        const result = await listKeys();
        if (spinner) spinner.stop();
        captureKeyLifecycle('list', true);

        const keyList = Array.isArray(result.keys) ? result.keys : [];
        renderOk({ schemaVersion: 1, data: { keys: keyList } }, opts, (d) => {
          if (d.keys.length === 0) {
            process.stdout.write(chalk.dim('No API keys found. Create one with: shumi keys create\n'));
            return;
          }
          process.stdout.write('\n');
          process.stdout.write(chalk.bold('Your API Keys\n'));
          process.stdout.write('─'.repeat(60) + '\n');
          for (const key of d.keys) {
            const status = key.revoked_at
              ? chalk.red('revoked')
              : key.expires_at && new Date(key.expires_at) < new Date()
                ? chalk.yellow('expired')
                : chalk.green('active');
            const date = new Date(key.created_at).toLocaleDateString();
            process.stdout.write(`  ${chalk.cyan(key.prefix)}  ${key.name.padEnd(20)}  ${status}  ${chalk.dim(date)}\n`);
          }
          process.stdout.write('\n');
        });
      } catch (error) {
        if (spinner) spinner.stop();
        captureKeyLifecycle('list', false);
        renderErr(error, opts);
      }
    });

  keys
    .command('revoke')
    .argument('<prefix>', 'key prefix to revoke (from "shumi keys list")')
    .description('revoke an API key')
    .action(async (prefix, _options, cmd) => {
      const opts = cmd.optsWithGlobals();
      const mode = resolveMode(opts);
      const spinner = mode.json ? null : ora({ text: 'revoking key...', spinner: 'dots' }).start();

      try {
        await revokeKey(prefix);
        if (spinner) spinner.stop();
        captureKeyLifecycle('revoke', true);
        renderOk({ schemaVersion: 1, data: { prefix, revoked: true } }, opts, (d) => {
          process.stdout.write(`Key ${chalk.cyan(d.prefix)} revoked\n`);
        });
      } catch (error) {
        if (spinner) spinner.stop();
        captureKeyLifecycle('revoke', false);
        renderErr(error, opts);
      }
    });
}
