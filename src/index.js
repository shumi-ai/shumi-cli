import { registerAskCommand } from './commands/ask.js';
import { registerCoinCommand } from './commands/coin.js';
import { registerMarketCommand } from './commands/market.js';
import { registerSentimentCommand } from './commands/sentiment.js';
import { registerTrendsCommand } from './commands/trends.js';
import { registerScanCommand } from './commands/scan.js';
import { registerCategoryCommand } from './commands/category.js';
import { registerNarrativesCommand } from './commands/narratives.js';
import { registerTweetsCommand } from './commands/tweets.js';
import { registerSearchCommand } from './commands/search.js';
import { registerAuthCommands } from './commands/auth.js';
import { registerHealthCommand } from './commands/health.js';
import { registerKeysCommand } from './commands/keys.js';
import { registerWalletCommand } from './commands/wallet.js';
import { registerFundingCommand } from './commands/funding.js';
import { registerRegimeCommand } from './commands/regime.js';
import { registerSignalQualityCommand } from './commands/signalQuality.js';
import { registerBillingCommand } from './commands/billing.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerVersionCommand } from './commands/version.js';
import { registerCommandsCommand } from './commands/commands.js';
import { registerHelpCommand } from './commands/help.js';
import { registerFuturesCommand } from './commands/futures.js';
import { registerWalkforwardCommand } from './commands/walkforward.js';
import { registerPairsCommand } from './commands/pairs.js';
import { registerHoldersCommand } from './commands/holders.js';
import { registerWalletsCommand } from './commands/wallets.js';
import { registerTranscriptsCommand } from './commands/transcripts.js';
import { registerBasketCommand } from './commands/basket.js';
import { registerSignalCommand } from './commands/signal.js';
import { registerResolveCommand } from './commands/resolve.js';
import { registerWatchCommand } from './commands/watch.js';
import { registerDashboardAction, registerDashboardSchema } from './commands/dashboard.js';
import { registerInitCommand } from './commands/init.js';
import { applyBulkSchemas } from './lib/bulkSchemas.js';

export function registerCommands(program) {
  // Top-level synthesis, resolution, streaming (highest-leverage entry points)
  registerSignalCommand(program);
  registerResolveCommand(program);
  registerWatchCommand(program);

  // Coin / market parents (NLP default + typed subcommands)
  registerCoinCommand(program);
  registerMarketCommand(program);

  // Typed data domains
  registerCategoryCommand(program);
  registerSentimentCommand(program);
  registerTrendsCommand(program);
  registerNarrativesCommand(program);
  registerScanCommand(program);
  registerFundingCommand(program);
  registerRegimeCommand(program);
  registerFuturesCommand(program);
  registerWalkforwardCommand(program);
  registerPairsCommand(program);     // includes delta-neutral as `pairs delta-neutral`
  registerHoldersCommand(program);
  registerWalletsCommand(program);
  registerTranscriptsCommand(program);
  registerBasketCommand(program);
  registerSignalQualityCommand(program);

  // External / NLP
  registerTweetsCommand(program);
  registerSearchCommand(program);
  registerAskCommand(program);       // NLP escape hatch

  // Meta
  registerBillingCommand(program);
  registerDoctorCommand(program);
  registerVersionCommand(program);
  registerCommandsCommand(program);
  registerHelpCommand(program);

  // Onboarding (first-run setup check)
  registerInitCommand(program);

  // Auth & utility
  registerAuthCommands(program);
  registerHealthCommand(program);
  registerKeysCommand(program);
  registerWalletCommand(program);   // x402 pay-per-query wallet (address/balance/fund/create)

  // Default action for `shumi` with no subcommand — market overview dashboard.
  // Falls back to help if user isn't authenticated.
  registerDashboardAction(program);
  registerDashboardSchema(program);

  // Fill in default schemas for commands that didn't get one inline.
  // Hand-tuned `withSchema(cmd, ...)` calls take precedence (this only fills gaps).
  applyBulkSchemas(program);
}
