import { describe, it, expect } from 'vitest';
import {
  buildCoinQuery,
  buildMarketQuery,
  buildSentimentQuery,
  buildTrendsQuery,
  buildScanQuery,
  buildCategoryQuery,
  buildNarrativesQuery,
  buildDeltaNeutralQuery,
  buildTweetsQuery,
  buildSearchQuery,
} from '../../src/lib/query-builder.js';

/**
 * These strings are the ONLY thing the server's classifier sees for typed
 * commands — a wrong or silently-dropped flag here misroutes the query with
 * exit 0 and a plausible answer. So every builder is pinned exactly.
 */

describe('buildCoinQuery', () => {
  it('base query names the symbol', () => {
    expect(buildCoinQuery('BTC')).toBe('Show me coin analysis for BTC');
  });
  it('appends every flag when set', () => {
    expect(buildCoinQuery('ETH', { interval: '1w', history: true, noSentiment: true }))
      .toBe('Show me coin analysis for ETH on weekly interval with 24h historical comparison without sentiment');
  });
  it('ignores non-weekly intervals (server default is daily)', () => {
    expect(buildCoinQuery('BTC', { interval: '1d' })).toBe('Show me coin analysis for BTC');
  });
});

describe('buildMarketQuery', () => {
  it('defaults to health overview', () => {
    expect(buildMarketQuery()).toBe('Show me current market health overview');
  });
  it('adds crossings and weekly interval', () => {
    expect(buildMarketQuery({ interval: '1w', crossing: true }))
      .toBe('Show me current market health overview on weekly interval with trend crossings');
  });
});

describe('buildSentimentQuery', () => {
  it('coin takes precedence over category and narrative', () => {
    expect(buildSentimentQuery({ coin: 'SOL', category: 'ai', narrative: 'depin' }))
      .toBe('Show me sentiment for SOL');
  });
  it('category takes precedence over narrative', () => {
    expect(buildSentimentQuery({ category: 'ai', narrative: 'depin' }))
      .toBe('Show me sentiment for the ai category');
  });
  it('narrative-only targets the narrative', () => {
    expect(buildSentimentQuery({ narrative: 'depin' }))
      .toBe('Show me sentiment for the depin narrative');
  });
  it('no target → market sentiment with humanized interval', () => {
    expect(buildSentimentQuery()).toBe('Show me current market sentiment');
    expect(buildSentimentQuery({ interval: '1h' }))
      .toBe('Show me current market sentiment on 1 hour interval');
  });
  it('unknown interval passes through verbatim rather than vanishing', () => {
    expect(buildSentimentQuery({ interval: '4h' }))
      .toBe('Show me current market sentiment on 4h interval');
  });
});

describe('buildTrendsQuery', () => {
  it('defaults to fresh trends', () => {
    expect(buildTrendsQuery()).toBe('Show me fresh trends (newly started)');
  });
  it('stale flag flips the label', () => {
    expect(buildTrendsQuery({ stale: true }))
      .toBe('Show me stale trends (longest running)');
  });
  it('aligned overrides stale entirely', () => {
    expect(buildTrendsQuery({ aligned: true, stale: true, limit: 5 }))
      .toBe('Show me coins with aligned trends across all timeframes, limit 5');
  });
  it('carries weekly interval and limit together', () => {
    expect(buildTrendsQuery({ interval: '1w', limit: 10 }))
      .toBe('Show me fresh trends (newly started) on weekly interval, limit 10');
  });
});

describe('buildScanQuery', () => {
  it('no filters → explicit all-coins default, never a bare "Filter coins:"', () => {
    expect(buildScanQuery()).toBe('Filter coins: all coins sorted by market cap');
  });
  it('joins every filter in order', () => {
    expect(buildScanQuery({
      trend: 'UP', category: 'ai', mcapMin: 1e9, mcapMax: 5e9,
      exchange: 'binance', limit: 20, interval: '1w',
    })).toBe('Filter coins: UP trend ai category market cap min $1.0B market cap max $5.0B listed on binance limit 20 weekly interval');
  });
  it('formats mcap boundaries at K/M/B thresholds', () => {
    expect(buildScanQuery({ mcapMin: 1000 })).toContain('$1.0K');
    expect(buildScanQuery({ mcapMin: 2500000 })).toContain('$2.5M');
    expect(buildScanQuery({ mcapMin: 999 })).toContain('$999');
  });
});

describe('buildCategoryQuery', () => {
  it('no name lists all categories', () => {
    expect(buildCategoryQuery()).toBe('Show me all categories');
    expect(buildCategoryQuery('')).toBe('Show me all categories');
  });
  it('named category gets the breakdown query', () => {
    expect(buildCategoryQuery('meme', { interval: '1w' }))
      .toBe('Show me the meme category trend breakdown on weekly interval');
  });
});

describe('buildNarrativesQuery', () => {
  it('no name lists all narratives, with interval and refresh', () => {
    expect(buildNarrativesQuery(undefined, { interval: '1d', refresh: true }))
      .toBe('Show me all current narratives on 1 day interval with fresh analysis');
  });
  it('named narrative asks for its sentiment', () => {
    expect(buildNarrativesQuery('depin'))
      .toBe('Show me the depin narrative sentiment');
  });
});

describe('buildDeltaNeutralQuery', () => {
  it('appends exchange, dex-only, symbol and limit', () => {
    expect(buildDeltaNeutralQuery({ exchange: 'hyperliquid', dexOnly: true, symbol: 'ETH', limit: 3 }))
      .toBe('Show me delta-neutral funding rate arbitrage opportunities on hyperliquid, DEX only for ETH, limit 3');
  });
});

describe('buildTweetsQuery / buildSearchQuery', () => {
  it('tweets query names the handle', () => {
    expect(buildTweetsQuery('cz_binance')).toBe('Show me recent tweets from cz_binance');
  });
  it('search defaults to web search; --answer switches to QA', () => {
    expect(buildSearchQuery('eth etf flows')).toBe('Search the web for: eth etf flows');
    expect(buildSearchQuery('eth etf flows', { answer: true }))
      .toBe('Answer this question: eth etf flows');
  });
});
