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

/**
 * Apostrophes are dropped rather than turned into spaces, so "that's" reads as one word, "thats".
 * The shared `normalise` above replaces them with a space, which would split every contraction
 * the patterns below depend on.
 */
const normaliseClosing = (text: string): string =>
  text
    .toLowerCase()
    .replace(/['‘’`]/g, "")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Sign-offs that mean the call is over whatever was asked before them. */
const FAREWELL = /\b(goodbye|good bye|bye|have a (good|nice|lovely) (day|one|evening|afternoon)|we?re (all )?done|im (all )?done|that will be all|thatll be all)\b/;

/** "We are finished" — but only when the caller is not still answering a question. */
const NOTHING_FURTHER = /\b(thats (all|it|everything)|nothing (else|further|more)|not anything else)\b/;

/**
 * The same words appear when the caller is supplying information — "that's all I know", "that's
 * all the detail I have" — and ending the call on those would cut them off mid-answer.
 */
const STILL_ANSWERING = /\b(i|we) (know|knew|remember|have|had|got|can|could|think|believe|recall|said)\b/;

/** Only a closing in reply to a wrap-up question; otherwise "no" is an answer, not a sign-off. */
const BARE_ACK = /^(no|nope|nah|no thanks|no thank you|all good|im good|im all set|thats fine|were fine)$/;

const WRAP_UP_QUESTION = /\b(anything|something) else\b|help you with anything|anything further/;

/** A sign-off is short. A long sentence containing "that's all" is usually still making a point. */
const MAX_CLOSING_WORDS = 10;

/**
 * Whether the caller has said the conversation is over.
 *
 * Deliberately conservative: ending a call that was not finished is far worse than leaving one
 * running a few seconds longer, so an ambiguous utterance is left to the model. `lastAssistant`
 * supplies the context that makes a bare "no" readable — it closes the call after "anything else?"
 * and means nothing after "is that the right transaction?".
 */
export function isClosing(text: string, lastAssistant?: string | null): boolean {
  const t = normaliseClosing(text);
  if (!t) return false;
  // A question is the opposite of a sign-off, whatever else it contains.
  if (text.includes("?")) return false;
  if (t.split(" ").length > MAX_CLOSING_WORDS) return false;

  if (FAREWELL.test(t)) return true;
  if (NOTHING_FURTHER.test(t) && !STILL_ANSWERING.test(t)) return true;
  const afterWrapUp = !!lastAssistant && WRAP_UP_QUESTION.test(normaliseClosing(lastAssistant));
  if (BARE_ACK.test(t) && afterWrapUp) return true;
  // A caller who just says thanks, with nothing else, right after being asked if there's
  // anything further, is signing off — "All right. Thank you very much." never matched FAREWELL
  // (no "bye" or "done") and left the call open with no marker to end it. Only counts when every
  // word in the utterance is plain gratitude or filler; the moment a real word slips in
  // ("thanks, but can you also check...") this is not a sign-off and must not be read as one.
  return afterWrapUp && t.split(" ").every((w) => CLOSING_FILLER.has(w));
}

const CLOSING_FILLER = new Set([
  "all", "right", "alright", "ok", "okay", "great", "good", "thanks", "thank", "you", "very",
  "much", "so", "a", "lot", "appreciate", "it", "cheers",
]);

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

const PLAIN_ANSWER_START = /^(yes|yeah|yep|yup|sure|ok|okay|no|nope|nah)\b/;
const MAX_PLAIN_ANSWER_WORDS = 8;

/**
 * Whether the caller just said yes or no, perhaps with a few words after it. That is always an
 * answer to something, never noise, so a model verdict of "unintelligible" on it is a fault in the
 * model's picture of the conversation, not in the audio.
 */
export function isPlainAnswer(text: string): boolean {
  const t = normaliseClosing(text);
  return t.length > 0 && t.split(" ").length <= MAX_PLAIN_ANSWER_WORDS && PLAIN_ANSWER_START.test(t);
}
