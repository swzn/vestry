export const ExitCode = {
  Ok: 0,
  Error: 1,
  Usage: 2,
  /** warnings promoted to failures by --strict */
  Strict: 3,
} as const;

export type ErrorCode =
  | 'NOT_A_REPO'
  | 'GIT_MISSING'
  | 'GIT_TOO_OLD'
  | 'GIT_FAILED'
  | 'NODE_TOO_OLD'
  | 'NOT_INITIALIZED'
  | 'INVALID_INPUT'
  | 'INVALID_CONFIG'
  | 'UNKNOWN_CHANGESET'
  | 'UNKNOWN_HUNK'
  | 'UNRESOLVED_PENDING'
  | 'SHALLOW_REPO'
  | 'WRITE_ONCE'
  | 'USAGE';

export class WardenError extends Error {
  readonly code: ErrorCode;
  readonly exitCode: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, options: { details?: unknown; exitCode?: number } = {}) {
    super(message);
    this.name = 'WardenError';
    this.code = code;
    this.exitCode = options.exitCode ?? (code === 'USAGE' ? ExitCode.Usage : ExitCode.Error);
    this.details = options.details;
  }
}

export const isWardenError = (e: unknown): e is WardenError => e instanceof WardenError;
