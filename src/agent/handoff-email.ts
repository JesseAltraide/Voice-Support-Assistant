/**
 * Delivery of the handoff brief to the support inbox.
 *
 * It is a sweep rather than a send inside create_escalation, because the caller is on a live
 * line. An SMTP handshake can take seconds or hang, and nothing on the speaking path may wait
 * for a mail server: the escalation is recorded first and the brief goes out behind it. The
 * schema was built for this — attempts, claimed_at, sent_at and error already exist — so a
 * crash mid-send is recoverable and a failure is visible rather than silent.
 */

import { createTransport, type Transporter } from "nodemailer";
import { getDb } from "../shared/db.js";
import { isTransient } from "../shared/retry.js";

/** Stop retrying after this many tries; a permanently bad address must not be swept forever. */
const MAX_ATTEMPTS = 5;
/** A row claimed longer ago than this was abandoned by a process that died mid-send. */
const CLAIM_STALE_MS = 10 * 60_000;
/** Bounded so one sweep cannot run long enough to overlap the next. */
const BATCH = 10;
/** First wait after a failure; each subsequent attempt doubles it. */
const BACKOFF_BASE_MS = 2 * 60_000;
/** Ceiling on a single wait, so a long outage is still retried at a sensible rate. */
const BACKOFF_CAP_MS = 30 * 60_000;

/**
 * How long to wait before trying a failed row again.
 *
 * Without this the sweep retried every 60 seconds and spent all five attempts in five minutes,
 * so any mail outage longer than that — a provider restarting, a rate limit, a DNS blip —
 * permanently parked the escalation at "failed" while the caller had been told a representative
 * would follow up. Doubling from two minutes spreads the same five attempts across roughly half
 * an hour, which covers the outages a mail provider actually has.
 */
export function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_CAP_MS);
}

export interface HandoffEmail {
  to: string;
  subject: string;
  text: string;
}

export interface DispatchResult {
  sent: number;
  failed: number;
  /** Why nothing was attempted, when that is the answer. */
  skipped?: string;
}

export interface EscalationRow {
  id: string;
  conversation_id: string;
  user_name: string;
  user_email: string;
  category: string;
  reason: string;
  handoff_summary: string | null;
  handoff_email_status: string;
  handoff_email_attempts: number;
  /** Part of the claim condition, so reclaiming a stale row is exclusive too. Null until claimed. */
  handoff_email_claimed_at?: string | null;
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  auth: { user: string; pass: string };
  inbox: string;
  from: string;
}

/**
 * Returns the configuration, or the reason there is none.
 *
 * The inbox is validated rather than merely present. A brief carries the caller's name, their
 * email and a transcript of what they said about their account, so a typo in the environment
 * would send all of that to whoever owns the address that was actually typed — quietly, every
 * minute, with the record claiming it was sent. The same check already guards the caller's own
 * address before an escalation is created; the address that receives the whole conversation
 * deserves it more, not less.
 */
/**
 * Whether a row should be attempted now.
 *
 * Expressed in code rather than in the query because the wait depends on the row's own attempt
 * count, which SQL filters cannot express without another column. The batch is small, so the
 * cost is a few rows read and skipped.
 */
export function isDue(row: Pick<EscalationRow, "handoff_email_status" | "handoff_email_attempts" | "handoff_email_claimed_at">, now: number): boolean {
  const claimedAt = row.handoff_email_claimed_at ? Date.parse(row.handoff_email_claimed_at) : null;

  // Never claimed: nothing has been tried, so it is due regardless of status. A "sending" row
  // with no claim timestamp should not be stranded either.
  if (claimedAt === null || Number.isNaN(claimedAt)) return true;

  // Still in flight somewhere until the claim goes stale, at which point it is recoverable.
  if (row.handoff_email_status === "sending") return now - claimedAt >= CLAIM_STALE_MS;

  return now - claimedAt >= backoffMs(row.handoff_email_attempts);
}

function smtpConfig(): { cfg: SmtpConfig } | { reason: string } {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_APP_PASSWORD, SUPPORT_INBOX_EMAIL } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_APP_PASSWORD || !SUPPORT_INBOX_EMAIL) {
    return { reason: "SMTP is not configured" };
  }
  const inbox = SUPPORT_INBOX_EMAIL.trim();
  if (!EMAIL.test(inbox)) {
    // Fails closed: nothing is sent and nothing is claimed until the address is corrected.
    return { reason: "SUPPORT_INBOX_EMAIL is not a valid email address" };
  }
  const port = Number(SMTP_PORT ?? 587);
  return {
    cfg: {
      host: SMTP_HOST,
      port,
      // 465 is implicit TLS; 587 upgrades with STARTTLS. Getting this wrong hangs the connection.
      secure: port === 465,
      auth: { user: SMTP_USER, pass: SMTP_APP_PASSWORD },
      inbox,
      from: SMTP_USER,
    },
  };
}

let transporter: Transporter | null = null;

