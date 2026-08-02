import chalk from 'chalk';
import ora from 'ora';
import { login, logout } from '../lib/auth.js';
import { getToken, getWalletAddress } from '../lib/config.js';
import { capture, truncWallet, identifyWallet } from '../lib/telemetry.js';

export function registerAuthCommands(program) {
  program
    .command('login')
    .description('authenticate with shumi via browser')
    .action(async () => {
      const existingToken = getToken();
      if (existingToken) {
        const wallet = getWalletAddress();
        console.log(chalk.yellow(`Already authenticated as ${truncate(wallet)}`));
        console.log('Run "shumi logout" first to re-authenticate.');
        return;
      }

      console.log('Opening browser for authentication...');
      const authStartedAt = Date.now();
      const spinner = ora({ text: 'waiting for authentication...', spinner: 'dots' }).start();

      // After ~30s, nudge the user toward the browser tab — that's where the
      // sign-in actually happens, and where people tend to get stuck.
      const hintTimer = setTimeout(() => {
        spinner.text = 'waiting for authentication... finish sign-in in the browser tab';
      }, 30000);

      try {
        const { walletAddress } = await login({
          onUrl: (url) => {
            spinner.stop();
            console.log(`If the browser didn't open, visit this URL:\n  ${chalk.cyan(url)}`);
            spinner.start();
          },
        });
        clearTimeout(hintTimer);
        spinner.succeed(`Authenticated as ${truncate(walletAddress)}`);
        try {
          // Stitch the anonymous device session into the wallet person first,
          // so this and all future events attribute to one cross-surface person.
          identifyWallet(walletAddress);
          capture('auth_success', { wallet_truncated: truncWallet(walletAddress) });
        } catch { /* telemetry must never affect auth */ }
      } catch (error) {
        clearTimeout(hintTimer);
        if (error.timedOut) {
          try {
            capture('auth_timeout', { elapsed_ms: Date.now() - authStartedAt });
          } catch { /* ignore */ }
          spinner.fail('Authentication timed out.');
          console.log('');
          // The browser tab diagnoses the stall itself and names the cause on
          // screen, so point there first. This list stays a guess for the case
          // where the tab was closed before it could say anything.
          console.log('Sign-in happens in the browser tab, and that tab shows what went wrong.');
          console.log('If you closed it, the usual causes are:');
          console.log(`  ${chalk.dim('•')} an ad blocker, privacy extension, or VPN blocking sign-in`);
          console.log(`  ${chalk.dim('•')} a private or incognito window, which blocks the storage sign-in needs`);
          console.log(`  ${chalk.dim('•')} the wallet connection was never finished`);
          console.log(`  ${chalk.dim('•')} the connected wallet doesn't hold SHUMI`);
          console.log('');
          console.log(`Re-run ${chalk.cyan('shumi login')} and connect the wallet that holds your SHUMI.`);
        } else {
          spinner.fail(error.message);
        }
        process.exitCode = 1;
      }
    });

  program
    .command('logout')
    .description('clear stored credentials')
    .action(() => {
      logout();
      console.log('Logged out successfully.');
    });

  program
    .command('whoami')
    .description('show current authentication status')
    .action(() => {
      const token = getToken();
      const wallet = getWalletAddress();

      if (!token) {
        console.log(chalk.yellow('Not authenticated. Run: shumi login'));
        return;
      }

      console.log(`Wallet: ${wallet}`);
      console.log(`Status: ${chalk.green('authenticated')}`);
    });
}

function truncate(address) {
  if (!address || address.length < 10) return address || '';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
