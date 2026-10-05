// Types and runtime validators for the ledger. Ranges are 1-based and inclusive.
import { z } from 'zod';

export const CHANGESET_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const ENTRY_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const CHANGE_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}#[1-9][0-9]*$/;
export const OID_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/; // sha-1 or sha-256 object ids

export const ChangesetIdSchema = z
  .string()
  .min(3)
  .max(80)
  .regex(CHANGESET_ID_RE, 'lowercase letters, digits and hyphens only');
export const EntryIdSchema = z.string().regex(ENTRY_ID_RE, 'must be a 26-character ULID');
export const ChangeIdSchema = z.string().regex(CHANGE_ID_RE, 'must look like <entry ulid>#<n>');
export const OidSchema = z.string().regex(OID_RE, 'must be a git object id');

export const RangeSchema = z
  .tuple([z.number().int().min(1), z.number().int().min(1)])
  .refine(([a, b]) => b >= a, 'range end must be >= start');
export type Range = z.infer<typeof RangeSchema>;

export const AuthorSchema = z.strictObject({
  kind: z.enum(['agent', 'human']),
  name: z.string().min(1),
  model: z.string().min(1).optional(),
});
export type Author = z.infer<typeof AuthorSchema>;

export const ReviewedBySchema = z.strictObject({
  kind: z.enum(['agent', 'human']),
  name: z.string().min(1),
});

const IdList = z.array(ChangesetIdSchema);

export const ChangesetSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: ChangesetIdSchema,
  title: z.string().min(1).max(200),
  /** free text: why the change was made (intent, constraints, alternatives considered), not a paraphrase of the diff */
  reasoning: z.string().min(1),
  author: AuthorSchema,
  supersedes: IdList.optional(),
  corrects: IdList.optional(),
  related: IdList.optional(),
  tags: z.array(z.string().min(1)).optional(),
  createdAt: z.iso.datetime(),
  provenance: z.strictObject({ source: z.string().optional() }).optional(),
  reviewedBy: ReviewedBySchema.optional(),
});
export type Changeset = z.infer<typeof ChangesetSchema>;

export const AffectSchema = z.strictObject({
  file: z.string().min(1),
  symbol: z.string().optional(),
  range: RangeSchema.optional(),
  via: z.string().min(1),
  confidence: z.enum(['high', 'medium', 'low']),
  /** was this dependent touched in the same changeset? Untouched dependents are the valuable signal. */
  covered: z.boolean(),
});
export type Affect = z.infer<typeof AffectSchema>;

export const ChangeSchema = z
  .strictObject({
    id: ChangeIdSchema,
    changeset: ChangesetIdSchema,
    file: z.string().min(1),
    /** only oldRange: deleted; only newRange: written; both: modified */
    oldRange: RangeSchema.optional(),
    newRange: RangeSchema.optional(),
    /** for pure deletions: the new-file line immediately before the deletion point (0 at file start) */
    at: z.number().int().min(0).optional(),
    /** `<nonBlankLineCount>:<hash12>` of the normalized new range text */
    rangeHash: z
      .string()
      .regex(/^\d+:[0-9a-f]{12}$/)
      .optional(),
    /** for deletions: hashes of the nearest non-blank lines above and below the deletion point */
    anchorHashes: z.strictObject({ above: z.string().nullable(), below: z.string().nullable() }).optional(),
    symbols: z.array(z.string()).optional(),
    comment: z.string().optional(),
    affects: z.array(AffectSchema).optional(),
    affectsTotal: z.number().int().min(0).optional(),
    reviewedBy: ReviewedBySchema.optional(),
  })
  .refine((c) => c.oldRange !== undefined || c.newRange !== undefined, 'a change needs oldRange or newRange')
  .refine((c) => c.newRange !== undefined || c.at !== undefined, 'a deletion needs an `at` anchor');
export type Change = z.infer<typeof ChangeSchema>;

export const EntryFileSchema = z.strictObject({
  path: z.string().min(1),
  oldPath: z.string().min(1).optional(),
  /** blob id of the file in the commit this entry describes; null for deleted files */
  blobAfter: OidSchema.nullable(),
});
export type EntryFile = z.infer<typeof EntryFileSchema>;

export const EntrySchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: EntryIdSchema,
  /** HEAD at finalize time (the commit's parent); null for the first commit */
  base: OidSchema.nullable(),
  createdAt: z.iso.datetime(),
  author: AuthorSchema,
  files: z.array(EntryFileSchema),
  changes: z.array(ChangeSchema),
});
export type Entry = z.infer<typeof EntrySchema>;

// ---- pending (local, gitignored) state ----

/** What `record` remembers about a hunk so finalize can find it again after formatting. */
export const HunkFingerprintSchema = z.strictObject({
  id: z.string().min(1),
  file: z.string().min(1),
  /** whitespace-insensitive hash of the changed text */
  hWs: z.string(),
  /** token-normalized hash (quotes, commas, semicolons ignored) */
  hTok: z.string(),
  /** token-normalized added text (capped); lets finalize match merged or split hunks */
  plusTok: z.string(),
  minusTok: z.string(),
  /** unique identifiers in the changed text, space separated (capped); used for the similarity fallback */
  idents: z.string().default(''),
  symbols: z.array(z.string()).default([]),
  /** approximate position when recorded; only used to break ties */
  newStart: z.number().int().min(0),
  plusCount: z.number().int().min(0),
  minusCount: z.number().int().min(0),
});
export type HunkFingerprint = z.infer<typeof HunkFingerprintSchema>;

export const PendingChangesetSchema = z.strictObject({
  id: ChangesetIdSchema,
  title: z.string().min(1),
  reasoning: z.string().min(1),
  author: AuthorSchema,
  supersedes: IdList.optional(),
  corrects: IdList.optional(),
  related: IdList.optional(),
  tags: z.array(z.string()).optional(),
  createdAt: z.iso.datetime(),
  provenance: z.strictObject({ source: z.string().optional() }).optional(),
});
export type PendingChangeset = z.infer<typeof PendingChangesetSchema>;

export const PendingChangeSchema = z.strictObject({
  /** local id for this pending record */
  key: z.string().min(1),
  changeset: ChangesetIdSchema,
  hunk: HunkFingerprintSchema,
  comment: z.string().optional(),
  /** why a human should check this change (for example a possible secret); blocks finalize until cleared */
  needsReview: z.string().optional(),
  recordedAt: z.iso.datetime(),
});
export type PendingChange = z.infer<typeof PendingChangeSchema>;

export const PendingFileSchema = z.strictObject({
  version: z.literal(1),
  session: z.string().min(1),
  changesets: z.array(PendingChangesetSchema),
  changes: z.array(PendingChangeSchema),
});
export type PendingFile = z.infer<typeof PendingFileSchema>;
