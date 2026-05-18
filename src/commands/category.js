import { typedAction, addUniversalFlags } from '../lib/typedCmd.js';

/**
 * Typed category commands.
 * `shumi category` (no args) → list all categories.
 * `shumi category info <name>` → metadata for one category.
 * `shumi category coins <name>` → coins in a category.
 * `shumi category sentiment <name>` → sentiment for a category.
 */
export function registerCategoryCommand(program) {
  const cat = program
    .command('category')
    .description('category data (list, info, coins, sentiment)')
    .action(typedAction({ route: 'category/list', spinner: 'categories…' }));

  cat.command('list')
    .description('list all categories')
    .action(typedAction({ route: 'category/list', spinner: 'categories…' }));

  cat.command('info')
    .argument('<name>', 'category name')
    .description('metadata for a category')
    .action(typedAction({
      route: (ctx) => `category/info/${encodeURIComponent(ctx.args[0])}`,
      spinner: (ctx) => `category info ${ctx.args[0]}…`,
    }));

  cat.command('coins')
    .argument('<name>', 'category name')
    .description('coins in a category')
    .action(typedAction({
      route: (ctx) => `category/coins/${encodeURIComponent(ctx.args[0])}`,
      spinner: (ctx) => `category coins ${ctx.args[0]}…`,
    }));

  cat.command('sentiment')
    .argument('<name>', 'category name')
    .description('sentiment for a category')
    .action(typedAction({
      route: (ctx) => `category/sentiment/${encodeURIComponent(ctx.args[0])}`,
      spinner: (ctx) => `category sentiment ${ctx.args[0]}…`,
    }));
}
