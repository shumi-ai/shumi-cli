import { execute } from '../lib/execute.js';
import { buildSearchQuery } from '../lib/query-builder.js';

export function registerSearchCommand(program) {
  program
    .command('search <query>')
    .description('search the web for crypto information')
    .option('--answer', 'get a direct answer instead of search results')
    .option('--raw', 'output raw JSON data')
    .action(async (queryText, options, cmd) => {
      const constructed = buildSearchQuery(queryText, options);
      await execute({
        queryText: constructed,
        raw: options.raw,
        commandContext: 'search',
        opts: cmd.optsWithGlobals(),
      });
    });
}
