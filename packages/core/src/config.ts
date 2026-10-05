// Configuration is read from `.warden/config.json`. There are no settings yet, so `init` does not
// create the file; a missing file or `{}` means defaults.
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { CONFIG_FILE, DIR_NAME } from './constants.js';
import { WardenError } from './errors.js';

// No settings yet. Unknown keys are errors so typos do not silently do nothing.
export const ConfigSchema = z.strictObject({});
export type WardenConfig = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG: WardenConfig = {};

export async function loadConfig(root: string): Promise<WardenConfig> {
  const file = path.join(root, DIR_NAME, CONFIG_FILE);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULT_CONFIG };
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new WardenError(
      'INVALID_CONFIG',
      `${DIR_NAME}/${CONFIG_FILE} is not valid JSON: ${(e as Error).message}`,
    );
  }
  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new WardenError('INVALID_CONFIG', `${DIR_NAME}/${CONFIG_FILE} is invalid: ${result.error.message}`);
  }
  return { ...DEFAULT_CONFIG, ...result.data };
}
