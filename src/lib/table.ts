import { dim } from './output.js';

/** Visible width of a cell — ANSI color sequences take no columns. */
const ANSI_SEQUENCE = new RegExp('\\u001b\\[[0-9;]*m', 'g');
const visibleLength = (s: string) => s.replace(ANSI_SEQUENCE, '').length;

const pad = (s: string, width: number) => s + ' '.repeat(Math.max(0, width - visibleLength(s)));

/**
 * Column-aligned table for list output. Cells may contain ANSI color; callers
 * sanitize network-sourced text before it gets here. Header is dimmed, not
 * boxed — the output must stay grep- and pipe-friendly.
 */
export function table(header: string[], rows: string[][]): string {
  const all = [header, ...rows];
  const widths = header.map((_, col) =>
    Math.max(...all.map((row) => visibleLength(row[col] ?? ''))),
  );
  const render = (row: string[], style: (s: string) => string) =>
    `  ${row.map((cell, col) => pad(style(cell ?? ''), widths[col] ?? 0)).join('  ')}`.trimEnd();
  return [render(header, dim), ...rows.map((row) => render(row, (s) => s))].join('\n');
}
