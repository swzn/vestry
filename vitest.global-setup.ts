// Build the CLI once so end-to-end tests can run the real binary (with a real git hook).
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export default function setup(): void {
  execFileSync(process.execPath, [path.resolve('node_modules/tsup/dist/cli-default.js')], {
    cwd: path.resolve('packages/cli'),
    stdio: 'inherit',
  });
}
