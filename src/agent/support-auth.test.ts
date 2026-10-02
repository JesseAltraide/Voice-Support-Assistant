import { describe, expect, it } from "vitest";
import {
  hashPassword,
  hashToken,
  newSessionToken,
  SESSION_HOURS,
  sessionCookie,
  sessionExpiry,
  verifyPassword,
} from "./support-auth.js";

describe("passwords", () => {
  it("the right password is accepted and the wrong one is not", async () => {
    const stored = await hashPassword("relaypay");
    expect(await verifyPassword("relaypay", stored)).toBe(true);
    expect(await verifyPassword("relaypa", stored)).toBe(false);
    expect(await verifyPassword("Relaypay", stored)).toBe(false);
    expect(await verifyPassword("", stored)).toBe(false);
  });

  it("the password itself is nowhere in what gets stored", async () => {
    // The whole point of hashing. A stored value that contains the password is a stored password.
    const stored = await hashPassword("relaypay");
    expect(stored).not.toContain("relaypay");
    expect(stored.startsWith("scrypt$")).toBe(true);
  });

  it("the same password hashes differently every time, because the salt is per user", async () => {
    // Without this, two people choosing the same password are visibly the same in the table.
    expect(await hashPassword("relaypay")).not.toBe(await hashPassword("relaypay"));
  });

  it("a stored value that is not a hash fails the login instead of throwing", async () => {
    // A row edited by hand must cost that one person their login, not 500 the endpoint for all.
    for (const junk of ["", "relaypay", "scrypt$", "scrypt$zz", "bcrypt$aa$bb", "scrypt$$"]) {
      await expect(verifyPassword("relaypay", junk)).resolves.toBe(false);
    }
  });
});

describe("session tokens", () => {
  it("every token is different, and the stored digest is not the token", async () => {
    const a = newSessionToken();
    const b = newSessionToken();
    expect(a.token).not.toBe(b.token);
    // A leaked copy of the table must not let anyone resume a session.
    expect(a.tokenHash).not.toBe(a.token);
    expect(a.tokenHash).toBe(hashToken(a.token));
  });

  it("the token is long enough to be unguessable", () => {
    expect(newSessionToken().token.length).toBeGreaterThanOrEqual(32);
  });

  it("a session lasts a shift, not a fortnight", () => {
    const now = new Date("2026-10-05T06:00:00Z");
    const hours = (new Date(sessionExpiry(now)).getTime() - now.getTime()) / 3_600_000;
    expect(hours).toBe(SESSION_HOURS);
    expect(hours).toBeLessThanOrEqual(24);
  });
});

describe("reading the session cookie", () => {
  const token = newSessionToken().token;

  it("finds the cookie among others", () => {
    expect(sessionCookie(`support_session=${token}`)).toBe(token);
    expect(sessionCookie(`other=1; support_session=${token}; another=2`)).toBe(token);
    expect(sessionCookie(` support_session=${token} `)).toBe(token);
  });

  it("returns null when there is no session to find", () => {
    expect(sessionCookie(undefined)).toBeNull();
    expect(sessionCookie("")).toBeNull();
    expect(sessionCookie("other=1")).toBeNull();
    expect(sessionCookie("support_session=")).toBeNull();
  });

  it("does not match a cookie whose name merely ends with ours", () => {
    // "not_support_session" is a different cookie, and an attacker who can set one on a
    // neighbouring subdomain should not be able to pose as a session this server issued.
    expect(sessionCookie(`not_support_session=${token}`)).toBeNull();
    expect(sessionCookie(`support_session_x=${token}`)).toBeNull();
  });

  it("rejects a value that is not shaped like a token we issued", () => {
    expect(sessionCookie("support_session=../../etc/passwd")).toBeNull();
    expect(sessionCookie("support_session=' or 1=1--")).toBeNull();
    expect(sessionCookie("support_session=short")).toBeNull();
    expect(sessionCookie(`support_session=${"a".repeat(200)}`)).toBeNull();
  });
});
