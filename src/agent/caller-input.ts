/**
 * What the caller's words are, before any model call. Speech-to-text on a phone line produces
 * plenty that is not speech — background noise, a cough, the assistant's own voice echoing back —
 * and running a full turn on it costs money and adds silence. Judged here, in code, for free.
 */

export type InputKind = "empty" | "noise" | "ok";

const FILLER = new Set(["uh", "um", "umm", "mm", "mmm", "hmm", "hm", "ah", "ahh", "er", "erm", "eh", "oh", "uhh"]);
// Words too common to signal that two questions are the same.
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "so", "then", "is", "are", "was", "were", "do", "does", "did",
  "what", "when", "why", "how", "who", "which", "you", "your", "i", "my", "me", "we", "our", "it", "its",
  "to", "for", "of", "in", "on", "at", "by", "with", "from", "that", "this", "there", "can", "could",
  "would", "will", "please", "just", "about", "any", "some",
]);

const normalise = (text: string): string =>
  text.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, " ").replace(/\s+/g, " ").trim();

const words = (text: string): string[] => normalise(text).split(" ").filter(Boolean);

export function classifyInput(text: string): { kind: InputKind } {
  if (text.trim().length === 0) return { kind: "empty" };
  const w = words(text);
  if (w.length === 0) return { kind: "noise" };

  // Every word is a filler sound, so nothing was actually said.
  if (w.every((word) => FILLER.has(word) || /^(m+|a+h*|u+h*|e+r*m*)$/.test(word))) return { kind: "noise" };
  // A single character carries no meaning, but a short real word ("hi", "no", "Jo") does.
  if (w.length === 1 && w[0]!.length === 1 && !/\d/.test(w[0]!)) return { kind: "noise" };
  return { kind: "ok" };
}

// Confirmations, greetings and sign-offs repeat constantly and ask nothing. Repeated greetings are
// handled separately by the no-progress limit, not treated as an unanswered question.
const NON_QUESTION = new Set([
  "yes", "yeah", "yep", "yup", "no", "nope", "ok", "okay", "sure", "right", "correct", "thanks",
  "thank", "cheers", "hi", "hello", "hey", "bye", "goodbye", "morning", "afternoon", "evening",
]);
const MIN_CONTENT_WORDS = 1;
const SIMILARITY = 0.6;

/**
 * Whether the caller is asking something they have already asked. Repeating a question means the
 * previous answer did not land, which is dissatisfaction even when every answer was technically
 * correct, so it is a signal to offer a human. Compared on content words only, so rephrasing and
 * filler do not hide it.
 */
const contentWords = (text: string): Set<string> =>
  new Set(words(text).filter((w) => !STOPWORDS.has(w) && !NON_QUESTION.has(w)));

export function isRepeatQuestion(text: string, priorTexts: string[]): boolean {
  const current = contentWords(text);
  if (current.size < MIN_CONTENT_WORDS) return false;

  return priorTexts.some((prior) => {
    const other = contentWords(prior);
    if (other.size < MIN_CONTENT_WORDS) return false;
    let shared = 0;
    for (const w of current) if (other.has(w)) shared += 1;
    // Jaccard: shared terms against the combined vocabulary of both questions.
    return shared / (current.size + other.size - shared) >= SIMILARITY;
  });
}
