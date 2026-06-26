import chalk from 'chalk';
import { buildManifest } from '../lib/manifest.js';
import { resolveMode } from '../lib/output.js';

/**
 * `shumi help` — a friendly, grouped tour of the CLI for humans exploring the
 * tool. Complements `shumi commands` (flat tree / agent manifest):
 *   - `shumi help`            → grouped overview + examples
 *   - `shumi help <command>`  → detailed help for one command (delegates to its --help)
 *   - `shumi help --json`     → capability manifest (same as `commands --json`)
 *
 * Overriding Commander's implicit `help [command]` is intentional; the manifest
 * walker already filters name === 'help', so this won't pollute `commands --json`.
 */

// Curated grouping for the overview. Any registered command not listed here is
// still shown under "More" so nothing is ever hidden as the surface grows.
const GROUPS = [
  { title: 'Start here', cmds: ['signal', 'coin', 'resolve', 'ask'] },
  { title: 'Market & trends', cmds: ['market', 'trends', 'scan', 'category', 'narratives', 'sentiment', 'funding', 'regime'] },
  { title: 'Research', cmds: ['holders', 'wallets', 'transcripts', 'tweets', 'search', 'pairs', 'basket', 'futures', 'walkforward', 'signal-quality'] },
  { title: 'Live', cmds: ['watch'] },
  { title: 'Account & setup', cmds: ['login', 'logout', 'whoami', 'billing', 'keys', 'wallet', 'init', 'doctor', 'health', 'version', 'commands'] },
];

export function registerHelpCommand(program) {
  program
    .command('help')
    .argument('[command]', 'show detailed help for a specific command')
    .description('explore the CLI — grouped overview, or detailed help for one command')
    .action(function (commandName) {
      const opts = this.optsWithGlobals();

      // `shumi help <command>` → defer to that command's own --help.
      if (commandName) {
        const sub = (program.commands || []).find(
          (c) => c.name() === commandName || (c.aliases?.() || []).includes(commandName)
        );
        if (sub) {
          sub.help(); // writes help and exits
          return;
        }
        process.stderr.write(
          chalk.yellow(`Unknown command: ${commandName}`) +
            chalk.dim('  (run `shumi help` to see all commands)\n')
        );
        process.exitCode = 1;
        return;
      }

      const mode = resolveMode(opts);
      const manifest = buildManifest(program);

      if (mode.json) {
        process.stdout.write(JSON.stringify(manifest) + '\n');
        return;
      }

      printOverview(manifest);
    });
}

function printOverview(manifest) {
  const byName = new Map(manifest.commands.map((c) => [c.name, c]));
  const grouped = new Set();
  const out = process.stdout;

  out.write('\n');
  out.write('  ' + chalk.bold('shumi') + chalk.dim(' — crypto trade intelligence from your terminal') + '\n');
  out.write('  ' + chalk.dim(`v${manifest.version}`) + '\n');

  out.write('\n  ' + chalk.dim('USAGE') + '\n');
  out.write('    shumi <command> [args] [--json] [--agent]\n');
  out.write('    shumi ' + chalk.cyan('BTC') + chalk.dim('              # bare ticker → quick signal') + '\n');
  out.write('    shumi help <command>' + chalk.dim('  # detailed help for one command') + '\n');

  for (const group of GROUPS) {
    const rows = group.cmds.map((name) => byName.get(name)).filter(Boolean);
    if (!rows.length) continue;
    out.write('\n  ' + chalk.dim(group.title.toUpperCase()) + '\n');
    for (const c of rows) {
      grouped.add(c.name);
      out.write(formatRow(c));
    }
  }

  // Anything registered but not in a curated group → still surface it.
  const leftovers = manifest.commands.filter((c) => !grouped.has(c.name));
  if (leftovers.length) {
    out.write('\n  ' + chalk.dim('MORE') + '\n');
    for (const c of leftovers) out.write(formatRow(c));
  }

  out.write('\n  ' + chalk.dim('EXAMPLES') + '\n');
  out.write('    shumi signal ZEC\n');
  out.write('    shumi coin ETH --history\n');
  out.write('    shumi watch funding\n');
  out.write('    shumi ask "is SOL funding overheated?"\n');
  out.write('\n  ' + chalk.dim('Tip: append --json (or --agent) to any command for machine-readable output.') + '\n');
  out.write('\n');
}

function formatRow(c) {
  const args = (c.arguments || [])
    .map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`))
    .join(' ');
  const sig = (c.name + (args ? ' ' + args : '')).padEnd(22);
  return `    ${chalk.bold(sig)} ${chalk.dim(c.description || '')}\n`;
}
