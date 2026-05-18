import { typedAction, addUniversalFlags } from '../lib/typedCmd.js';

export function registerTranscriptsCommand(program) {
  const tr = program.command('transcripts').description('podcast/call transcript sources and highlights');

  tr.command('sources')
    .description('transcript sources')
    .action(typedAction({ route: 'transcripts', query: { action: 'sources' }, spinner: 'transcript sources…' }));

  tr.command('highlights')
    .description('transcript highlights')
    .action(typedAction({ route: 'transcripts', query: { action: 'highlights' }, spinner: 'transcript highlights…' }));
}
