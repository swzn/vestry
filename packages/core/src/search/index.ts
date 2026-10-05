// The search seam. Commands depend on `SearchProvider`, never on a concrete library, so the built-in
// token-overlap provider can be replaced by a full-text engine without touching callers.

export interface SearchDoc {
  id: string;
  kind: 'changeset' | 'change';
  title?: string;
  text: string;
  tags?: string[];
  file?: string;
  symbols?: string[];
}

export interface SearchHit {
  id: string;
  score: number;
}

export interface SearchOptions {
  limit?: number;
  kind?: SearchDoc['kind'];
}

export interface SearchProvider {
  index(docs: SearchDoc[]): void;
  search(query: string, opts?: SearchOptions): SearchHit[];
}

const STOP = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'into',
  'are',
  'was',
  'not',
  'but',
  'its',
  'our',
  'has',
  'have',
]);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9_]+/g) ?? [])
    .filter((t) => t.length > 2 && !STOP.has(t))
    .map((t) => (t.length > 4 && t.endsWith('s') ? t.slice(0, -1) : t));
}

/** Token-overlap scoring with field weights. Simple and dependency-free. */
export class SimpleSearchProvider implements SearchProvider {
  private docs: { doc: SearchDoc; title: Set<string>; body: Set<string>; extra: Set<string> }[] = [];

  index(docs: SearchDoc[]): void {
    this.docs = docs.map((doc) => ({
      doc,
      title: new Set(tokenize(doc.title ?? '')),
      body: new Set(tokenize(doc.text)),
      extra: new Set(tokenize([...(doc.tags ?? []), ...(doc.symbols ?? []), doc.file ?? ''].join(' '))),
    }));
  }

  search(query: string, opts: SearchOptions = {}): SearchHit[] {
    const q = [...new Set(tokenize(query))];
    if (q.length === 0) return [];
    const hits: SearchHit[] = [];
    for (const d of this.docs) {
      if (opts.kind && d.doc.kind !== opts.kind) continue;
      let score = 0;
      for (const t of q) {
        if (d.title.has(t)) score += 3;
        if (d.body.has(t)) score += 1;
        if (d.extra.has(t)) score += 2;
      }
      if (score > 0) hits.push({ id: d.doc.id, score: score / q.length });
    }
    hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return hits.slice(0, opts.limit ?? 10);
  }
}
