import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

const calls = [];
vi.mock('../../src/lib/api-client.js', async (orig) => ({
  ...(await orig()),
  apiGet: vi.fn(async (route, query) => {
    calls.push({ route, query });
    return { ok: true, data: { rows: [] }, meta: {} };
  }),
}));

const { registerUnlocksCommand } = await import('../../src/commands/unlocks.js');

const run = async (...argv) => {
  const program = new Command().exitOverride().option('--json').option('--agent');
  registerUnlocksCommand(program);
  await program.parseAsync(['node', 'shumi', ...argv]);
};

describe('shumi unlocks', () => {
  let spy;
  beforeEach(() => {
    calls.length = 0;
    spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(() => spy.mockRestore());

  it('coin <symbol> calls the one-coin route, with the id when given', async () => {
    await run('unlocks', 'coin', 'ARB', '--json');
    await run('unlocks', 'coin', 'ARB', '--coin-id', 'arbitrum', '--json');
    expect(calls[0]).toMatchObject({ route: 'unlocks/ARB', query: {} });
    expect(calls[1]).toMatchObject({ route: 'unlocks/ARB', query: { coinId: 'arbitrum' } });
  });

  it('calendar maps its flags to the route parameters', async () => {
    await run('unlocks', 'calendar', '--json');
    await run('unlocks', 'calendar', '--days', '14', '--sort', 'usd', '--insiders', '--max-rank', '100', '--json');
    expect(calls[0]).toMatchObject({ route: 'unlocks/calendar', query: {} });
    expect(calls[1]).toMatchObject({ route: 'unlocks/calendar', query: { days: '14', sort: 'usd', insidersOnly: 'true', maxRank: '100' } });
  });
});
