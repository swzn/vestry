// Export the ledger schemas as JSON Schema files for external tools and validation.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { RecordInputSchema } from '../src/record/record.js';
import { ChangesetSchema, EntrySchema, PendingFileSchema } from '../src/schema/schemas.js';

const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../schemas');
fs.mkdirSync(outDir, { recursive: true });

const files: Record<string, z.ZodType> = {
  'changeset.schema.json': ChangesetSchema,
  'entry.schema.json': EntrySchema,
  'record-input.schema.json': RecordInputSchema,
  'pending.schema.json': PendingFileSchema,
};

for (const [name, schema] of Object.entries(files)) {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  fs.writeFileSync(path.join(outDir, name), JSON.stringify(json, null, 2) + '\n');
  console.log('wrote', path.join('schemas', name));
}
