import { execute } from '../lib/execute.js';
import { buildCoinQuery } from '../lib/query-builder.js';
import { registerCoinRiskCommand } from './coinRisk.js';

export function registerCoinCommand(program) {
  const coin = program
    .command('coin')
    .description('coin lookup (NLP analysis by default; subcommands for typed data)')
    .argument('[symbol]', 'coin symbol for NLP analysis (e.g. BTC)')
    .option('--interval <interval>', 'trend interval (1d, 1w)', '1d')
    .option('--history', 'include 24h historical comparison')
    .option('--no-sentiment', 'skip sentiment data')
    .option('--raw', 'output raw JSON data')
    .action(async (symbol, options, cmd) => {
      if (!symbol) {
        cmd.help();
        return;
      }
      const queryText = buildCoinQuery(symbol.toUpperCase(), options);
      await execute({ queryText, raw: options.raw, commandContext: 'coin' });
    });

  registerCoinRiskCommand(coin);
}
