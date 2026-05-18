import { typedAction, addUniversalFlags } from '../lib/typedCmd.js';

export function registerWalkforwardCommand(program) {
  const wf = program.command('walkforward').description('walkforward backtest signals, positions, outcomes');

  for (const action of ['signals', 'positions', 'outcomes']) {
    wf.command(action)
      .description(`walkforward ${action}`)
      .action(typedAction({ route: 'walkforward', query: { action }, spinner: `walkforward ${action}…` }));
  }
}
