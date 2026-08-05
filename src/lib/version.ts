import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// dist/*.js and src/lib/*.ts both resolve ../package.json differently, so walk
// both candidates; tsup bundles this file into dist/ where ../ is the package root.
export function cliVersion(): string {
  for (const candidate of ['../package.json', '../../package.json']) {
    try {
      const pkg = require(candidate) as { name?: string; version?: string };
      if (pkg.name === '@floelabs/cli' && pkg.version) return pkg.version;
    } catch {
      // try next candidate
    }
  }
  return '0.0.0';
}
