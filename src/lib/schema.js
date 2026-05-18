/**
 * Attach an output schema to a Commander command. Surfaced in `shumi commands --json`.
 *
 *   cmd.command('risk').argument('<symbol>')...
 *   withSchema(cmd, {
 *     kind: 'object',
 *     fields: { symbol: 'string', price: 'number', funding_apr: 'number', trend_daily: 'string' },
 *     example: { symbol: 'BTC', price: 67000, funding_apr: 0.04, trend_daily: 'UP' },
 *   });
 *
 * `kind` is freeform; conventions:
 *   - 'object' — single record, `fields` documents keys
 *   - 'array'  — list of records, `fields` documents item keys
 *   - 'envelope' — full envelope object (used by manifest/version/doctor)
 */
export function withSchema(cmd, schema) {
  cmd._shumiSchema = schema;
  return cmd;
}

export function getSchema(cmd) {
  return cmd._shumiSchema || null;
}
