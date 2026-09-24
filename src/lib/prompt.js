/**
 * Tiny prompt helpers for the x402 payment flow and the wallet subcommand.
 *
 * No inquirer / enquirer / prompts dep — we ship a CLI that already has 30+
 * deps, and the prompts we need are dirt-simple (Y/n, hidden passphrase).
 * Built on Node's stdlib `readline` so we don't fight TTY quirks.
 *
 * Hidden input: we don't echo characters, and we cleanly handle Ctrl-C
 * (resolves null, which callers treat as an abort — distinct from a "no").
 *
 * Both prompts pause any running spinner. ora repaints the current line, so a
 * spinner started further up the call stack erases the question and the user is
 * left typing into what looks like a hung command.
 */

import readline from 'readline';
import { pauseActiveSpinner } from './output.js';
import { stdin as input, stdout as output, stderr } from 'process';

/** Run `fn` at most once. A resume that fires twice would restart a spinner the
 *  owner has since stopped, leaving it spinning with nothing to stop it. */
function once(fn) {
  let called = false;
  return (...args) => {
    if (called) return undefined;
    called = true;
    return fn(...args);
  };
}

function isTTY() {
  return input.isTTY === true && output.isTTY === true;
}

/**
 * Whether the prompts below can actually ask anything. When false,
 * promptYesNo answers with its default and promptHidden returns null, so a
 * caller that NEEDS an answer (a wallet passphrase) should check this first and
 * fail with a useful message instead of a confusing one downstream.
 */
export function canPrompt() {
  return isTTY();
}

/**
 * Yes/No prompt. `defaultYes: true` lets a bare Enter mean Y.
 * Returns true / false, or null when the user aborts with Ctrl-C.
 */
export function promptYesNo(question, { defaultYes = true } = {}) {
  if (!isTTY()) {
    // Non-TTY (piped stdin, CI) — fall back to default. Callers in agent
    // mode should have already short-circuited the prompt entirely.
    return Promise.resolve(defaultYes);
  }
  // Any spinner started further up the call stack repaints this line and would
  // erase the question. Stop it for the duration, put it back afterwards.
  const resumeSpinner = once(pauseActiveSpinner());
  return new Promise((resolve) => {
    const done = (value) => { resumeSpinner(); resolve(value); };
    const rl = readline.createInterface({ input, output });
    rl.question(question, (answer) => {
      rl.close();
      const a = (answer || '').trim().toLowerCase();
      if (a === '') return done(defaultYes);
      done(a === 'y' || a === 'yes');
    });
    // null, not false. Ctrl-C is an abort, not an answer — reporting it as
    // "Declined." told a user who pressed Ctrl-C that they had made a choice,
    // and mapped it to the wrong exit code.
    rl.on('SIGINT', () => {
      rl.close();
      stderr.write('\n');
      done(null);
    });
  });
}

/**
 * Hidden input — for passphrases. We replace the standard line input with
 * raw-mode keystroke handling so nothing echoes. Enter resolves the buffer.
 * Ctrl-C resolves null.
 */
export function promptHidden(question) {
  if (!isTTY()) return Promise.resolve(null);
  // In the x402 flow this runs immediately after the Y/n prompt has restarted
  // the spinner, so without this the passphrase question is repainted over and
  // the user types blind into raw mode.
  const resumeSpinner = once(pauseActiveSpinner());
  return new Promise((resolve) => {
    output.write(question);
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');

    let buf = '';
    const done = (value) => { resumeSpinner(); resolve(value); };
    const onData = (key) => {
      // Enter
      if (key === '\r' || key === '\n') {
        cleanup();
        output.write('\n');
        done(buf);
        return;
      }
      // Ctrl-C
      if (key === '\x03') {
        cleanup();
        output.write('\n');
        done(null);
        return;
      }
      // Backspace
      if (key === '\x7f' || key === '\b') {
        buf = buf.slice(0, -1);
        return;
      }
      // Discard non-printable
      if (key.charCodeAt(0) < 32) return;
      buf += key;
    };

    const cleanup = () => {
      input.setRawMode(false);
      input.pause();
      input.removeListener('data', onData);
    };

    input.on('data', onData);
  });
}
