import { typedAction, addUniversalFlags } from '../lib/typedCmd.js';

export function registerBasketCommand(program) {
  program.command('basket')
    .description('basket composition snapshots')
    .action(typedAction({ route: 'basket', spinner: 'basket snapshots…' }));
}
