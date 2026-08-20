import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  applyContextGuard, boundedPreview, spillThreshold, spillDir, pruneSpills, DEFAULT_MAX_BYTES,
} from '../../src/lib/spill.js';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'shumi-spill-test-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** An envelope shaped like the real offender: 1,518 sources around a tiny verdict. */
function bigEnvelope(n = 1518) {
  return {
    schemaVersion: 1,
    data: {
      verdict: 'strong-bull',
      score: 3.5,
      raw: { sentiment: { data: { sources: Array.from({ length: n }, (i0, i) => ({ id: i, text: 'x'.repeat(200) })) } } },
    },
    meta: { route: 'signal' },
  };
}

describe('spillThreshold', () => {
  it('defaults to 50 KB', () => expect(spillThreshold({})).toBe(DEFAULT_MAX_BYTES));
  it('honours an explicit value', () => expect(spillThreshold({ SHUMI_MAX_OUTPUT_BYTES: '1000' })).toBe(1000));
  it('treats 0 as disabled', () => expect(spillThreshold({ SHUMI_MAX_OUTPUT_BYTES: '0' })).toBe(0));
  it('falls back to the default on garbage, never to 0', () => {
    // A typo must not silently switch the guard off.
    expect(spillThreshold({ SHUMI_MAX_OUTPUT_BYTES: 'lots' })).toBe(DEFAULT_MAX_BYTES);
    expect(spillThreshold({ SHUMI_MAX_OUTPUT_BYTES: '-5' })).toBe(DEFAULT_MAX_BYTES);
  });
});

describe('applyContextGuard', () => {
  const env = () => ({ SHUMI_SPILL_DIR: dir });

  it('leaves a small envelope untouched', () => {
    const small = { schemaVersion: 1, data: { ok: true } };
    expect(applyContextGuard(small, { mode: { agent: true }, env: env() })).toBe(small);
  });

  it('spills in agent mode and writes the FULL envelope to disk', () => {
    const big = bigEnvelope();
    const out = applyContextGuard(big, { mode: { agent: true }, env: env() });

    expect(out._spill).toBeTruthy();
    expect(JSON.stringify(out).length).toBeLessThan(JSON.stringify(big).length / 4);

    // Nothing is lost: the file round-trips to the original, all 1,518 items.
    const round = JSON.parse(readFileSync(out._spill.path, 'utf8'));
    expect(round).toEqual(big);
    expect(round.data.raw.sentiment.data.sources).toHaveLength(1518);
  });

  it('does NOT spill a plain redirect, only agent mode', () => {
    // `shumi … --json > out.json` sets json (non-TTY) but not agent. Rewriting
    // that would corrupt a file the user asked for in full.
    const big = bigEnvelope();
    expect(applyContextGuard(big, { mode: { agent: false, json: true }, env: env() })).toBe(big);
  });

  it('lets a non-agent caller opt in with the env var', () => {
    const out = applyContextGuard(bigEnvelope(), {
      mode: { agent: false, json: true }, env: { ...env(), SHUMI_MAX_OUTPUT_BYTES: '2000' },
    });
    expect(out._spill).toBeTruthy();
  });

  it('is disabled entirely at 0', () => {
    const big = bigEnvelope();
    expect(applyContextGuard(big, { mode: { agent: true }, env: { ...env(), SHUMI_MAX_OUTPUT_BYTES: '0' } })).toBe(big);
  });

  it('keeps the answer when the file cannot be written', () => {
    // A large answer beats a lost one: an unwritable spill returns everything.
    const big = bigEnvelope();
    const out = applyContextGuard(big, {
      mode: { agent: true }, env: env(),
      writeFile: () => { throw new Error('EROFS'); },
    });
    expect(out).toBe(big);
    expect(out._spill).toBeUndefined();
  });

  it('tells the agent the preview is partial and how to read the rest', () => {
    const out = applyContextGuard(bigEnvelope(), { mode: { agent: true }, env: env() });
    expect(out._spill.preview_is_partial).toBe(true);
    expect(out._spill.hint).toMatch(/NOT the full answer/);
    expect(out._spill.hint).toMatch(/sub-agent|jq/);
    expect(out._spill.hint).toContain(out._spill.path);
    expect(out._spill.dropped.some((d) => d.of === 1518)).toBe(true);
  });

  it('preserves the shape of the answer in the preview', () => {
    const out = applyContextGuard(bigEnvelope(), { mode: { agent: true }, env: env() });
    // The 13-byte verdict — the part the caller actually asked for — survives.
    expect(out.data.verdict).toBe('strong-bull');
    expect(out.data.score).toBe(3.5);
    expect(Array.isArray(out.data.raw.sentiment.data.sources)).toBe(true);
    expect(out.data.raw.sentiment.data.sources.length).toBeLessThan(1518);
  });
});

describe('boundedPreview', () => {
  it('reports the path and counts of what it dropped', () => {
    const { preview, dropped } = boundedPreview({ items: Array.from({ length: 100 }, (x, i) => i) }, 200);
    expect(preview.items.length).toBeLessThan(100);
    expect(dropped[0]).toMatchObject({ path: 'data.items', of: 100 });
  });

  it('gives up rather than emitting something still over budget', () => {
    // One enormous string cannot be capped by slicing arrays.
    const { preview } = boundedPreview({ blob: 'x'.repeat(10_000) }, 100);
    expect(preview).toBeNull();
  });
});

describe('pruneSpills', () => {
  it('removes files older than a day and keeps fresh ones', () => {
    const old = join(dir, 'shumi-1-1.json');
    const fresh = join(dir, 'shumi-2-2.json');
    const foreign = join(dir, 'not-ours.json');
    for (const f of [old, fresh, foreign]) writeFileSync(f, '{}');
    const longAgo = new Date(Date.now() - 48 * 3600 * 1000);
    utimesSync(old, longAgo, longAgo);
    utimesSync(foreign, longAgo, longAgo);

    pruneSpills(dir);

    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(foreign)).toBe(true); // never touches files it did not write
  });

  it('does not throw on a missing directory', () => {
    expect(() => pruneSpills(join(dir, 'nope'))).not.toThrow();
  });
});

describe('spillDir', () => {
  it('prefers the explicit override', () => expect(spillDir({ SHUMI_SPILL_DIR: '/x' })).toBe('/x'));
  it('defaults under the home dir', () => expect(spillDir({ HOME: '/h' })).toBe('/h/.shumi/spill'));
});
