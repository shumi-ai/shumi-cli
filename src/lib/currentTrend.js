import { smartFormat } from './smartFormat.js';

/**
 * One line stating a coin's current trend, from the server's `currentTrend`
 * ({ trend, since, days, asOf, incompleteDayExcluded }). Returns null when the
 * payload has none: older backends do not send it, and --fields can drop it.
 *
 * The server computes it from the last COMPLETE day. The `trends` history is
 * not a substitute: its last row was a half-written day during the nightly
 * cron, which is why the line exists at all.
 */
export function currentTrendLine(data, c, label = 'current trend') {
  const ct = data?.currentTrend;
  if (!ct || typeof ct !== 'object' || !ct.trend) return null;
  const color = ct.trend === 'UP' ? c.green : ct.trend === 'DOWN' ? c.red : c.yellow;
  const parts = [];
  if (ct.since) parts.push(`since ${ct.since}`);
  if (Number.isFinite(ct.days)) parts.push(`(${ct.days} ${ct.days === 1 ? 'day' : 'days'}${ct.asOf ? `, as of ${ct.asOf}` : ''})`);
  else if (ct.asOf) parts.push(`(as of ${ct.asOf})`);
  let line = `  ${c.dim(label)}  ${color(c.bold(ct.trend))}${parts.length ? ' ' + parts.join(' ') : ''}`;

  const wk = data?.currentTrendWeekly;
  if (wk && typeof wk === 'object' && wk.trend) {
    line += `   ${c.dim('weekly')} ${wk.trend}${wk.since ? ` since ${wk.since}` : ''}`;
  }
  return line;
}

/**
 * Human renderer for `coin lookup | by-id | by-name`: the current-trend line
 * first, then the generic rendering. Without `currentTrend` it is exactly the
 * generic rendering, as before.
 */
export function renderCoinLookup(data, c, opts) {
  const line = currentTrendLine(data, c);
  if (!line) return smartFormat(data, c, opts);
  process.stdout.write(line + '\n\n');
  // The line already says it; without this smartFormat repeats it as a CURRENTTREND section.
  const { currentTrend, currentTrendWeekly, ...rest } = data;
  smartFormat(rest, c, opts);
}
