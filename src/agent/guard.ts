// Fixed lines, written by the server, not the agent. They work when the agent is what failed.
export const HOLDING_LINE = "One moment while I check that.";
export const SAFE_FALLBACK =
  "I'm sorry, I can't answer that here. I can log a request for a specialist to follow up if you'd like.";
/** Said instead of a blocked reply when an escalation exists: true and safe. */
export const ESCALATED_FALLBACK =
  "Your request is logged and a support representative will follow up. No callback time has been confirmed.";
export const ERROR_FALLBACK = "I'm sorry, something went wrong on our side. Your request has been logged for the support team.";
/**
 * Used when the failure was the database itself, so no ticket exists. Claiming the request was
 * logged would be false, and the same rule that stops the agent over-promising applies to the
 * server's own fallback line.
 */
export const ERROR_FALLBACK_UNLOGGED =
  "I'm sorry, something went wrong on our side and I can't complete this right now. Please try again, or use the support options in your RelayPay dashboard.";
/**
 * Appended to the spoken reply whenever the server has ended the conversation. A custom LLM cannot
 * hang up directly: Vapi ends the call when the assistant SAYS a phrase listed in the assistant's
 * `endCallPhrases`. Set that to exactly ["goodbye for now"] so this marker, and only this marker,
 * ends the call. Without it a closed conversation keeps a metered line open until Vapi's own cutoff.
 */
export const CALL_END_MARKER = "Goodbye for now.";

/**
 * Recovery, not surrender. When a reply cannot be spoken or the caller could not be understood, the
 * agent repeats the question it already asked rather than reaching for a specialist: on a phone line
 * a mishearing is ordinary, and handing the caller off for it wastes their time and ours. A human is
 * offered only after RECOVERY_LIMIT consecutive failures.
 */
export const RECOVERY_LIMIT = 3;

export function rephraseLine(lastQuestion: string | null): string {
  const opener = "Sorry, I didn't quite catch that.";
  return lastQuestion ? `${opener} ${lastQuestion}` : `${opener} Could you say that again?`;
}

/**
 * How many times the caller is asked to repeat themselves before a person is offered instead.
 * Two: a line that drops one word is worth a second go, and a caller asked three times has
 * learned that saying it again does not work.
 */
export const UNCLEAR_LIMIT = 2;

/** Code-owned lines for turns the model is never asked to handle. */
export const DIDNT_CATCH = "Sorry, I didn't catch that. Could you say that again?";
export const STILL_DIDNT_CATCH =
  "I'm still not getting that clearly. If it's easier, I can log a request for a specialist to call you back.";
export const STATE_YOUR_PROBLEM =
  "Thanks. So I can help, could you tell me what you need — a payment, an invoice, a payout or an account question?";
export const NO_PROGRESS_CLOSE =
  "It sounds like now isn't a good time. Do call back whenever you're ready, or use the support options in your RelayPay dashboard.";
/**
 * Said when the caller signals they are finished. CALL_END_MARKER is appended by the Vapi route,
 * so this line is what ends a call that went well — previously nothing did, and a resolved call
 * stayed open on a metered line until the caller hung up or Vapi timed it out.
 */
export const RESOLVED_CLOSE =
  "Thank you for your time and your patience. Glad I could help, and thanks for calling RelayPay.";
/** Spoken when the tool server is unreachable and the server has written the ticket itself. */
export const TOOLS_DOWN_FALLBACK =
  "I'm sorry, I can't reach our systems at the moment, so I can't look that up. I've logged this for the support team and someone will follow up.";
/** The off-topic redirect is the same sentence every time, so the model never authors it. */
export const OFF_TOPIC_LINE =
  "Sorry, this line is only for RelayPay support. I can help with a payment, invoice, payout or account question.";

export interface GuardRecords {
  escalationExists: boolean;
  ticketExists: boolean;
}

export interface GuardInput {
  reply: string;
  /** Everything the caller has said. Allows reading back an ID or email, and currency words only. */
  callerTexts: string[];
  /** Knowledge-base text and tool sentences from this turn: the only source of speakable figures. */
  groundedTexts: string[];
  /** Names from customer and payout records. Never speakable, even if the caller said them. */
  forbiddenNames: string[];
  /** Records that actually exist, so a claim can be checked against a fact rather than trusted. */
  records?: GuardRecords;
}

