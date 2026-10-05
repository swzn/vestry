import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { bin: 'src/bin.ts' },
  format: ['esm'],
  target: 'node24',
  platform: 'node',
  clean: true,
  sourcemap: false,
  splitting: false,
  // bundle the workspace core package so the CLI is a single self-contained file
  noExternal: [/^@warden\/core/],
  banner: { js: '#!/usr/bin/env node' },
});
