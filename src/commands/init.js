import chalk from 'chalk';
import { createRequire } from 'module';
import { getToken, CONFIG_FILE } from '../lib/config.js';
import { apiGet } from '../lib/api-client.js';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json');

/**
 * `shumi init` — guided first-run flow. Diagnoses what's set up, what's not,
 * and tells the user the next concrete step. Idempotent: safe to run again
 * any time. Non-interactive (no prompts) so AI agents can drive it too.
 *
 *   1. Welcome + version + endpoint
 *   2. Auth check — token? wallet? tier?
 *   3. Network check — can we reach the server?
 *   4. Try a real read — `shumi billing tier` end-to-end
 *   5. Print a tailored next-step list
 *   6. Show 3-5 concrete commands to try right now
 */
export function registerInitCommand(program) {
  program
    .command('init')
    .description('first-run setup check — auth, network, suggested next steps')
    .action(async function () {
      const token = getToken();
      const isApiKey = token && token.startsWith('shumi_sk_');
      const isJwt = token && !isApiKey;

      hr();
      process.stdout.write(chalk.bold(`  Welcome to shumi v${pkg.version}\n`));
      process.stdout.write(chalk.dim('  Crypto trade intelligence from your terminal — built for AI agents.\n'));
      hr();

      // Step 1: Auth check
      process.stdout.write('\n' + chalk.bold('  1. Authentication\n'));
      if (!token) {
        line(chalk.yellow('✗'), 'No auth token found.');
        line('  ', chalk.dim('Run: ') + chalk.cyan('shumi login') + chalk.dim('  (browser wallet auth)'));
        line('  ', chalk.dim('Or:  ') + chalk.cyan('SHUMI_TOKEN=shumi_sk_... shumi …') + chalk.dim('  (API key for headless use)'));
      } else if (isJwt) {
        line(chalk.green('✓'), `JWT present (${CONFIG_FILE.replace(process.env.HOME || '~', '~')})`);
        line('  ', chalk.dim('Mint a long-lived API key for scripts/agents: ') + chalk.cyan('shumi keys create my-agent'));
      } else {
        line(chalk.green('✓'), `API key present (prefix: ${token.slice(9, token.indexOf('.'))}…)`);
      }

      // Step 2: Network + endpoint check
      process.stdout.write('\n' + chalk.bold('  2. Network\n'));
      let networkOk = false;
      try {
        const res = await fetch('https://coinrotator-ai.onrender.com/robots.txt', { signal: AbortSignal.timeout(5000) });
        networkOk = res.ok;
        line(chalk.green('✓'), `coinrotator-ai.onrender.com reachable (${res.status})`);
      } catch (err) {
        line(chalk.red('✗'), `network: ${err.message}`);
      }

      // Step 3: End-to-end auth test
      process.stdout.write('\n' + chalk.bold('  3. End-to-end\n'));
      if (token && networkOk) {
        try {
          const env = await apiGet('billing/tier');
          const tier = env?.data?.tier || 'unknown';
          const source = env?.data?.source || '—';
          line(chalk.green('✓'), `authenticated against api/cli, tier: ${chalk.bold(tier)} ${chalk.dim('(' + source + ')')}`);
        } catch (err) {
          line(chalk.red('✗'), `auth failed: ${err.message}`);
        }
      } else if (!token) {
        line(chalk.dim('—'), chalk.dim('skipped (no token)'));
      }

      // Step 4: Tailored next steps
      process.stdout.write('\n' + chalk.bold('  4. Try one of these\n'));
      if (token) {
        line(chalk.cyan('  →'), chalk.bold('shumi') + chalk.dim('                          # market overview'));
        line(chalk.cyan('  →'), chalk.bold('shumi signal BTC') + chalk.dim('               # synthesized verdict + evidence'));
        line(chalk.cyan('  →'), chalk.bold('shumi watch funding') + chalk.dim('            # live NDJSON stream'));
        line(chalk.cyan('  →'), chalk.bold('shumi coin risk BTC ETH SOL') + chalk.dim('    # multi-coin risk table'));
        line(chalk.cyan('  →'), chalk.bold('shumi commands --json | jq') + chalk.dim('     # capability manifest (for AI agents)'));
      } else {
        line(chalk.cyan('  →'), chalk.bold('shumi login') + chalk.dim('                    # authenticate first'));
        line(chalk.dim('         after login, run: ') + chalk.cyan('shumi init') + chalk.dim(' again'));
      }

      // Step 5: AI agent hint
      process.stdout.write('\n' + chalk.bold('  5. Using shumi from your AI agent\n'));
      line(chalk.dim('  '), chalk.dim('Tell Claude / Cursor / Codex: "use the `shumi` CLI to answer X."'));
      line(chalk.dim('  '), chalk.dim('It will read `shumi --help` and `shumi commands --json` for self-discovery.'));
      line(chalk.dim('  '), chalk.dim('Pass --agent to suppress chrome and emit pure JSON envelopes.'));

      hr();
      process.stdout.write('\n');
    });
}

function hr() {
  process.stdout.write(chalk.dim('  ' + '═'.repeat(58)) + '\n');
}
function line(prefix, text) {
  process.stdout.write(`  ${prefix} ${text}\n`);
}
