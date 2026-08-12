import chalk from 'chalk';
import ora from 'ora';
import { login, logout, parseCallbackUrl, acceptCallbackCredential } from '../lib/auth.js';
import { getToken, getWalletAddress } from '../lib/config.js';
import { promptHidden, promptYesNo } from '../lib/prompt.js';
import { capture, truncWallet, identifyWallet } from '../lib/telemetry.js';

export function registerAuthCommands(program) {
  program
    .command('login')
    .description('authenticate with shumi via browser')
    .option('--paste', 'finish a sign-in whose browser callback failed (paste the URL when prompted)')
    .action(async (cmdOpts) => {
      if (cmdOpts?.paste) return recoverFromPastedCallback();

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
          // Lead with recovery, not diagnosis. If the user DID complete the
          // signature and the browser then showed connection-refused, the
          // token exists and is sitting in that dead tab's address bar —
          // re-running the whole flow throws away a working credential.
          console.log(`If you finished signing and the browser showed a connection error, your token was created.`);
          console.log(`Copy that page's URL and run ${chalk.cyan('shumi login --paste')}.`);
          console.log('');
          // The browser tab diagnoses the stall itself and names the cause on
          // screen, so point there first. This list stays a guess for the case
          // where the tab was closed before it could say anything.
          console.log('Otherwise, sign-in happens in the browser tab, and that tab shows what went wrong.');
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

/**
 * Recover a sign-in whose callback never reached the CLI.
 *
 * The URL is read from a hidden stdin prompt, not a flag: it carries a live
 * credential, and anything on argv lands in shell history and is readable by
 * any other local user via `ps`. Hidden input also keeps it out of the
 * terminal scrollback the user may later screen-share.
 */
async function recoverFromPastedCallback() {
  if (getToken()) {
    console.log(chalk.yellow(`Already authenticated as ${truncate(getWalletAddress())}`));
    console.log('Run "shumi logout" first to re-authenticate.');
    return;
  }

  console.log('Paste the URL the browser ended up on (the page that failed to load).');
  console.log(chalk.dim('Input is hidden. Press Enter when done, Ctrl-C to cancel.'));
  const pasted = await promptHidden('URL: ');
  if (!pasted) {
    console.log('Cancelled.');
    process.exitCode = 1;
    return;
  }

  let credential;
  try {
    credential = parseCallbackUrl(pasted);
  } catch (err) {
    console.log(chalk.red(`✗ ${err.message}`));
    process.exitCode = 1;
    return;
  }

  // Name the account before committing. A pasted URL is user-supplied input;
  // the state check proves it belongs to the sign-in they started, and this
  // shows them which wallet that turned out to be.
  const who = credential.email ? `${credential.email} (${truncate(credential.walletAddress)})` : truncate(credential.walletAddress);
  const confirmed = await promptYesNo(`Sign in as ${who}? (Y/n) `, { defaultYes: true });
  if (!confirmed) {
    console.log('Cancelled — nothing saved.');
    process.exitCode = 1;
    return;
  }

  acceptCallbackCredential(credential);
  console.log(chalk.green(`✓ Authenticated as ${truncate(credential.walletAddress)}`));
  try {
    identifyWallet(credential.walletAddress);
    capture('auth_success', { wallet_truncated: truncWallet(credential.walletAddress), method: 'paste' });
  } catch { /* telemetry must never affect auth */ }
}

function truncate(address) {
  if (!address || address.length < 10) return address || '';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
