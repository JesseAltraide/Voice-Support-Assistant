import { afterEach, describe, expect, test } from "vitest";
import { composeHandoffEmail, dispatchHandoffEmails, type EscalationRow } from "./handoff-email.js";

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
