// A single severity model and result envelope shared by every command.
import { ExitCode } from './errors.js';

export type Severity = 'info' | 'warning' | 'error';

export interface Finding {
  code: string;
  severity: Severity;
  message: string;
  path?: string;
  details?: Record<string, unknown>;
}

export class Report {
  private readonly items: Finding[] = [];

  add(finding: Finding): this {
    this.items.push(finding);
    return this;
  }
  info(code: string, message: string, extra: Partial<Finding> = {}): this {
    return this.add({ code, severity: 'info', message, ...extra });
  }
  warn(code: string, message: string, extra: Partial<Finding> = {}): this {
    return this.add({ code, severity: 'warning', message, ...extra });
  }
  error(code: string, message: string, extra: Partial<Finding> = {}): this {
    return this.add({ code, severity: 'error', message, ...extra });
  }
  merge(other: Report | Finding[]): this {
    for (const f of other instanceof Report ? other.findings : other) this.items.push(f);
    return this;
  }

  get findings(): readonly Finding[] {
    return this.items;
  }

  /** Findings as they should be treated: with strict, warnings count as errors. */
  effective(strict: boolean): Finding[] {
    return this.items.map((f) =>
      strict && f.severity === 'warning' ? { ...f, severity: 'error' as const } : f,
    );
  }

  hasErrors(strict = false): boolean {
    return this.effective(strict).some((f) => f.severity === 'error');
  }

  /** 0 ok, 1 error findings, 3 only warnings that strict promoted. */
  exitCode(strict = false): number {
    if (this.items.some((f) => f.severity === 'error')) return ExitCode.Error;
    if (strict && this.items.some((f) => f.severity === 'warning')) return ExitCode.Strict;
    return ExitCode.Ok;
  }
}

export interface Envelope<T> {
  ok: boolean;
  data: T;
  info: Finding[];
  warnings: Finding[];
  errors: Finding[];
}

export function toEnvelope<T>(data: T, report: Report, strict = false): Envelope<T> {
  const eff = report.effective(strict);
  const errors = eff.filter((f) => f.severity === 'error');
  return {
    ok: errors.length === 0,
    data,
    info: eff.filter((f) => f.severity === 'info'),
    warnings: eff.filter((f) => f.severity === 'warning'),
    errors,
  };
}
