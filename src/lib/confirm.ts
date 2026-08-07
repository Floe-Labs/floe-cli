import { UsageError } from './output.js';
import { ask, isInteractive } from './prompt.js';

/**
 * Gate for destructive or money-moving commands. Interactive callers type the
 * target's name back; non-interactive callers (CI, coding agents) must opt in
 * explicitly with --yes — a script must never destroy something by default.
 */
export async function confirmAction(
  summary: string,
  expected: string,
  opts: { yes?: boolean },
): Promise<void> {
  if (opts.yes) return;
  if (!isInteractive()) {
    throw new UsageError(`Refusing to ${summary} without confirmation — re-run with --yes.`);
  }
  const answer = await ask(`About to ${summary}.\nType "${expected}" to confirm: `);
  if (answer !== expected) {
    throw new UsageError('Confirmation did not match — aborted.');
  }
}
