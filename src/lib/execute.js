import { spinner as makeSpinner, renderErr } from './output.js';
import { query } from './api-client.js';
import { renderText, renderRaw } from './renderer.js';
import { capture } from './telemetry.js';
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
 *
 * `opts` is the command's `optsWithGlobals()`, so --json / --agent reach
 * resolveMode for the spinner and for the error output. Without them a caller
 * passing --agent at a terminal would still get a spinner and prose errors.
 */
export async function execute({ queryText, raw = false, archetype = 'base', commandContext = null, opts = {} }) {
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

  // Deliberately output.js's spinner, not a bare ora(): it registers the instance
  // so pauseActiveSpinner can stop it while a prompt is on screen. This is the
  // NLP path (shumi ask / coin / tweets / search) and it reaches the x402 payment
  // prompt — a bare ora here left that prompt invisible, which is the whole
  // reason the registry exists.
  //
  // The phase timers below only assign `.text`; ora renders on an interval that
  // stop() clears, so a paused spinner stays quiet and picks up the newest text
  // when it resumes.
  const spinner = makeSpinner(PHASES[0].text, opts);

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
    // stop(), not fail(message): renderErr prints the one rendering of this
    // error. The spinner used to be the ONLY output here, and spinner() is a
    // no-op stub whenever output is JSON (stdout piped, --json, --agent), so
    // every failure on those paths exited 1 with nothing on stdout or stderr.
    // A 402 "Out of quota" was invisible to exactly the callers (agents,
    // scripts, `| jq`) that most need the envelope and exit code 3.
    //
    // renderErr writes the JSON envelope to stderr in machine modes and prose
    // plus a next-step hint at a terminal, sets the documented exit code, and
    // reports real faults (5xx, network, internal) to error telemetry while
    // skipping paywall and auth events.
    spinner.stop();
    renderErr(error, opts);
    try {
      capture('command_failed', {
        command,
        surface: 'nlp',
        error_code: error?.body?.error?.code || error?.code,
        http_status: typeof error?.status === 'number' ? error.status : undefined,
        duration_ms: Date.now() - startTime,
      });
    } catch { /* ignore */ }
  }
}
