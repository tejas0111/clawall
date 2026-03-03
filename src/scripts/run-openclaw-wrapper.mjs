import { normalizeAgentArgs, runOpenClawCommand } from './openclaw-agent-utils.mjs';

export function runOpenClawWrapper(subcommand, label, argv = process.argv.slice(2)) {
  try {
    const normalized = normalizeAgentArgs(argv);
    const exitCode = runOpenClawCommand(subcommand, normalized);
    process.exit(exitCode);
  } catch (err) {
    console.error(`${label} failed:`, err?.message ?? err);
    process.exit(1);
  }
}
