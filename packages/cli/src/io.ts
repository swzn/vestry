import fs from 'node:fs/promises';

export interface IO {
  out(text: string): void;
  err(text: string): void;
  readStdin(): Promise<string>;
  cwd: string;
  /** absolute path of the running CLI entry file (used to write the git hook) */
  cliPath: string;
}

export function defaultIO(cliPath: string): IO {
  return {
    out: (t) => process.stdout.write(t.endsWith('\n') ? t : t + '\n'),
    err: (t) => process.stderr.write(t.endsWith('\n') ? t : t + '\n'),
    readStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const c of process.stdin) chunks.push(c as Buffer);
      return Buffer.concat(chunks).toString('utf8');
    },
    cwd: process.cwd(),
    cliPath,
  };
}

/** `-` means stdin, anything else is a file path. */
export async function readInput(io: IO, spec: string): Promise<string> {
  if (spec === '-') return io.readStdin();
  return fs.readFile(spec, 'utf8');
}
