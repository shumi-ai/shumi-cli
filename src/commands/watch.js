import chalk from 'chalk';
import { API_URL, getToken } from '../lib/config.js';
import { ApiError } from '../lib/api-client.js';
import { renderErr, resolveMode } from '../lib/output.js';
import { withSchema } from '../lib/schema.js';
import { formatPercentUnits } from './funding.js';

const STREAMS = ['funding', 'regime', 'sentiment'];

/**
 * `shumi watch <stream>` — long-poll streaming of crypto data. Emits NDJSON
 * (one JSON object per line) and flushes after every line so the output is
 * usable from a TTY pipe, `jq --unbuffered`, or any agent that reads stdin
 * incrementally.
 *
 * Default human mode prints a compact one-liner per event with chalk colors;
 * --json or non-TTY emits the raw NDJSON event verbatim. SIGINT (Ctrl-C)
 * cleanly closes the stream and prints a summary.
 */
export function registerWatchCommand(program) {
  const cmd = program
    .command('watch')
    .argument('<stream>', `stream to watch (${STREAMS.join(' | ')})`)
    .option('--interval <seconds>', 'poll interval (10–300)', (v) => parseInt(v, 10), 30)
    .option('--max <n>', 'stop after N events (0 = unbounded)', (v) => parseInt(v, 10), 0)
    .option('--diff', 'only emit when payload changes vs prior tick')
    .description('stream live crypto data as NDJSON (one JSON object per line)')
    .action(async function (stream) {
      const opts = this.optsWithGlobals();
      const mode = resolveMode(opts);
      const token = getToken();
      if (!token) {
        renderErr(Object.assign(new Error('Authentication required. Run: shumi login'), {
          status: 401,
          body: { error: { code: 'AUTH_REQUIRED', message: 'Authentication required. Run: shumi login' } },
        }), opts);
        return;
      }

      const url = new URL(`${API_URL}/watch/${encodeURIComponent(stream)}`);
      if (opts.interval) url.searchParams.set('interval', String(opts.interval));
      if (opts.max) url.searchParams.set('max', String(opts.max));
      if (opts.diff) url.searchParams.set('diff', '1');

      const ctrl = new AbortController();
      const onSig = () => { ctrl.abort(); };
      process.on('SIGINT', onSig);

      let emitted = 0;
      let response;
      try {
        response = await fetch(url, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/x-ndjson' },
          signal: ctrl.signal,
        });
      } catch (err) {
        process.off('SIGINT', onSig);
        if (err.name === 'AbortError') return;
        renderErr(new ApiError(0, { error: { code: 'NETWORK', message: err.message } }), opts);
        return;
      }

      if (!response.ok) {
        process.off('SIGINT', onSig);
        const body = await response.text();
        let parsed;
        try { parsed = JSON.parse(body); } catch { parsed = { error: { code: 'INTERNAL', message: body } }; }
        renderErr(new ApiError(response.status, parsed), opts);
        return;
      }

      // Line-buffered NDJSON read from a streamed response.
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;
            let evt;
            try { evt = JSON.parse(line); } catch { continue; }
            renderEvent(evt, mode, stream);
            if (evt.type === 'event') emitted++;
          }
        }
      } catch (err) {
        if (err.name !== 'AbortError') {
          renderErr(new ApiError(0, { error: { code: 'NETWORK', message: err.message } }), opts);
        }
      } finally {
        process.off('SIGINT', onSig);
        if (mode.json) {
          // Nothing extra — caller already saw the close event.
        } else {
          process.stderr.write(chalk.dim(`\n(closed; emitted ${emitted} event${emitted === 1 ? '' : 's'})\n`));
        }
      }
    });

  withSchema(cmd, {
    kind: 'ndjson stream',
    fields: {
      type: 'enum: open | event | heartbeat | error | close',
      stream: 'string',
      data: 'object — upstream payload (only on type=event)',
      meta: 'object — { ts, route, tick, as_of?, data_age_seconds? }',
    },
    note: 'one JSON object per line, separated by \\n; line-buffered output flushed immediately',
  });
}

function renderEvent(evt, mode, stream) {
  if (mode.json) {
    process.stdout.write(JSON.stringify(evt) + '\n');
    return;
  }
  // Human mode: compact one-liner with colors
  switch (evt.type) {
    case 'open':
      process.stderr.write(chalk.dim(`▶ watching ${stream} every ${evt.interval}s (${evt.source})\n`));
      break;
    case 'event': {
      const ts = new Date(evt.meta?.ts || Date.now()).toISOString().slice(11, 19);
      const tick = evt.meta?.tick ?? '?';
      const age = evt.meta?.data_age_seconds !== undefined ? ` ${chalk.dim('(' + evt.meta.data_age_seconds + 's old)')}` : '';
      const summary = summarizeEvent(evt.data, stream);
      process.stdout.write(`${chalk.dim(ts)}  ${chalk.cyan('#' + tick)}  ${summary}${age}\n`);
      break;
    }
    case 'heartbeat':
      process.stderr.write(chalk.dim('·'));
      break;
    case 'error':
      process.stderr.write(chalk.red(`✗ ${evt.error?.message || 'error'}\n`));
      break;
    case 'close':
      // handled by caller
      break;
  }
}

function summarizeEvent(data, stream) {
  if (!data) return '(empty)';
  if (stream === 'funding' && data.market) {
    const m = data.market;
    return `temp=${m.temperature ?? '?'}  avgApr=${formatPercentUnits(m.avgApr)}  +${m.positive ?? '?'}/-${m.negative ?? '?'} of ${m.total ?? '?'}`;
  }
  if (stream === 'regime' && Array.isArray(data)) {
    return `${data.length} active position${data.length === 1 ? '' : 's'}`;
  }
  if (stream === 'sentiment') {
    const stance = data.stance || data.sentiment_stance || data.summary;
    return stance ? `stance=${String(stance).slice(0, 60)}` : '(sentiment)';
  }
  return JSON.stringify(data).slice(0, 80);
}
