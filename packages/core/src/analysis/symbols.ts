// Symbols of a source file: qualified names, kinds and line ranges, plus lookups by range and by name.
import type { Node } from '@vscode/tree-sitter-wasm';
import { LANGUAGES, pluginForFile } from './languages.js';
import type { LanguagePlugin } from './languages.js';
import { loadLanguage, loadRuntime, newParser, parserProblems } from './parser.js';

export interface SymbolInfo {
  /** qualified through enclosing containers, for example `Widget.render` */
  name: string;
  /** `function`, `method`, `class`, `interface`, `enum`, `type`, `namespace`, `variable` or `field` */
  kind: string;
  /** 1-based inclusive lines of the whole definition (including a leading `export`) */
  range: [number, number];
}

export type SymbolsResult =
  | { status: 'ok'; language: string; symbols: SymbolInfo[] }
  | { status: 'unsupported'; reason: string }
  | { status: 'failed'; reason: string };

const lineRange = (node: Node): [number, number] => {
  const start = node.startPosition.row + 1;
  let end = node.endPosition.row + 1;
  if (node.endPosition.column === 0 && end > start) end -= 1;
  return [start, end];
};

interface Def {
  node: Node;
  name: string;
  kind: string;
  /** node that bounds the definition: a declarator's whole declaration, or an `export` wrapper */
  outer: Node;
}

/** The node whose lines make up the definition as a reader sees it. */
function outerNode(node: Node): Node {
  let outer = node;
  if (outer.type === 'variable_declarator' && outer.parent) {
    const p = outer.parent;
    if (p.type === 'lexical_declaration' || p.type === 'variable_declaration') outer = p;
  }
  if (outer.parent?.type === 'export_statement') outer = outer.parent;
  return outer;
}

/** Parse a source file and list its symbols. Never throws: failures are reported in the result. */
export async function extractSymbols(file: string, source: string): Promise<SymbolsResult> {
  const plugin = pluginForFile(file);
  if (!plugin) return { status: 'unsupported', reason: `no language support for ${file}` };
  return extractWith(plugin, source);
}

async function extractWith(plugin: LanguagePlugin, source: string): Promise<SymbolsResult> {
  const ts = await loadRuntime();
  const language = await loadLanguage(plugin.wasm);
  if (!ts || !language)
    return {
      status: 'failed',
      reason: `the ${plugin.id} grammar could not be loaded (${parserProblems.at(-1) ?? 'unknown reason'})`,
    };
  const parser = await newParser(language);
  if (!parser) return { status: 'failed', reason: 'the parser could not be created' };
  let tree: ReturnType<typeof parser.parse> = null;
  let query: InstanceType<typeof ts.Query> | null = null;
  try {
    tree = parser.parse(source);
    if (!tree) return { status: 'failed', reason: 'the file could not be parsed' };
    query = new ts.Query(language, plugin.symbolQuery);
    const defs = new Map<number, Def>();
    for (const m of query.matches(tree.rootNode)) {
      const nameCap = m.captures.find((c) => c.name === 'name');
      const defCap = m.captures.find((c) => c.name !== 'name');
      if (!nameCap || !defCap) continue;
      const existing = defs.get(defCap.node.id);
      // a declarator that holds a function matches both patterns; the more specific kind wins
      if (existing && !(existing.kind === 'variable' && defCap.name === 'function')) continue;
      defs.set(defCap.node.id, {
        node: defCap.node,
        name: nameCap.node.text,
        kind: defCap.name,
        outer: outerNode(defCap.node),
      });
    }
    const symbols: SymbolInfo[] = [];
    for (const def of defs.values()) {
      const chain: string[] = [];
      let local = false;
      for (let p = def.node.parent; p; p = p.parent) {
        const up = defs.get(p.id);
        if (!up) continue;
        if (plugin.opaque.includes(up.kind)) {
          local = true;
          break;
        }
        if (plugin.containers.includes(up.kind)) chain.unshift(up.name);
      }
      if (local) continue;
      symbols.push({ name: [...chain, def.name].join('.'), kind: def.kind, range: lineRange(def.outer) });
    }
    symbols.sort((a, b) => a.range[0] - b.range[0] || b.range[1] - a.range[1]);
    return { status: 'ok', language: plugin.id, symbols };
  } catch (e) {
    return { status: 'failed', reason: (e as Error).message };
  } finally {
    query?.delete();
    tree?.delete();
    parser.delete();
  }
}

/** The smallest symbols that enclose the range (innermost first); empty means file scope. */
export function symbolsAtRange(symbols: readonly SymbolInfo[], range: [number, number]): SymbolInfo[] {
  return symbols
    .filter((s) => s.range[0] <= range[0] && s.range[1] >= range[1])
    .sort((a, b) => a.range[1] - a.range[0] - (b.range[1] - b.range[0]));
}

/**
 * Symbols matching a user-supplied name. An exact qualified match wins; otherwise a trailing match
 * (`render` finds `Widget.render`) so users need not type the whole path. Several results mean the
 * name is ambiguous (overloads, or the same name in two classes).
 */
export function findSymbols(symbols: readonly SymbolInfo[], name: string): SymbolInfo[] {
  const exact = symbols.filter((s) => s.name === name);
  if (exact.length) return exact;
  return symbols.filter((s) => s.name.endsWith(`.${name}`));
}

export const supportedExtensions = (): string[] => LANGUAGES.flatMap((l) => [...l.extensions]);
