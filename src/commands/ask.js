import { execute } from '../lib/execute.js';

export function registerAskCommand(program) {
  program
    .command('ask <query>')
    .description('ask shumi anything (free-form query)')
    .option('--raw', 'output raw JSON data')
    .option('--archetype <type>', 'shumi archetype', 'base')
    .action(async (queryText, options, cmd) => {
      await execute({
        queryText,
        raw: options.raw,
        archetype: options.archetype,
        opts: cmd.optsWithGlobals(),
      });
    });
}
