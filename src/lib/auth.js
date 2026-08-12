import { createServer } from 'http';
import { nanoid } from 'nanoid';
import open from 'open';
import {
  saveCredentials,
  clearCredentials,
  savePendingLoginState,
  getPendingLoginState,
  clearPendingLoginState,
} from './config.js';
import { inspectToken } from './token.js';

const AUTH_URL = 'https://shumi.ai/auth/cli';

/**
 * Start a temporary localhost server, open browser for auth,
 * wait for callback with token + wallet.
 *
 * @param {object} [options]
 * @param {(url: string) => void} [options.onUrl] - called with the auth URL
 *   once the local server is listening, so the caller can print it as a
 *   manual-paste fallback in case the browser didn't open.
 */
export async function login({ onUrl } = {}) {
  const state = nanoid();
  // Persist the CSRF state before the browser is opened. If this process dies
  // while the user is still signing (closed lid, timeout, Ctrl-C), the state
  // is the only thing that lets `shumi login --paste` accept the resulting
  // callback *and still verify it*. Without it, recovery would mean dropping
  // the CSRF check, which turns a UX fix into a login-CSRF hole.
  savePendingLoginState(state);

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId;

    function cleanup() {
      settled = true;
      clearTimeout(timeoutId);
      server.close();
    }

    const server = createServer((req, res) => {
      const url = new URL(req.url, `http://localhost`);

      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      if (settled) {
        res.writeHead(400);
        res.end('Authentication already completed.');
        return;
      }

      const callbackState = url.searchParams.get('state');
      const token = url.searchParams.get('token');
      const wallet = url.searchParams.get('wallet');
      const expiresAt = url.searchParams.get('expiresAt');

      if (callbackState !== state) {
        res.writeHead(400);
        res.end('Invalid state parameter. Authentication failed.');
        cleanup();
        reject(new Error('State mismatch — possible CSRF attempt'));
        return;
      }

      if (!token || !wallet) {
        res.writeHead(400);
        res.end('Missing token or wallet. Authentication failed.');
        cleanup();
        reject(new Error('Missing token or wallet in callback'));
        return;
      }

      saveCredentials({ token, walletAddress: wallet, expiresAt: expiresAt || null });
      clearPendingLoginState();

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <html>
          <body style="font-family: monospace; background: #1c1c1e; color: #fff; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0;">
            <div style="text-align: center;">
              <h1>Authenticated</h1>
              <p>You can close this tab and return to your terminal.</p>
            </div>
          </body>
        </html>
      `);

      cleanup();
      resolve({ walletAddress: wallet });
    });

    // Listen on random port
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const authUrl = `${AUTH_URL}?state=${state}&port=${port}`;
      // Surface the URL so the user can paste it manually if the browser
      // didn't open (headless box, default-browser misconfig, etc.).
      if (typeof onUrl === 'function') onUrl(authUrl);
      open(authUrl).catch(() => {
        // open() rejects when no browser could be launched; the printed URL
        // above is the fallback, so swallow and keep waiting.
      });
    });

    // Must stay >= the browser page's own 25s watchdog so the browser shows its
    // specific error first. 5 minutes rather than 2 because that error now asks
    // for real work: find the ad blocker, disable it for the site, reload, then
    // sign. At 2 minutes that recovery raced us, and losing meant signing in
    // successfully to a port we had already stopped listening on. Holding a
    // localhost socket open costs nothing.
    timeoutId = setTimeout(() => {
      if (!settled) {
        cleanup();
        const err = new Error('Authentication timed out — no response from the browser.');
        err.timedOut = true;
        reject(err);
      }
    }, 300000);
  });
}

/**
 * Parse a stranded callback URL — the one the browser landed on after the
 * local listener was already gone (ERR_CONNECTION_REFUSED). The token in that
 * URL is valid and already issued; before this existed the only recovery was
 * to redo the whole sign-in, often into the same wall.
 *
 * Pure: validates and returns the credential, writes nothing. The caller
 * confirms with the user before saving.
 *
 * Security: the `state` is checked against the value the login command
 * persisted, so a callback URL crafted by someone else cannot log this CLI
 * into an account the user did not sign in to. The URL is only parsed, never
 * fetched.
 */
export function parseCallbackUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl).trim());
  } catch {
    throw new Error('That is not a URL. Copy the full address from the browser, starting with http://');
  }

  const token = url.searchParams.get('token');
  const wallet = url.searchParams.get('wallet');
  const callbackState = url.searchParams.get('state');
  const expiresAt = url.searchParams.get('expiresAt');

  if (!token || !wallet) {
    throw new Error('That URL has no token in it. Make sure you copied the address the sign-in redirected to.');
  }

  const pending = getPendingLoginState();
  if (!pending) {
    throw new Error('No sign-in is pending (or it started over an hour ago). Run: shumi login');
  }
  if (callbackState !== pending) {
    throw new Error('State mismatch — this URL is not from the sign-in you started. Run: shumi login');
  }

  const info = inspectToken(token);
  if (info.expired) {
    throw new Error(`That token already expired (${info.expiresAt}). Run: shumi login`);
  }

  return { token, walletAddress: wallet, expiresAt: expiresAt || info.expiresAt || null, email: info.email };
}

/** Commit a credential returned by parseCallbackUrl(), after the user confirms. */
export function acceptCallbackCredential({ token, walletAddress, expiresAt }) {
  saveCredentials({ token, walletAddress, expiresAt: expiresAt || null });
  clearPendingLoginState();
}

export function logout() {
  clearCredentials();
  clearPendingLoginState();
}
