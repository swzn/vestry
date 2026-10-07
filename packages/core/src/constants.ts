// Product name and the names derived from it. Kept in one place so a rename touches a single file.
export const PRODUCT_NAME = 'Vestry';
export const BIN_NAME = 'vestry';
export const DIR_NAME = '.vestry';
export const ENV_PREFIX = 'VESTRY';
export const IGNORE_FILE = '.vestryignore';
export const CONFIG_FILE = 'config.json';

export const SCHEMA_VERSION = 1;
export const MIN_GIT_VERSION = '2.23.0';
export const MIN_NODE_VERSION = '24.19.0';

export const SESSION_ENV = `${ENV_PREFIX}_SESSION`;
export const DEFAULT_SESSION = 'default';

/** Sub-directories of the ledger directory. */
export const LEDGER_DIRS = {
  changesets: 'changesets',
  entries: 'entries',
  pending: 'pending',
  cache: '.cache',
} as const;

/** The well-known hash of git's empty tree, used to diff the first commit. */
export const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
