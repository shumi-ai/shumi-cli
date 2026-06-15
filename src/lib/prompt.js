/**
 * Tiny prompt helpers for the x402 payment flow and the wallet subcommand.
 *
 * No inquirer / enquirer / prompts dep — we ship a CLI that already has 30+
 * deps, and the prompts we need are dirt-simple (Y/n, hidden passphrase).
 * Built on Node's stdlib `readline` so we don't fight TTY quirks.
 *
 * Hidden input: we don't echo characters, and we cleanly handle Ctrl-C
 * (resolves null so the caller can treat it as "user declined" rather
 * than crashing).
 */

import readline from 'readline';
import { stdin as input, stdout as output, stderr } from 'process';

function isTTY() {
  return input.isTTY === true && output.isTTY === true;
}

/**
 * Yes/No prompt. `defaultYes: true` lets a bare Enter mean Y.
 * Returns boolean.
 */
export function promptYesNo(question, { defaultYes = true } = {}) {
  if (!isTTY()) {
    // Non-TTY (piped stdin, CI) — fall back to default. Callers in agent
    // mode should have already short-circuited the prompt entirely.
    return Promise.resolve(defaultYes);
  }
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, output });
    rl.question(question, (answer) => {
      rl.close();
      const a = (answer || '').trim().toLowerCase();
      if (a === '') return resolve(defaultYes);
      resolve(a === 'y' || a === 'yes');
    });
    rl.on('SIGINT', () => {
      rl.close();
      stderr.write('\n');
      resolve(false);
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
  return new Promise((resolve) => {
    output.write(question);
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');

    let buf = '';
    const onData = (key) => {
      // Enter
      if (key === '\r' || key === '\n') {
        cleanup();
        output.write('\n');
        resolve(buf);
        return;
      }
      // Ctrl-C
      if (key === '\x03') {
        cleanup();
        output.write('\n');
        resolve(null);
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
