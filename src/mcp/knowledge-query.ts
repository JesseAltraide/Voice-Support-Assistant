const STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "your", "can", "does", "did", "how", "what",
  "when", "why", "who", "which", "with", "this", "that", "these", "those", "there", "their",
  "have", "has", "had", "was", "were", "will", "would", "could", "should", "from", "into",
  "about", "any", "all", "our", "out", "its", "get", "got", "may", "much", "many",
  // "RelayPay" is in nearly every chunk, so it adds noise and no signal.
  "relaypay",
]);

const MAX_TERMS = 12;

/**
 * Turn the agent's search text into a Postgres OR tsquery. Only [a-z0-9] tokens survive,
 * so a caller's words can never inject tsquery operators. Null means nothing searchable.
 */
export function buildOrQuery(text: string): string | null {
  const seen = new Set<string>();
  for (const token of text.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ")) {
    if (token.length > 2 && !STOPWORDS.has(token)) seen.add(token);
    if (seen.size >= MAX_TERMS) break;
  }
  return seen.size > 0 ? [...seen].join(" | ") : null;
}

const RELATIVE_FLOOR = 0.25;

/**
 * Full-text scores are only comparable within one search. Keep results within a
 * fraction of the best one, so noise does not satisfy the grounding gate but a lone
 * weak true match (the crypto entry scores 0.03) still counts.
 */
export function keepRelevant<T extends { score: number }>(rows: T[]): T[] {
  if (rows.length === 0) return [];
  const top = Math.max(...rows.map((r) => r.score));
  return rows.filter((r) => r.score >= top * RELATIVE_FLOOR);
}
