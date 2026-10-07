import { describe, it, expect, afterEach } from 'vitest';
import { homedir } from 'os';
import {
  _setClientForTests,
  captureError,
  flush,
  resolveReleaseStage,
  sanitizeError,
} from '../../src/lib/telemetry.js';

function fakeClient() {
  const exceptions = [];
  const events = [];
  return {
    exceptions,
    events,
    capture: (msg) => events.push(msg),
    captureExceptionImmediate: async (err, distinctId, props) => {
      exceptions.push({ err, distinctId, props });
    },
    flush: async () => {},
    shutdown: async () => {},
  };
}

afterEach(() => _setClientForTests(null));

describe('captureError → PostHog Error Tracking', () => {
  it('sends a $exception with every contract property', async () => {
    const fake = fakeClient();
    _setClientForTests(fake);
    captureError(new TypeError('boom'), { command: 'coin', surface: 'nlp' });
    await flush();
    expect(fake.exceptions).toHaveLength(1);
    const { err, props } = fake.exceptions[0];
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('TypeError');
    expect(props.surface).toBe('cli');
    expect(props.error_source).toBe('nlp');
    expect(props.severity).toBe('error');
    expect(['production', 'development']).toContain(props.release_stage);
    expect(typeof props.app_version).toBe('string');
    expect(props.app_version).not.toBe('unknown');
    expect(props.handled).toBe(true);
    expect(props.mirrored_from).toBeUndefined();
    // the existing analytics event is still emitted
    expect(fake.events.some((e) => e.event === 'cli_error')).toBe(true);
  });

  it('marks process-hook crashes handled:false', async () => {
    const fake = fakeClient();
    _setClientForTests(fake);
    captureError(new Error('x'), { hook: 'uncaughtException' }, { handled: false });
    await flush();
    expect(fake.exceptions[0].props.handled).toBe(false);
  });

  it('flush waits for the in-flight exception send', async () => {
    let sent = false;
    const fake = fakeClient();
    fake.captureExceptionImmediate = () =>
      new Promise((resolve) => setTimeout(() => { sent = true; resolve(); }, 50));
    _setClientForTests(fake);
    captureError(new Error('slow'));
    await flush();
    expect(sent).toBe(true);
  });

  it('flush is bounded when the network hangs', async () => {
    const fake = fakeClient();
    fake.captureExceptionImmediate = () => new Promise(() => {});
    _setClientForTests(fake);
    captureError(new Error('hang'));
    const t0 = Date.now();
    await flush();
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it('never throws when the client throws or rejects', async () => {
    _setClientForTests({
      capture() { throw new Error('down'); },
      captureExceptionImmediate() { throw new Error('down'); },
      flush: async () => { throw new Error('down'); },
    });
    expect(() => captureError(new Error('x'))).not.toThrow();
    await expect(flush()).resolves.toBeUndefined();
  });

  it('is a no-op when telemetry is disabled', () => {
    _setClientForTests(null);
    expect(() => captureError(new Error('x'))).not.toThrow();
  });
});

describe('helpers', () => {
  it('sanitizeError hides the home directory and caps the message', () => {
    const e = new Error(`ENOENT ${homedir()}/.shumi/config.json ${'a'.repeat(600)}`);
    const s = sanitizeError(e);
    expect(s.message).not.toContain(homedir());
    expect(s.message.length).toBeLessThanOrEqual(500);
    expect(s.stack).not.toContain(homedir());
  });

  it('release stage: installed package is production, checkout is development', () => {
    expect(resolveReleaseStage('/usr/local/lib/node_modules/shumi/src/lib/telemetry.js')).toBe('production');
    expect(resolveReleaseStage('/home/x/code/shumi-cli/src/lib/telemetry.js')).toBe('development');
  });
});
