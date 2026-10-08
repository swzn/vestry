import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { defineConfig } from 'tsup';

// Only the grammars Vestry can analyze are shipped (about 4 MB), not the 21 MB the grammar package carries.
const WASM_FILES = [
  'tree-sitter.wasm',
  'tree-sitter-typescript.wasm',
  'tree-sitter-tsx.wasm',
  'tree-sitter-javascript.wasm',
  'tree-sitter-java.wasm',
];

export default defineConfig({
  entry: { bin: 'src/bin.ts' },
  format: ['esm'],
  target: 'node24',
  platform: 'node',
  clean: true,
  sourcemap: false,
  splitting: false,
  // bundle the workspace core package and the tree-sitter runtime so the CLI is one file plus its wasm assets
  noExternal: [/^@vestry\/core/, '@vscode/tree-sitter-wasm'],
  // the tree-sitter runtime is CommonJS (Emscripten): it needs require() and __filename/__dirname
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __createRequire } from 'node:module';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      "import { dirname as __dirnameOf } from 'node:path';",
      'const require = __createRequire(import.meta.url);',
      'const __filename = __fileURLToPath(import.meta.url);',
      'const __dirname = __dirnameOf(__filename);',
    ].join('\n'),
  },
  onSuccess: async () => {
    const source = path.dirname(createRequire(import.meta.url).resolve('@vscode/tree-sitter-wasm'));
    const target = path.resolve('dist', 'wasm');
    fs.mkdirSync(target, { recursive: true });
    for (const file of WASM_FILES) fs.copyFileSync(path.join(source, file), path.join(target, file));
  },
});
