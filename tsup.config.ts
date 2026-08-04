import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/bin.ts', 'src/main.ts'],
  format: ['esm'],
  target: 'node18',
  sourcemap: true,
  clean: true,
  splitting: false,
  // @napi-rs/keyring is a native optional dep, loaded via dynamic import at
  // runtime; bundling it would defeat the graceful-fallback path.
  external: ['@napi-rs/keyring'],
});
