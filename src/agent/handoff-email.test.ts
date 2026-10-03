import { afterEach, describe, expect, test } from "vitest";
import {
  backoffMs, composeHandoffEmail, CONFIRM_GRACE_MS, dispatchHandoffEmails, isDue, type EscalationRow,
} from "./handoff-email.js";

const MINUTE = 60_000;

const ROW: EscalationRow = {
  id: "esc-1",
  conversation_id: "conv-1",
  user_name: "Ada Example",
  user_email: "ada@example.com",
  category: "account",
  reason: "Account restricted and the caller could not be helped by voice.",
  handoff_summary: "Handoff brief (built from saved records)\nCase reference: TXN-9001",
  handoff_email_status: "pending",
  handoff_email_attempts: 0,
};

describe("the message support receives", () => {
  const mail = composeHandoffEmail(ROW, "support@relaypay.example");

  test("goes to the configured inbox, not to the caller", () => {
    // Mailing the caller instead of support would hand them an internal brief.
    expect(mail.to).toBe("support@relaypay.example");
    expect(mail.to).not.toBe(ROW.user_email);
  });

  test("the subject identifies the caller and the category at a glance", () => {
    expect(mail.subject).toContain("Ada Example");
    expect(mail.subject).toContain("account");
  });

  test("carries the details needed to act, including the brief", () => {
    expect(mail.text).toContain("ada@example.com");
    expect(mail.text).toContain("Account restricted");
    expect(mail.text).toContain("Case reference: TXN-9001");
    expect(mail.text).toContain("conv-1");
    expect(mail.text).toContain("esc-1");
  });

  test("does not claim anyone has contacted the caller", () => {
    // The agent is forbidden from promising a callback; the email must not promise one either.
    expect(mail.text).toMatch(/nobody has contacted the caller yet/i);
    expect(mail.text).not.toMatch(/\b(we have (called|contacted|emailed)|callback (is )?(booked|scheduled))\b/i);
  });

  test("says so plainly when no brief was recorded, rather than sending a gap", () => {
    const mailWithout = composeHandoffEmail({ ...ROW, handoff_summary: null }, "support@relaypay.example");
    expect(mailWithout.text).toContain("No handoff brief was recorded");
  });
});

// M13: without backoff the sweep spent all five attempts in five minutes, so any mail outage
// longer than that parked the escalation at "failed" for good.
describe("retry pacing", () => {
  test("each failure waits longer than the last", () => {
    expect(backoffMs(1)).toBe(2 * MINUTE);
    expect(backoffMs(2)).toBe(4 * MINUTE);
    expect(backoffMs(3)).toBe(8 * MINUTE);
    expect(backoffMs(4)).toBe(16 * MINUTE);
  });

  test("a single wait is capped, so a long outage is still retried at a sensible rate", () => {
    expect(backoffMs(10)).toBe(30 * MINUTE);
    expect(backoffMs(99)).toBe(30 * MINUTE);
  });

  test("five attempts span half an hour, not five minutes", () => {
    const total = [1, 2, 3, 4].reduce((sum, n) => sum + backoffMs(n), 0);
    expect(total).toBeGreaterThanOrEqual(30 * MINUTE);
  });

  const at = (status: string, attempts: number, claimedMinutesAgo: number | null) => ({
    handoff_email_status: status,
    handoff_email_attempts: attempts,
    handoff_email_claimed_at: claimedMinutesAgo === null ? null : new Date(Date.now() - claimedMinutesAgo * MINUTE).toISOString(),
  });

  test("a never-claimed row is due immediately", () => {
    expect(isDue(at("pending", 0, null), Date.now())).toBe(true);
  });

  // The caller no longer confirms their details on a form: the agent reads them back aloud, so a
  // handoff is due as soon as it exists.
  describe("no waiting for the caller to confirm their details", () => {
    const made = (minutesAgo: number) => ({
      handoff_email_status: "pending",
      handoff_email_attempts: 0,
      handoff_email_claimed_at: null,
      created_at: new Date(Date.now() - minutesAgo * MINUTE).toISOString(),
      contact_confirmed_at: null,
    });

    test("an unconfirmed escalation is due at once", () => {
      expect(isDue(made(0), Date.now())).toBe(true);
    });

    test("a row with no creation time is sent rather than stranded", () => {
      expect(isDue({ ...made(1), created_at: null }, Date.now())).toBe(true);
    });

    test("there is no grace period", () => {
      expect(CONFIRM_GRACE_MS).toBe(0);
    });
  });

  test("a failed row waits out its backoff, then becomes due", () => {
    expect(isDue(at("failed", 1, 1), Date.now())).toBe(false);
    expect(isDue(at("failed", 1, 3), Date.now())).toBe(true);
    expect(isDue(at("failed", 3, 5), Date.now())).toBe(false);
    expect(isDue(at("failed", 3, 9), Date.now())).toBe(true);
  });

  test("a send in flight is left alone until its claim goes stale", () => {
    expect(isDue(at("sending", 1, 2), Date.now())).toBe(false);
    expect(isDue(at("sending", 1, 11), Date.now())).toBe(true);
  });

  test("a sending row with no claim timestamp is recoverable rather than stranded", () => {
    // Only reachable by editing rows by hand, but being stuck forever is the worse outcome.
    expect(isDue(at("sending", 1, null), Date.now())).toBe(true);
  });

  test("an unparseable timestamp is treated as due rather than blocking delivery", () => {
    const row = { handoff_email_status: "failed", handoff_email_attempts: 1, handoff_email_claimed_at: "not a date" };
    expect(isDue(row, Date.now())).toBe(true);
  });
});

