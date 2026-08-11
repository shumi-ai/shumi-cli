import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { walkforwardHuman } from '../../src/commands/walkforward.js';

// chalk stand-in: every style resolves to identity, so assertions match plain text and the
// stub can't fall behind whichever styles smartFormat reaches for next.
const identity = (s) => s;
const chalk = new Proxy(identity, {
  get: (_t, prop) => (prop === 'then' ? undefined : chalk),
  apply: (_t, _this, [s]) => s,
});

describe('walkforward empty-state', () => {
  let out;
  let spy;

  beforeEach(() => {
    out = '';
    spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += s; return true; });
  });
  afterEach(() => spy.mockRestore());

  it('explains an empty collection instead of implying there are no positions', () => {
    walkforwardHuman('positions')({ positions: [], meta: {} }, chalk);
    expect(out).toContain('No positions.');
    expect(out).toContain('Engine B');
    expect(out).toContain('paused');
    // The dangerous misreading this exists to prevent.
    expect(out).toContain('do not read it as');
  });

  it('warns when the newest row is far in the past', () => {
    const old = new Date(Date.now() - 75 * 86_400_000).toISOString();
    walkforwardHuman('outcomes')({ outcomes: [{ symbol: 'BTC', createdAt: old }] }, chalk);
    expect(out).toMatch(/Newest row is 7[45] days old/);
    expect(out).toContain('history, not a current view');
  });

  it('stays quiet when the data is fresh', () => {
    const recent = new Date(Date.now() - 2 * 86_400_000).toISOString();
    walkforwardHuman('signals')({ signals: [{ symbol: 'ETH', createdAt: recent }] }, chalk);
    expect(out).not.toContain('Engine B');
    expect(out).not.toContain('Newest row is');
  });

  it('does not warn when rows carry no recognisable date', () => {
    walkforwardHuman('signals')({ signals: [{ symbol: 'SOL' }] }, chalk);
    expect(out).not.toContain('Newest row is');
  });

  it('falls through to normal rendering when the collection key is absent', () => {
    walkforwardHuman('positions')({ somethingElse: 1 }, chalk);
    expect(out).not.toContain('No positions.');
  });
});
