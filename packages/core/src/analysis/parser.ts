// Tree-sitter runtime (WASM). Everything here fails soft: a language that cannot be loaded means "not analyzed",
// never a crash, so commands that do not need symbols keep working.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as TreeSitter from '@vscode/tree-sitter-wasm';
import type { Language as TsLanguage, Parser as TsParser } from '@vscode/tree-sitter-wasm';

type Runtime = typeof TreeSitter;

/**
 * Where the .wasm files live. A published package ships them next to the bundle (`dist/wasm`); in the
 * repository (tests, `tsx`) they come from the `@vscode/tree-sitter-wasm` dev dependency.
 */
export function wasmDirectory(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const shipped = path.join(here, 'wasm');
  if (fs.existsSync(path.join(shipped, 'tree-sitter.wasm'))) return shipped;
  try {
    return path.dirname(createRequire(import.meta.url).resolve('@vscode/tree-sitter-wasm'));
  } catch {
    return null;
  }
}

/** Why the runtime or a grammar could not be loaded, for error messages. */
export const parserProblems: string[] = [];

let runtime: Promise<Runtime | null> | null = null;
const languages = new Map<string, Promise<TsLanguage | null>>();

/** Load and initialise the tree-sitter runtime once. Resolves to null when it is unavailable. */
export function loadRuntime(): Promise<Runtime | null> {
  runtime ??= (async () => {
    try {
      const dir = wasmDirectory();
      if (!dir) {
        parserProblems.push('the wasm directory was not found');
        return null;
      }
      const mod = (await import('@vscode/tree-sitter-wasm')) as unknown as Runtime & { default?: Runtime };
      const ts = mod.Parser ? mod : (mod.default as Runtime);
      await ts.Parser.init({ locateFile: (file: string) => path.join(dir, file) });
      return ts;
    } catch (e) {
      parserProblems.push(`runtime: ${(e as Error).message}`);
      return null;
    }
  })();
  return runtime;
}

/** Load a grammar by its wasm file name (for example `tree-sitter-java.wasm`). Cached. */
export function loadLanguage(wasmFile: string): Promise<TsLanguage | null> {
  let p = languages.get(wasmFile);
  if (!p) {
    p = (async () => {
      const ts = await loadRuntime();
      const dir = wasmDirectory();
      if (!ts || !dir) return null;
      try {
        return await ts.Language.load(path.join(dir, wasmFile));
      } catch (e) {
        parserProblems.push(`${wasmFile}: ${(e as Error).message}`);
        return null;
      }
    })();
    languages.set(wasmFile, p);
  }
  return p;
}

/** A fresh parser bound to a language; the caller must `delete()` it (and any tree) when done. */
export async function newParser(language: TsLanguage): Promise<TsParser | null> {
  const ts = await loadRuntime();
  if (!ts) return null;
  const parser = new ts.Parser();
  parser.setLanguage(language);
  return parser;
}
