import { buildManifest } from '../lib/manifest.js';
import { resolveMode } from '../lib/output.js';

/**
 * `shumi commands` — capability manifest for AI agent self-discovery.
 * Default human output is a tree; --json emits the full structured manifest.
 */
export function registerCommandsCommand(program) {
  program
    .command('commands')
    .description('list all commands (with --json: capability manifest for AI agents)')
    .action(async function () {
      const opts = this.optsWithGlobals();
      const mode = resolveMode(opts);
      const manifest = buildManifest(program);
      if (mode.json) {
        process.stdout.write(JSON.stringify(manifest) + '\n');
      } else {
        printTree(manifest.commands, '');
      }
    });
}

function printTree(commands, indent) {
  for (const c of commands) {
    const args = c.arguments.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(' ');
    process.stdout.write(`${indent}${c.name}${args ? ' ' + args : ''}  — ${c.description}\n`);
    if (c.subcommands) printTree(c.subcommands, indent + '  ');
  }
}
