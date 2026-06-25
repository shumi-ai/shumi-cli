import { createServer } from 'http';
import { nanoid } from 'nanoid';
import open from 'open';
import { saveCredentials, clearCredentials } from './config.js';

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

    // Timeout after 2 minutes. This must stay >= the browser page's own 25s
    // watchdog so the browser can show its specific error first.
    timeoutId = setTimeout(() => {
      if (!settled) {
        cleanup();
        const err = new Error('Authentication timed out — no response from the browser.');
        err.timedOut = true;
        reject(err);
      }
    }, 120000);
  });
}

export function logout() {
  clearCredentials();
}
