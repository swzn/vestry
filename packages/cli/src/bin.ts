import { fileURLToPath } from 'node:url';
import { main } from './cli.js';
import { defaultIO } from './io.js';

process.exitCode = await main(process.argv.slice(2), defaultIO(fileURLToPath(import.meta.url)));
