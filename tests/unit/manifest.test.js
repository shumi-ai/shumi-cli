import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { buildManifest, MANIFEST_SCHEMA } from '../../src/lib/manifest.js';

function makeProgram() {
  const program = new Command();
  program.name('shumi').description('test').version('0.0.0');
  const coin = program.command('coin').argument('[symbol]', 'coin symbol').option('--raw', 'raw').description('coin');
  coin.command('risk').argument('<symbol>', 'sym').description('risk');
  program.command('doctor').description('doctor');
  return program;
}

describe('buildManifest', () => {
  it('returns a stable shape with schemaVersion', () => {
    const m = buildManifest(makeProgram());
    expect(m.schemaVersion).toBe(MANIFEST_SCHEMA);
    expect(m.name).toBe('shumi');
    expect(m.version).toBe('0.0.0');
    expect(Array.isArray(m.commands)).toBe(true);
  });

  it('includes top-level commands and their subcommands', () => {
    const m = buildManifest(makeProgram());
    const coin = m.commands.find((c) => c.name === 'coin');
    expect(coin).toBeDefined();
    expect(coin.subcommands).toHaveLength(1);
    expect(coin.subcommands[0].name).toBe('risk');
  });

  it('captures arguments with required and description', () => {
    const m = buildManifest(makeProgram());
    const coin = m.commands.find((c) => c.name === 'coin');
    const risk = coin.subcommands[0];
    expect(risk.arguments[0]).toMatchObject({ name: 'symbol', required: true });
  });

  it('excludes the auto-generated help command', () => {
    const m = buildManifest(makeProgram());
    expect(m.commands.some((c) => c.name === 'help')).toBe(false);
  });
});
