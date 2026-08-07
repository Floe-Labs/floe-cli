import { sanitizeText, UsageError } from './output.js';
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
  const safeSummary = sanitizeText(summary);
  const safeExpected = sanitizeText(expected);
  if (!isInteractive()) {
    throw new UsageError(`Refusing to ${safeSummary} without confirmation — re-run with --yes.`);
  }
  const answer = await ask(`About to ${safeSummary}.\nType "${safeExpected}" to confirm: `);
  if (answer !== safeExpected) {
    throw new UsageError('Confirmation did not match — aborted.');
  }
}
