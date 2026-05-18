/**
 * Capability manifest — enumerates the registered command tree so AI agents
 * can self-discover the surface via `shumi commands --json`.
 *
 * Walks Commander's registered commands recursively, extracts name/description
 * /options/arguments, and emits a stable shape. Bump `schemaVersion` on a
 * breaking change.
 */
export const MANIFEST_SCHEMA = 1;

export function buildManifest(program) {
  return {
    schemaVersion: MANIFEST_SCHEMA,
    name: program.name(),
    description: program.description(),
    version: program.version(),
    commands: walk(program),
  };
}

function walk(cmd) {
  return (cmd.commands || [])
    .filter((c) => c.name() !== 'help')
    .map((c) => ({
      name: c.name(),
      description: c.description(),
      arguments: (c.registeredArguments || c._args || []).map((a) => ({
        name: a.name(),
        required: a.required,
        ...(a.variadic && { variadic: true }),
        ...(a.description && { description: a.description }),
        ...(a.defaultValue !== undefined && { default: a.defaultValue }),
      })),
      options: c.options.map((o) => ({
        flags: o.flags,
        description: o.description,
        ...(o.defaultValue !== undefined && { default: o.defaultValue }),
      })),
      ...(c._shumiSchema && { output: c._shumiSchema }),
      ...(c.commands?.length && { subcommands: walk(c) }),
    }));
}
