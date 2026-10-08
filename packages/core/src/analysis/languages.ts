// Language plugins: which files a grammar handles and the query that finds its symbols.
// A plugin is data (extensions, grammar file, query), so adding a language does not touch the engine.

export interface LanguagePlugin {
  id: string;
  /** lower-case file extensions including the dot */
  extensions: readonly string[];
  /** grammar file in the wasm directory */
  wasm: string;
  /**
   * Query that finds definitions. Each match must capture the definition node as `@<kind>` (for example
   * `@function`, `@class`) and its identifier as `@name`.
   */
  symbolQuery: string;
  /** kinds that qualify the names of the symbols inside them (`Class.method`) */
  containers: readonly string[];
  /** kinds whose bodies are not searched for further symbols (locals) */
  opaque: readonly string[];
}

const TS_QUERY = `
(function_declaration name: (identifier) @name) @function
(generator_function_declaration name: (identifier) @name) @function
(class_declaration name: (type_identifier) @name) @class
(abstract_class_declaration name: (type_identifier) @name) @class
(interface_declaration name: (type_identifier) @name) @interface
(type_alias_declaration name: (type_identifier) @name) @type
(enum_declaration name: (identifier) @name) @enum
(internal_module name: (identifier) @name) @namespace
(method_definition name: [(property_identifier) (private_property_identifier)] @name) @method
(abstract_method_signature name: (property_identifier) @name) @method
(method_signature name: (property_identifier) @name) @method
(variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)]) @function
(program (lexical_declaration (variable_declarator name: (identifier) @name) @variable))
(program (export_statement (lexical_declaration (variable_declarator name: (identifier) @name) @variable)))
`;

const JS_QUERY = `
(function_declaration name: (identifier) @name) @function
(generator_function_declaration name: (identifier) @name) @function
(class_declaration name: (identifier) @name) @class
(method_definition name: [(property_identifier) (private_property_identifier)] @name) @method
(variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)]) @function
(program (lexical_declaration (variable_declarator name: (identifier) @name) @variable))
(program (export_statement (lexical_declaration (variable_declarator name: (identifier) @name) @variable)))
`;

const JAVA_QUERY = `
(class_declaration name: (identifier) @name) @class
(interface_declaration name: (identifier) @name) @interface
(enum_declaration name: (identifier) @name) @enum
(record_declaration name: (identifier) @name) @class
(annotation_type_declaration name: (identifier) @name) @interface
(method_declaration name: (identifier) @name) @method
(constructor_declaration name: (identifier) @name) @method
(field_declaration declarator: (variable_declarator name: (identifier) @name)) @field
`;

const TS_CONTAINERS = ['class', 'interface', 'enum', 'namespace'] as const;
const OPAQUE = ['function', 'method'] as const;

export const LANGUAGES: readonly LanguagePlugin[] = [
  {
    id: 'typescript',
    extensions: ['.ts', '.mts', '.cts'],
    wasm: 'tree-sitter-typescript.wasm',
    symbolQuery: TS_QUERY,
    containers: TS_CONTAINERS,
    opaque: OPAQUE,
  },
  {
    id: 'tsx',
    extensions: ['.tsx'],
    wasm: 'tree-sitter-tsx.wasm',
    symbolQuery: TS_QUERY,
    containers: TS_CONTAINERS,
    opaque: OPAQUE,
  },
  {
    id: 'javascript',
    extensions: ['.js', '.jsx', '.mjs', '.cjs'],
    wasm: 'tree-sitter-javascript.wasm',
    symbolQuery: JS_QUERY,
    containers: ['class'],
    opaque: OPAQUE,
  },
  {
    id: 'java',
    extensions: ['.java'],
    wasm: 'tree-sitter-java.wasm',
    symbolQuery: JAVA_QUERY,
    containers: ['class', 'interface', 'enum'],
    opaque: OPAQUE,
  },
];

export function pluginForFile(file: string): LanguagePlugin | null {
  const dot = file.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = file.slice(dot).toLowerCase();
  return LANGUAGES.find((l) => l.extensions.includes(ext)) ?? null;
}
