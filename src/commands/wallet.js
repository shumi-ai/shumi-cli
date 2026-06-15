import chalk from 'chalk';
import { renderOk, renderErr, spinner } from '../lib/output.js';
import { homedir } from 'os';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import {
  hasKeystore, hasEnvKey, hasWallet, readKeystoreAddress,
  createKeystore, getUsdcBalance, buildOnrampUrl, loadPrivateKey,
} from '../lib/wallet.js';
import { promptHidden, promptYesNo } from '../lib/prompt.js';

const NO_WALLET_HINT = 'Run `shumi wallet create` to generate one, or set SHUMI_X402_PRIVATE_KEY in your environment.';

export function registerWalletCommand(program) {
  const wallet = program
    .command('wallet')
    .description('x402 payment wallet — receive USDC on Base for pay-per-query');

  wallet
    .command('address')
    .description('print the address of the wallet that will sign x402 payments')
    .action(function () {
      const opts = this.optsWithGlobals();
      try {
        if (!hasWallet()) {
          renderErr({ message: 'No wallet configured.', hint: NO_WALLET_HINT }, opts);
          return;
        }
        const address = readKeystoreAddress();
        renderOk({
          data: {
            address,
            source: hasEnvKey() ? 'env:SHUMI_X402_PRIVATE_KEY' : 'keystore:~/.shumi/wallet.json',
            network: 'base',
          },
        }, opts, (d) => {
          process.stdout.write(`address  ${chalk.cyan(d.address)}\n`);
          process.stdout.write(`source   ${d.source}\n`);
          process.stdout.write(`network  ${d.network}\n`);
        });
      } catch (err) {
        renderErr(err, opts);
      }
    });

  wallet
    .command('balance')
    .description('read USDC-on-Base balance for the active wallet')
    .action(async function () {
      const opts = this.optsWithGlobals();
      const sp = spinner('reading USDC balance on Base…', opts);
      try {
        if (!hasWallet()) {
          sp.stop();
          renderErr({ message: 'No wallet configured.', hint: NO_WALLET_HINT }, opts);
          return;
        }
        const address = readKeystoreAddress();
        const { formatted, raw } = await getUsdcBalance(address);
        sp.stop();
        renderOk({
          data: {
            address,
            balanceUsdc: formatted,
            balanceRawBaseUnits: raw.toString(),
            asset: 'USDC',
            network: 'base',
          },
        }, opts, (d) => {
          process.stdout.write(`address  ${chalk.cyan(d.address)}\n`);
          process.stdout.write(`balance  ${chalk.green('$' + d.balanceUsdc)} USDC on Base\n`);
        });
      } catch (err) {
        sp.stop();
        renderErr(err, opts);
      }
    });

  wallet
    .command('fund')
    .description('print a Coinbase Onramp deep link pre-filled for USDC-on-Base')
    .option('--amount <usd>', 'preset USD amount on the onramp form', '25')
    .action(async function (cmdOpts) {
      const opts = this.optsWithGlobals();
      try {
        if (!hasWallet()) {
          renderErr({ message: 'No wallet configured.', hint: NO_WALLET_HINT }, opts);
          return;
        }
        const address = readKeystoreAddress();
        const amount = parseFloat(cmdOpts.amount) || 25;
        const url = buildOnrampUrl(address, amount);
        renderOk({
          data: {
            address,
            onrampUrl: url,
            asset: 'USDC',
            network: 'base',
            presetUsd: amount,
            alternative: `Or send USDC directly to ${address} on Base (chain id 8453) from any wallet you control.`,
          },
        }, opts, (d) => {
          process.stdout.write(`Fund $${d.presetUsd} of ${d.asset} on ${d.network} via Coinbase Onramp:\n\n`);
          process.stdout.write(`  ${chalk.cyan(d.onrampUrl)}\n\n`);
          process.stdout.write(chalk.dim(`Or send USDC directly to ${d.address} on Base.\n`));
        });
      } catch (err) {
        renderErr(err, opts);
      }
    });

  wallet
    .command('receipts')
    .description('show recent x402 payment receipts (last 20)')
    .option('--limit <n>', 'how many receipts to show', '20')
    .action(async function (cmdOpts) {
      const opts = this.optsWithGlobals();
      try {
        const limit = parseInt(cmdOpts.limit, 10) || 20;
        const logPath = join(homedir(), '.shumi', 'payments.log');
        if (!existsSync(logPath)) {
          renderOk({ data: { receipts: [], note: 'No payment receipts yet.' } }, opts, () => {
            process.stdout.write(chalk.dim('No payment receipts yet. Run a paid query first.\n'));
          });
          return;
        }
        const lines = readFileSync(logPath, 'utf8')
          .split('\n').filter(Boolean).slice(-limit);
        const receipts = lines.map((l) => {
          try { return JSON.parse(l); } catch { return { raw: l }; }
        });
        const totalUsdc = receipts.reduce((sum, r) => sum + (parseFloat(r.amountUsdc) || 0), 0);
        renderOk({
          data: {
            receipts,
            count: receipts.length,
            totalUsdcInWindow: totalUsdc.toFixed(6),
          },
        }, opts, () => {
          process.stdout.write(chalk.bold(`Last ${receipts.length} payments — total $${totalUsdc.toFixed(6)} USDC\n\n`));
          for (const r of receipts) {
            const ts = (r.ts || '').slice(0, 19).replace('T', ' ');
            const txDisplay = r.tx ? r.tx.slice(0, 12) + '…' : chalk.yellow('PENDING/FAILED');
            process.stdout.write(`${chalk.dim(ts)}  $${r.amountUsdc}  ${chalk.cyan(r.route || '?')}  ${chalk.dim(txDisplay)}\n`);
          }
        });
      } catch (err) {
        renderErr(err, opts);
      }
    });

  wallet
    .command('export')
    .description('decrypt and print the raw private key (for backup — handle with care)')
    .action(async function () {
      const opts = this.optsWithGlobals();
      try {
        if (hasEnvKey()) {
          renderErr({
            message: 'SHUMI_X402_PRIVATE_KEY is set; no keystore to export.',
            hint: 'The env-var key IS the private key. Read it from your environment.',
          }, opts);
          return;
        }
        if (!hasKeystore()) {
          renderErr({ message: 'No wallet keystore to export.', hint: NO_WALLET_HINT }, opts);
          return;
        }
        // Two confirmations before showing the key. Keystores are encrypted-at-rest
        // for a reason — printing the plaintext to a terminal defeats that, so we
        // make the user say "I really mean it" twice and warn loudly. JSON / agent
        // mode refuses entirely; this is interactive-human-only.
        if (opts.json || opts.agent) {
          renderErr({
            message: 'wallet export refuses to run in --json or --agent mode.',
            hint: 'Run interactively; we never emit a private key to a non-TTY.',
          }, opts);
          return;
        }
        process.stderr.write(chalk.yellow('\n⚠  About to print your private key to this terminal.\n'));
        process.stderr.write(chalk.yellow('   Anyone who sees it controls the funds in this wallet forever.\n\n'));
        const ok1 = await promptYesNo('Continue? [y/N] ', { defaultYes: false });
        if (!ok1) {
          renderErr({ message: 'Cancelled.' }, opts);
          return;
        }
        const pass = await promptHidden('Wallet passphrase: ');
        if (!pass) {
          renderErr({ message: 'Cancelled.' }, opts);
          return;
        }
        let pk;
        try {
          pk = loadPrivateKey({ passphrase: pass });
        } catch (err) {
          renderErr({ message: err.message }, opts);
          return;
        }
        const address = readKeystoreAddress();
        process.stdout.write(chalk.bold('\nAddress:     ') + chalk.cyan(address) + '\n');
        process.stdout.write(chalk.bold('Private key: ') + chalk.red(pk) + '\n\n');
        process.stdout.write(chalk.dim('Store this somewhere safe (a password manager).\n'));
        process.stdout.write(chalk.dim('To restore on another machine: set SHUMI_X402_PRIVATE_KEY=<this value>.\n'));
      } catch (err) {
        renderErr(err, opts);
      }
    });

  wallet
    .command('create')
    .description('generate a new wallet and encrypt with a passphrase')
    .action(async function () {
      const opts = this.optsWithGlobals();
      try {
        if (hasKeystore()) {
          renderErr({
            message: 'A wallet keystore already exists.',
            hint: 'Delete ~/.shumi/wallet.json if you really want to overwrite — your funds will become inaccessible without the old passphrase.',
          }, opts);
          return;
        }
        process.stdout.write(chalk.dim('Choose a passphrase (min 8 chars, NOT recoverable if lost).\n'));
        process.stdout.write(chalk.dim('Your private key never leaves this machine; the passphrase protects it at rest.\n\n'));
        const p1 = await promptHidden('Passphrase: ');
        if (!p1) {
          renderErr({ message: 'Cancelled.' }, opts);
          return;
        }
        if (p1.length < 8) {
          renderErr({ message: 'Passphrase must be at least 8 characters.' }, opts);
          return;
        }
        const p2 = await promptHidden('Confirm passphrase: ');
        if (p1 !== p2) {
          renderErr({ message: 'Passphrases do not match. Try again.' }, opts);
          return;
        }
        const address = createKeystore(p1);
        renderOk({
          data: {
            address,
            keystorePath: '~/.shumi/wallet.json',
            next: [
              'Fund the wallet: `shumi wallet fund`',
              'Check balance: `shumi wallet balance`',
              'Or subscribe for unlimited: https://shumi.ai/pricing',
            ],
          },
        }, opts, (d) => {
          process.stdout.write(chalk.green('✓ Wallet created.\n\n'));
          process.stdout.write(`address       ${chalk.cyan(d.address)}\n`);
          process.stdout.write(`keystore      ${d.keystorePath} (encrypted, 0600)\n\n`);
          process.stdout.write(chalk.bold('Next:\n'));
          for (const line of d.next) process.stdout.write(`  • ${line}\n`);
        });
      } catch (err) {
        renderErr(err, opts);
      }
    });
}