async function sendOverSmtp(mail: HandoffEmail): Promise<void> {
  const config = smtpConfig();
  if ("reason" in config) throw new Error(config.reason);
  const cfg = config.cfg;
  transporter ??= createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.auth,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  await transporter.sendMail({ from: cfg.from, to: mail.to, subject: mail.subject, text: mail.text });
}

/**
 * The message a support agent opens. Everything in it comes from the escalation record, so it
 * cannot describe the call differently from the way the call was logged.
 */
export function composeHandoffEmail(row: EscalationRow, inbox: string): HandoffEmail {
  const subject = `[RelayPay support] ${row.category} escalation from ${row.user_name}`;
  const text = [
    "A caller asked to be handed to support.",
    "",
    `Name:     ${row.user_name}`,
    `Email:    ${row.user_email}`,
    `Category: ${row.category}`,
    `Reason:   ${row.reason}`,
    "",
    row.handoff_summary ?? "No handoff brief was recorded for this escalation.",
    "",
    `Conversation id: ${row.conversation_id}`,
    `Escalation id:   ${row.id}`,
    "",
    "Reply to the caller at the address above. This message was generated from saved records;",
    "nobody has contacted the caller yet.",
  ].join("\n");
  return { to: inbox, subject, text };
}

/**
 * Send whatever is waiting. Safe to call on a timer and safe to run twice at once: a row is
 * claimed with a conditional update, so only the process that wins the claim sends it.
 *
 * @param send injected so tests can exercise delivery without an SMTP server.
 */
export async function dispatchHandoffEmails(
  send: (mail: HandoffEmail) => Promise<void> = sendOverSmtp,
): Promise<DispatchResult> {
  const config = smtpConfig();
  // Nothing is claimed when there is nowhere safe to send: the rows stay pending and are picked
  // up once the configuration is right, rather than burning attempts against a missing mail
  // server or delivering a caller's conversation to a mistyped address.
  if ("reason" in config) return { sent: 0, failed: 0, skipped: config.reason };
  const cfg = config.cfg;

  const db = getDb();
  const now = Date.now();
  // Waiting rows are read and skipped rather than filtered in SQL: how long each must wait
  // depends on its own attempt count. A slightly wider read keeps the policy in one readable
  // place, at the cost of a few rows per sweep.
  const { data, error } = await db
    .from("escalations")
    .select("id,conversation_id,user_name,user_email,category,reason,handoff_summary,handoff_email_status,handoff_email_attempts,handoff_email_claimed_at")
    .in("handoff_email_status", ["pending", "failed", "sending"])
    .lt("handoff_email_attempts", MAX_ATTEMPTS)
    .order("created_at", { ascending: true })
    // Read wider than the batch and cap after filtering: the limit applies before the due
    // check, so a handful of rows still waiting out their backoff must not crowd out a newer
    // one that is ready to send.
    .limit(BATCH * 3);
  if (error) throw new Error(error.message);

  const rows = ((data ?? []) as EscalationRow[]).filter((row) => isDue(row, now)).slice(0, BATCH);
  let sent = 0;
  let failed = 0;

  for (const row of rows) {
    // Conditional on the exact row we read, so a second sweep running concurrently loses the
    // race and skips the row instead of sending the brief twice.
    //
    // The claim timestamp is part of the condition, not just the status. Status alone is
    // exclusive for pending -> sending and failed -> sending, where the value changes and the
    // loser stops matching; it is NOT exclusive when a stale "sending" row is reclaimed as
    // "sending", which is the one path this reclaim exists for.
    const pending = db
      .from("escalations")
      .update({
        handoff_email_status: "sending",
        handoff_email_claimed_at: new Date().toISOString(),
        handoff_email_attempts: row.handoff_email_attempts + 1,
      })
      .eq("id", row.id)
      .eq("handoff_email_status", row.handoff_email_status);
    // A never-claimed row has a null timestamp, and null does not compare equal to anything,
    // so it needs `is` rather than `eq`.
    const claim = await (row.handoff_email_claimed_at
      ? pending.eq("handoff_email_claimed_at", row.handoff_email_claimed_at)
      : pending.is("handoff_email_claimed_at", null)
    ).select("id");
    if (claim.error || (claim.data ?? []).length === 0) continue;

    try {
      await send(composeHandoffEmail(row, cfg.inbox));
      await db
        .from("escalations")
        .update({ handoff_email_status: "sent", handoff_email_sent_at: new Date().toISOString(), handoff_email_error: null })
        .eq("id", row.id);
      sent += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const attempts = row.handoff_email_attempts + 1;
      // A transient fault is worth another sweep; a rejected address is not. Both land in
      // "failed" — the attempt count decides whether it is tried again, and burning the
      // remaining attempts is how a permanent failure stops being retried forever.
      const retryable = isTransient(err) && attempts < MAX_ATTEMPTS;
      await db
        .from("escalations")
        .update({
          handoff_email_status: "failed",
          handoff_email_error: message.slice(0, 500),
          ...(retryable ? {} : { handoff_email_attempts: MAX_ATTEMPTS }),
        })
        .eq("id", row.id);
      failed += 1;
      console.error(`handoff email failed for escalation ${row.id}:`, message);
    }
  }

  return { sent, failed };
}
