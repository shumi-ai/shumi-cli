import { execute } from '../lib/execute.js';
import { buildTweetsQuery } from '../lib/query-builder.js';

export function registerTweetsCommand(program) {
  program
    .command('tweets <handle>')
    .description('recent tweets from a Twitter account')
    .option('--raw', 'output raw JSON data')
    .action(async (handle, options, cmd) => {
      const cleanHandle = handle.replace(/^@/, '');
      const queryText = buildTweetsQuery(cleanHandle);
      await execute({
        queryText,
        raw: options.raw,
        commandContext: 'tweets',
        opts: cmd.optsWithGlobals(),
      });
    });
}