describe("when SMTP is not configured", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  test("nothing is attempted and the reason is reported", async () => {
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_APP_PASSWORD;
    delete process.env.SUPPORT_INBOX_EMAIL;

    let called = false;
    const result = await dispatchHandoffEmails(async () => {
      called = true;
    });

    // Rows must stay pending rather than burning attempts against a mail server that is absent.
    expect(result).toEqual({ sent: 0, failed: 0, skipped: "SMTP is not configured" });
    expect(called).toBe(false);
  });

  // The brief holds the caller's name, address and what they said about their account. A typo
  // in the environment would hand all of it to whoever owns the address that was typed.
  test.each(["support@", "@relaypay.example", "support at relaypay dot example", "support@localhost", " "])(
    "a malformed inbox %j sends nothing at all",
    async (inbox) => {
      process.env.SMTP_HOST = "smtp.example.com";
      process.env.SMTP_USER = "agent@example.com";
      process.env.SMTP_APP_PASSWORD = "app-password";
      process.env.SUPPORT_INBOX_EMAIL = inbox;

      let called = false;
      const result = await dispatchHandoffEmails(async () => {
        called = true;
      });

      expect(called).toBe(false);
      expect(result.sent).toBe(0);
      expect(result.skipped).toMatch(/SUPPORT_INBOX_EMAIL|not configured/);
    },
  );

  test("a valid inbox is accepted, surrounding whitespace and all", async () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.SMTP_USER = "agent@example.com";
    process.env.SMTP_APP_PASSWORD = "app-password";
    process.env.SUPPORT_INBOX_EMAIL = "  support@relaypay.example  ";

    // Reaching the database means the configuration was accepted; the skip reason is what matters.
    const result = await dispatchHandoffEmails(async () => undefined).catch(() => ({ skipped: undefined }));
    expect(result.skipped).toBeUndefined();
  });
});

// Support asked for a way to click straight into the call's transcript from the handoff email.
describe("the transcript link", () => {
  afterEach(() => {
    delete process.env.AGENT_SERVER_URL;
  });

  test("names the conversation even with no public URL configured", () => {
    const mail = composeHandoffEmail(ROW, "support@relaypay.example");
    expect(mail.text).toContain("conv-1");
  });

  test("without a configured public URL, there is no bare link to click", () => {
    // A link to nowhere is worse than no link: it reads as broken rather than as "look it up".
    const mail = composeHandoffEmail(ROW, "support@relaypay.example");
    expect(mail.text).not.toMatch(/https?:\/\//);
  });
});