export interface GuardResult {
  ok: boolean;
  reasons: string[];
}

const MAX_REPLY_CHARS = 700;

// ---- normalisation ------------------------------------------------------------------------
// Everything is compared in one normalised form, so zero-width characters, fullwidth digits,
// spelled-out numbers and "at"/"dot" email dictation cannot hide text from the checks.

const NUMBER_WORDS: Record<string, string> = {
  zero: "0", oh: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7",
  eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12", thirteen: "13", fourteen: "14",
  fifteen: "15", sixteen: "16", seventeen: "17", eighteen: "18", nineteen: "19", twenty: "20",
  thirty: "30", forty: "40", fifty: "50", sixty: "60", seventy: "70", eighty: "80", ninety: "90",
  hundred: "100", thousand: "1000", million: "1000000",
};
const NUMBER_WORD_RE = new RegExp(`\\b(${Object.keys(NUMBER_WORDS).join("|")})\\b`, "g");

export function normalise(text: string): string {
  const flat = text
    .normalize("NFKC")
    .replace(/[­​-‏⁠﻿]/g, "")
    .toLowerCase()
    .replace(/\s+at\s+/g, "@")
    .replace(/\s+dot\s+/g, ".")
    .replace(NUMBER_WORD_RE, (w) => NUMBER_WORDS[w] ?? w)
    // Clause punctuation and apostrophes are kept: the negation rule needs clause boundaries,
    // and "I've booked" must stay recognisable as a commitment.
    .replace(/[^\p{L}\p{N}@._,;!?'-]+/gu, " ");
  // "txn nine zero zero one" arrives as "txn 9 0 0 1"; rejoin it so it matches "TXN-9001".
  // "nine am" likewise becomes "9 am", which must match a caller who typed "9am".
  return flat
    .replace(/\b(txn|pay|cus)[\s-]*((?:\d[\s-]*){4,8})/g, (_m, p, d) => `${p}-${String(d).replace(/[\s-]/g, "")}`)
    .replace(/\b(\d{1,2})\s+(am|pm)\b/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

const tokensOf = (norm: string): string[] =>
  norm
    .split(" ")
    .map((t) => (t.includes("@") ? t.replace(/[,;!?]+$/g, "") : t.replace(/^[.,;!?'-]+|[.,;!?'-]+$/g, "")))
    .filter(Boolean);

const wordRe = (word: string) => new RegExp(`(^|[^\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\p{L}\\p{N}]|$)`, "iu");

// ---- grounding ----------------------------------------------------------------------------

const ID_TOKEN = /\b(?:txn|pay|cus)-\d{4,8}\b/g;
const EMAIL_TOKEN = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/gu;

interface Allowed {
  words: Set<string>;
  bigrams: Set<string>;
}

function collect(texts: string[]): Allowed {
  const words = new Set<string>();
  const bigrams = new Set<string>();
  for (const text of texts) {
    const t = tokensOf(normalise(text));
    t.forEach((w, i) => {
      words.add(w);
      if (i > 0) bigrams.add(`${t[i - 1]} ${w}`);
    });
  }
  return { words, bigrams };
}

/**
 * A figure is speakable only when it is quoted in the phrasing it came from: the number itself
 * plus at least one neighbouring word must appear together in a grounded sentence. Pooling bare
 * tokens is not enough, because "2 to 5 business days" would otherwise licence "5 open invoices".
 */
function ungroundedNumbers(norm: string, allowed: Allowed, exempt: Set<string>, callerNumbers: Set<string>): boolean {
  for (const clause of norm.split(/[.!?,;]|\bbut\b|\band\b/)) {
    const tokens = tokensOf(clause.trim());
    // A figure the caller themselves said may be repeated inside a negated clause, which is how a
    // refusal is worded ("we cannot promise 9am"). Asserting the same figure stays blocked.
    const refusing = NEGATION.test(clause);
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (!/\d/.test(token) || token.includes("@") || exempt.has(token)) continue;
      if (refusing && callerNumbers.has(token)) continue;
      if (!allowed.words.has(token)) return true;
      const before = i > 0 ? `${tokens[i - 1]} ${token}` : null;
      const after = i < tokens.length - 1 ? `${token} ${tokens[i + 1]}` : null;
      if (!((before && allowed.bigrams.has(before)) || (after && allowed.bigrams.has(after)))) return true;
    }
  }
  return false;
}

// ---- what may never be said ---------------------------------------------------------------

const MARKUP = /[*#`~]|^\s*[-•]\s|\]\(|https?:\/\/|www\./m;
const CURRENCY_WORD = /\b(usd|eur|gbp|ngn|kes|zar|ghs|dollars?|euros?|pounds?|naira|cedis?|rand|shillings?|bucks|grand)\b/g;
const CURRENCY_SYMBOL = /[$£€₦]/;
const CUSTOMER_ID = /\bcus-?\d+\b|\bcus\b/;
const DOMAIN = /\b[\p{L}\p{N}-]+\.(?:com|org|net|io|co|ai)\b/giu;

const ACCOUNT_SUBJECT =
  /\b(accounts?|kyc|verification|business|company|profile|plans?|tiers?|balances?|documents?|notes?)\b/;
const STATE_WORD =
  /\b(active|inactive|restricted|unrestricted|suspended|pending|approved|declined|rejected|verified|unverified|locked|unlocked|blocked|frozen|flagged|limited|disabled|closed|hold|failed|good standing|under review|review required)\b/;
const PLAN_NAME = /\b(starter|growth|scale)\b/;
const COMPLIANCE_ACTION = /\bcompliance\b[^.]{0,30}\b(flag|flagged|review|reviewing|hold|held|block|blocked)\b/;
const ACCOUNT_NOTES = /\b(the|your|our|their)\s+(support\s+|internal\s+)?notes?\b/;
const STARTS_CONDITIONAL = /^\s*(if|when|whether|should|unless|in case)\b/i;

/** Claims about work done. Allowed only when a matching record actually exists. */
// Completed actions only. Offering to act ("I can log a request for a specialist to follow up")
// is not a claim, so the past forms are matched and the bare verbs are not.
const RECORD_CLAIM =
  // "reference number" and "case number" are deliberately absent: asking the caller for theirs is
  // the most important question in the whole flow, and it tripped on every real call. An invented
  // reference carries digits, which the grounding rule already blocks.
  /\b(logged|escalated)\b|\b(created|raised|opened)\s+(a|an|your|the)\s+(ticket|case|request|escalation)\b|\brepresentative will follow up\b/;

/** Commitments that are never allowed, whatever records exist. */
const COMMITMENTS: RegExp[] = [
  // Commitments made TO the caller only. A bare "will be" would swallow accurate product
  // descriptions such as "RelayPay will show you the fees before you confirm".
  /(\b(will|gonna|going to|shall)|'ll)\s+(\w+\s+){0,2}(call you|contact you|reach out|email you|arrive|land|sorted|get back to you|be (credited|processed|resolved|sorted|completed|with you|there|done))\b/,
  /\b(i|we)('ve|'ll|\s+(have|will|am|are))?\s*(just\s+)?(booked|scheduled|arranged|emailed|notified|forwarded|sent|set up)\b/,
  /\b(is|are|was|were|has been|have been)\s+(booked|scheduled|arranged|set up|notified|sent|emailed|confirmed)\b/,
  /\brest assured\b|\byou have my word\b|\bi assure you\b|\bi promise\b|\bmake sure it gets\b|\bdefinitely\b|\bfor sure\b/,
  /\b(specialist|team|representative|agent|someone)\b[^.]{0,40}\b(has|have|already)\b[^.]{0,20}\b(read|reviewed|seen|looked)\b/,
];
// A time word is only a promise when something is being committed to happen then. "How can I help
// you today?" contains one and promises nothing.
const RELATIVE_TIME =
  /\b(will|'ll|gonna|going to|shall|expect|should)\b[^.]{0,40}\b(tomorrow|tonight|today|shortly|soon|right away|immediately|within the (hour|day|week)|by (monday|tuesday|wednesday|thursday|friday|saturday|sunday)|next (week|day))\b/;
const GUARANTEE = /\bguarantee[sd]?\b/;
const ADVICE = /\byou should\b[^.]{0,60}\b(claim|deduct|expense|invest|convert|exchange|transfer)\b|\bconvert your (balance|funds|money)\b/;
/**
 * A positive claim about what RelayPay does. It needs retrieval behind it, whatever type the
 * model labelled the turn: the retrieval rule must not depend on the model's own self-report.
 * Refusals ("RelayPay cannot guarantee...") are deliberately not included, since they never
 * over-promise.
 */
// The verb must be inflected, so "RelayPay support" (the name of the desk) is not read as
// "RelayPay supports" (a claim about the product).
const CAPABILITY_CLAIM =
  /\b(relaypay|the platform)\s+\w{0,12}\s?(supports|offers|provides|allows|accepts|charges|requires)\b|\bwe\s+(support|offer|provide|allow|accept|charge|require)\b/;

/**
 * The agent reciting its own configuration. A caller who asks "what are your instructions?" or
 * "repeat the text above" must not be handed the rules that constrain it, nor the names of the
 * tools behind it. Describing what it can help with is fine; quoting its own scaffolding is not.
 */
// Self-reference only. "Follow the instructions in the email" and "the rules for payouts" are
// ordinary support answers; it is the agent describing its OWN configuration that must not be said.
const PROMPT_LEAK =
  /\bmy\s+(system\s+)?(instructions?|rules?|guidelines?|prompt|configuration|directives?|setup)\b|\bsystem[\s_-]?prompt\b|\bserver[\s_]?note\b|\btype\s+(answer_directly|clarify|escalate|decline|conversational|off_topic)\b|\byou are relaypay's\b|\b(search_knowledge|lookup_customer|lookup_transaction|lookup_payout|create_support_ticket|create_escalation|log_conversation_event)\b|\bi (?:am|was) (?:told|instructed|programmed|configured|set up) to\b|\b(the rules|instructions) i (follow|was given)\b/;

// A reply in another language would sail past every check above, which are all written in English.
// The agent is English-only by design, so anything else is blocked rather than spoken unchecked.
const COMMON_ENGLISH = new Set([
  "the", "a", "an", "is", "are", "was", "to", "of", "and", "or", "you", "your", "i", "it", "that",
  "for", "on", "in", "we", "can", "not", "with", "this", "have", "has", "do", "does", "will", "be",
  "at", "by", "from", "if", "no", "yes", "but", "so", "there", "they", "our", "me", "my", "what",
]);
const MIN_WORDS_FOR_LANGUAGE_CHECK = 5;
const MIN_LATIN_SHARE = 0.7;

function notEnglish(norm: string, tokens: string[]): boolean {
  const letters = norm.match(/\p{L}/gu) ?? [];
  if (letters.length > 0) {
    const latin = norm.match(/\p{Script=Latin}/gu) ?? [];
    if (latin.length / letters.length < MIN_LATIN_SHARE) return true;
  }
  // Too short to judge: a two-word reply has no room for a function word.
  if (tokens.length < MIN_WORDS_FOR_LANGUAGE_CHECK) return false;
  // Contractions carry the function word before the apostrophe ("can't" -> "can", "I'm" -> "i").
  const parts = tokens.flatMap((t) => t.split("'"));
  return !parts.some((t) => COMMON_ENGLISH.has(t));
}

const NEGATION = /(\bnot\b|n't\b|\bcannot\b|\bcan not\b|\bunable\b|\bno\b|\bnever\b|\bwithout\b|\bnor\b)/;

/**
 * A negation only excuses a commitment inside its own clause. "No problem, I've booked a
 * callback" is two clauses, and the promise in the second is not excused by the first.
 */
function unnegatedMatch(norm: string, pattern: RegExp): boolean {
  return norm
    .split(/[.!?,;]|\bbut\b|\band\b/)
    .some((clause) => {
      const m = clause.match(pattern);
      if (!m) return false;
      return !NEGATION.test(clause.slice(0, m.index ?? 0));
    });
}

function disclosesAccountState(norm: string): boolean {
  if (COMPLIANCE_ACTION.test(norm) || ACCOUNT_NOTES.test(norm) || PLAN_NAME.test(norm)) return true;
  return norm
    .split(/(?<=[.!?])\s+/)
    .some((s) => !STARTS_CONDITIONAL.test(s) && ACCOUNT_SUBJECT.test(s) && STATE_WORD.test(s));
}

// ---- the guard ----------------------------------------------------------------------------

/**
 * The last line of defence, in code, on every reply before it is spoken. It runs on the final
 * text, so a model that ignores its instructions is still stopped. Two principles: a figure is
 * speakable only if quoted from a grounded sentence, and a claim about work done is speakable
 * only if the record exists. The caller's own words licence a read-back, never a statement.
 */
export function checkReply(input: GuardInput): GuardResult {
  const raw = input.reply.trim();
  if (raw.length === 0) return { ok: false, reasons: ["empty"] };

  const reasons = new Set<string>();
  const norm = normalise(raw);
  const replyTokens = tokensOf(norm);
  const callerNorm = input.callerTexts.map(normalise).join(" \n ");
  const grounded = collect(input.groundedTexts);

  // The caller's words licence only a read-back of an ID or an email they gave, plus currency words.
  const callerIds = [...callerNorm.matchAll(ID_TOKEN)].map((m) => m[0]);
  const callerEmails = [...callerNorm.matchAll(EMAIL_TOKEN)].map((m) => m[0]);
  // A reference the caller supplied may be read back on its own, without a grounded phrasing.
  const exempt = new Set([...callerIds, ...callerEmails]);

  if (raw.length > MAX_REPLY_CHARS) reasons.add("too_long");
  if (MARKUP.test(raw)) reasons.add("markup");

  const callerNumbers = new Set(tokensOf(callerNorm).filter((t) => /\d/.test(t)));
  if (ungroundedNumbers(norm, grounded, exempt, callerNumbers)) reasons.add("ungrounded_number");
  if (CURRENCY_SYMBOL.test(raw)) reasons.add("currency");
  for (const m of norm.matchAll(CURRENCY_WORD)) {
    if (!wordRe(m[0]).test(callerNorm) && !grounded.words.has(m[0])) reasons.add("currency");
  }
  if (CUSTOMER_ID.test(norm)) reasons.add("customer_id");

  for (const m of norm.matchAll(EMAIL_TOKEN)) {
    if (!callerEmails.includes(m[0])) reasons.add("email");
  }
  for (const m of norm.matchAll(DOMAIN)) {
    if (!callerNorm.includes(m[0]) && !grounded.words.has(m[0])) reasons.add("contact_detail");
  }

  // A record name is never spoken, even when the caller said it first: confirming it is disclosure.
  for (const name of input.forbiddenNames) {
    for (const part of normalise(name).split(" ")) {
      if (part.length >= 4 && wordRe(part).test(norm)) reasons.add("record_name");
    }
  }

  if (disclosesAccountState(norm)) reasons.add("record_field");

  const backed = input.records?.escalationExists === true || input.records?.ticketExists === true;
  if (!backed && unnegatedMatch(norm, RECORD_CLAIM)) reasons.add("unbacked_claim");
  if (COMMITMENTS.some((p) => unnegatedMatch(norm, p))) reasons.add("promise");
  if (unnegatedMatch(norm, RELATIVE_TIME)) reasons.add("promise");
  if (unnegatedMatch(norm, GUARANTEE)) reasons.add("promise");
  if (ADVICE.test(norm)) reasons.add("advice");
  if (input.groundedTexts.length === 0 && CAPABILITY_CLAIM.test(norm)) reasons.add("ungrounded_claim");
  if (PROMPT_LEAK.test(norm)) reasons.add("prompt_leak");
  if (notEnglish(norm, replyTokens)) reasons.add("not_english");

  return { ok: reasons.size === 0, reasons: [...reasons] };
}
