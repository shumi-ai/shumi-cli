import ora from 'ora';
import { query } from './api-client.js';
import { renderText, renderRaw } from './renderer.js';
import { capture, captureError } from './telemetry.js';
import { getToken } from './config.js';

// Phase messages that rotate while waiting for the API response.
// Timings approximate what shumi does server-side.
const PHASES = [
  { text: 'classifying query', delay: 0 },
  { text: 'fetching market data', delay: 2500 },
  { text: 'analyzing results', delay: 6000 },
  { text: 'generating response', delay: 9000 },
];

/**
 * Execute a Shumi query with animated spinner, error handling, and rendering.
 */
export async function execute({ queryText, raw = false, archetype = 'base', commandContext = null }) {
  const startTime = Date.now();

  // Telemetry: shared chokepoint for the NLP commands (coin/ask/signal/tweets/
  // search). We use commandContext (or archetype) as the command label and
  // NEVER pass queryText — only metadata (lengths, flags, status, duration).
  const command = commandContext || 'ask';
  try {
    capture('command_invoked', {
      command,
      subcommand: null,
      surface: 'nlp',
      has_args: typeof queryText === 'string' && queryText.length > 0,
      flag_keys: [
        ...(raw ? ['raw'] : []),
        ...(archetype && archetype !== 'base' ? ['archetype'] : []),
      ],
      is_agent: process.env.SHUMI_AGENT === '1' || process.argv.includes('--agent'),
      has_token: Boolean(getToken()),
    });
  } catch { /* telemetry must never break the command */ }

  const spinner = ora({ text: PHASES[0].text, spinner: 'dots' }).start();

  // Schedule phase transitions
  const timers = PHASES.slice(1).map(phase =>
    setTimeout(() => { spinner.text = phase.text; }, phase.delay)
  );

  try {
    const messages = [{ role: 'user', content: queryText }];
    const result = await query({ messages, raw, archetype, commandContext });

    timers.forEach(clearTimeout);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    spinner.succeed(`done in ${elapsed}s`);

    if (raw) {
      renderRaw(result.steps || result);
    } else {
      renderText(result.text);
    }
    try {
      capture('command_completed', {
        command,
        surface: 'nlp',
        status: 'ok',
        duration_ms: Date.now() - startTime,
      });
    } catch { /* ignore */ }
  } catch (error) {
    timers.forEach(clearTimeout);
    spinner.fail(error.message);
    try {
      capture('command_failed', {
        command,
        surface: 'nlp',
        error_code: error?.body?.error?.code || error?.code,
        http_status: typeof error?.status === 'number' ? error.status : undefined,
        duration_ms: Date.now() - startTime,
      });
      captureError(error, { command, surface: 'nlp' });
    } catch { /* ignore */ }
    process.exitCode = 1;
  }
}
