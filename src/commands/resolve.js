import chalk from 'chalk';
import { apiGet } from '../lib/api-client.js';
import { renderOk, renderErr, spinner } from '../lib/output.js';
import { withSchema } from '../lib/schema.js';
import { Exit } from '../lib/exitCodes.js';

export function registerResolveCommand(program) {
  const cmd = program
    .command('resolve')
    .argument('<query>', 'fuzzy input: symbol, name, or contract address')
    .option('--limit <n>', 'max matches', '5')
    .description('resolve a fuzzy input to canonical coin record(s)')
    .action(async function (query) {
      const opts = this.optsWithGlobals();
      const sp = spinner(`resolving "${query}"…`, opts);
      try {
        const env = await apiGet('resolve', { q: query, limit: opts.limit });
        sp.stop();
        const d = env.data;
        if (!d.matches?.length) {
          renderOk(env, opts, () => {
            process.stderr.write(chalk.yellow(`No match for "${query}" (tried: ${d.tried.join(', ')})\n`));
          });
          process.exitCode = Exit.UPSTREAM_4XX;
          return;
        }
        renderOk(env, opts, (data) => {
          process.stdout.write('symbol      name                          via              rank\n');
          for (const m of data.matches) {
            process.stdout.write(`${pad(m.symbol, 11)} ${pad(m.name, 29)} ${pad(m.via, 16)} ${m.rank ?? '—'}\n`);
          }
        });
      } catch (err) { sp.stop(); renderErr(err, opts); }
    });

  withSchema(cmd, {
    kind: 'object',
    fields: {
      query: 'string (input)',
      tried: 'string[] (resolution strategies attempted)',
      matches: 'array of { id, symbol, name, rank, via, score }',
      count: 'number',
    },
    example: { query: 'wif', matches: [{ symbol: 'WIF', name: 'dogwifhat', via: 'symbol-exact', score: 1.0, rank: 42 }] },
  });
}

function pad(v, n) { return String(v ?? '—').slice(0, n).padEnd(n); }
