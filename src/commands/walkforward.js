import { typedAction, addUniversalFlags } from '../lib/typedCmd.js';
import { smartFormat } from '../lib/smartFormat.js';

/**
 * Walkforward reads three tables that Engine B fills. Engine B is currently paused, so
 * `positions` comes back with zero rows and `outcomes` with a single row from 2026-05-28,
 * while `signals` still has recent data. Rendered raw, an empty list reads as "the command is
 * broken" or, worse, as "there are genuinely no open positions right now" — a materially
 * wrong answer for anyone sizing a trade off it.
 *
 * So when the collection is empty or its newest row is old, say why. Human mode only:
 * renderOk short-circuits to raw JSON before `human` runs under --json/--agent, so machine
 * consumers still get the untouched envelope.
 */

// A collection this far past its newest row is not "quiet", it is not being written to.
const STALE_AFTER_DAYS = 30;

const DATE_KEYS = ['createdAt', 'scanDate', 'entryDate', 'exitDate', 'date'];

function newestTimestamp(rows) {
  let newest = null;
  for (const row of rows) {
    for (const key of DATE_KEYS) {
      const raw = row?.[key];
      if (!raw) continue;
      const t = new Date(raw).getTime();
      if (Number.isFinite(t) && (newest === null || t > newest)) newest = t;
    }
  }
  return newest;
}

function daysSince(ms) {
  return Math.floor((Date.now() - ms) / 86_400_000);
}

/**
 * Build the human renderer for one walkforward action. `collection` is the key the server
 * returns the rows under. Exported for tests.
 */
export function walkforwardHuman(collection) {
  return (data, chalk) => {
    const rows = Array.isArray(data?.[collection]) ? data[collection] : null;

    if (rows && rows.length === 0) {
      process.stdout.write(
        `${chalk.yellow('No ' + collection + '.')} Engine B fills this table and is currently paused, `
        + `so this is an empty table rather than a reading of the market — do not read it as `
        + `"no open positions".\n`
        + chalk.dim('  `shumi walkforward signals` still has recent data.\n'),
      );
      return;
    }

    if (rows && rows.length > 0) {
      const newest = newestTimestamp(rows);
      if (newest !== null && daysSince(newest) >= STALE_AFTER_DAYS) {
        process.stdout.write(
          chalk.yellow(
            `⚠ Newest row is ${daysSince(newest)} days old (${new Date(newest).toISOString().slice(0, 10)}). `,
          )
          + `Engine B is paused, so this is history, not a current view.\n\n`,
        );
      }
    }

    smartFormat(data, chalk);
  };
}

export function registerWalkforwardCommand(program) {
  const wf = program.command('walkforward').description('walkforward backtest signals, positions, outcomes');

  for (const action of ['signals', 'positions', 'outcomes']) {
    wf.command(action)
      .description(`walkforward ${action}`)
      .action(typedAction({
        route: 'walkforward',
        query: { action },
        spinner: `walkforward ${action}…`,
        human: walkforwardHuman(action),
      }));
  }
}
