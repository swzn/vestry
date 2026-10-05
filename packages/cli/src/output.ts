// The one place that prints results (human or --json) and maps findings to exit codes.
import { ExitCode, isWardenError, Report, toEnvelope } from '@warden/core';
import type { Envelope, Finding } from '@warden/core';
import type { IO } from './io.js';

export interface Ctx {
  io: IO;
  json: boolean;
  strict: boolean;
  quiet: boolean;
  cwd: string;
}

export interface CommandOutput<T> {
  data: T;
  report?: Report;
  /** human-readable rendering of `data` */
  human: (data: T) => string;
  /** write to stderr instead of stdout (git hooks) */
  toStderr?: boolean;
}

const label: Record<Finding['severity'], string> = { info: 'note', warning: 'warning', error: 'error' };

export function renderFindings(findings: Finding[]): string {
  return findings.map((f) => `${label[f.severity]}: ${f.message}${f.path ? ` (${f.path})` : ''}`).join('\n');
}

function emit<T>(ctx: Ctx, out: CommandOutput<T>): number {
  const report = out.report ?? new Report();
  const envelope: Envelope<T> = toEnvelope(out.data, report, ctx.strict);
  if (ctx.json) {
    ctx.io.out(JSON.stringify(envelope, null, 2));
  } else {
    const write = out.toStderr ? ctx.io.err : ctx.io.out;
    const human = out.human(out.data);
    if (human && !ctx.quiet) write(human);
    const findings = ctx.quiet
      ? envelope.errors
      : [...envelope.info, ...envelope.warnings, ...envelope.errors];
    if (findings.length) ctx.io.err(renderFindings(findings));
  }
  return report.exitCode(ctx.strict);
}

export async function execute<T>(ctx: Ctx, fn: () => Promise<CommandOutput<T>>): Promise<number> {
  let out: CommandOutput<T>;
  try {
    out = await fn();
  } catch (e) {
    const err = isWardenError(e)
      ? { code: e.code, message: e.message, exit: e.exitCode }
      : { code: 'INTERNAL', message: (e as Error).message ?? String(e), exit: ExitCode.Error };
    const report = new Report().error(err.code, err.message);
    if (ctx.json) ctx.io.out(JSON.stringify(toEnvelope(null, report, ctx.strict), null, 2));
    else ctx.io.err(`error: ${err.message}`);
    return err.exit;
  }
  return emit(ctx, out);
}
