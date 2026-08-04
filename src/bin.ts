#!/usr/bin/env node
import { main } from './main.js';

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
