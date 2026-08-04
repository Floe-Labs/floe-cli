/** Terminal output helpers. Color only when the target stream is a TTY and NO_COLOR is unset. */

const ESC = '\u001b';
const useColor = process.stdout.isTTY === true && !process.env.NO_COLOR;
const useErrColor = process.stderr.isTTY === true && !process.env.NO_COLOR;

const wrap = (open: string, close: string, enabled: boolean) => (s: string) =>
  enabled ? `${ESC}[${open}m${s}${ESC}[${close}m` : s;

export const bold = wrap('1', '22', useColor);
export const dim = wrap('2', '22', useColor);
export const green = wrap('32', '39', useColor);
export const red = wrap('31', '39', useColor);
export const yellow = wrap('33', '39', useColor);
export const cyan = wrap('36', '39', useColor);

// Variants for text written to stderr, which may be redirected independently of stdout.
export const errRed = wrap('31', '39', useErrColor);
export const errDim = wrap('2', '22', useErrColor);

export const ok = (s: string) => `${green('✓')} ${s}`;
export const warn = (s: string) => `${yellow('!')} ${s}`;

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Two-column aligned key/value block. */
export function kv(rows: Array<[string, string]>): string {
  const width = Math.max(...rows.map(([k]) => k.length));
  return rows.map(([k, v]) => `  ${dim(k.padEnd(width))}  ${v}`).join('\n');
}

export class UsageError extends Error {}
