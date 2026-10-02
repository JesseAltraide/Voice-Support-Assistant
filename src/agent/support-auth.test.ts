import { describe, expect, it } from "vitest";
import {
  clearLoginAttempts,
  hashPassword,
  hashToken,
  LOGIN_MAX_ATTEMPTS,
  LOGIN_WINDOW_MS,
  loginAttemptAllowed,
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

// The general public limiter allows 30 requests a minute, which against a password field is
// tens of thousands of guesses a day. These are the rules that make a weak password survivable.
describe("slowing down a password guesser", () => {
  const fresh = (n: number) => [`email:someone${n}@relaypay.com`, `ip:198.51.100.${n}`];

  it("allows a few attempts, then stops", () => {
    const keys = fresh(1);
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i += 1) {
      expect(loginAttemptAllowed(keys), `attempt ${i + 1} should be allowed`).toBe(true);
    }
    expect(loginAttemptAllowed(keys)).toBe(false);
    expect(loginAttemptAllowed(keys)).toBe(false);
  });

  it("the door opens again once the window passes", () => {
    const keys = fresh(2);
    const t0 = 1_000_000;
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i += 1) loginAttemptAllowed(keys, t0);
    expect(loginAttemptAllowed(keys, t0)).toBe(false);
    expect(loginAttemptAllowed(keys, t0 + LOGIN_WINDOW_MS + 1)).toBe(true);
  });

  it("signing in successfully clears the count, so one typo does not cost a shift", () => {
    const keys = fresh(3);
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i += 1) loginAttemptAllowed(keys);
    expect(loginAttemptAllowed(keys)).toBe(false);
    clearLoginAttempts(keys);
    expect(loginAttemptAllowed(keys)).toBe(true);
  });

  it("one IP cannot spread its guesses across many addresses", () => {
    // The whole point of counting the IP as well. Without it, a guesser simply changes the
    // address each time and never trips the per-account count.
    const ip = "ip:203.0.113.9";
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i += 1) {
      expect(loginAttemptAllowed([`email:victim${i}@relaypay.com`, ip])).toBe(true);
    }
    expect(loginAttemptAllowed(["email:someone-new@relaypay.com", ip])).toBe(false);
  });

  it("one address cannot be guessed at from many machines", () => {
    // And the mirror of it: a botnet with a fresh IP per request still trips the account count.
    const email = "email:target@relaypay.com";
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i += 1) {
      expect(loginAttemptAllowed([email, `ip:192.0.2.${i}`])).toBe(true);
    }
    expect(loginAttemptAllowed([email, "ip:192.0.2.200"])).toBe(false);
  });

  it("hammering an already-blocked address still gets the machine blocked", () => {
    // The subtle one. Once the address is over its limit every attempt is refused anyway, so it
    // would be easy to stop counting there — and then a guesser could pound one known-locked
    // address from one machine all day, never accruing anything against the machine itself, and
    // walk away free to start on a fresh address. Every key is counted before anything refuses.
    const email = "email:locked@relaypay.com";
    const ip = "ip:172.16.0.5";

    // Lock the address out using throwaway IPs, so the IP under test is still untouched.
    for (let i = 0; i <= LOGIN_MAX_ATTEMPTS; i += 1) loginAttemptAllowed([email, `ip:172.16.9.${i}`]);
    expect(loginAttemptAllowed([email, "ip:172.16.9.250"])).toBe(false);

    // Now keep hammering that locked address from one machine.
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i += 1) loginAttemptAllowed([email, ip]);

    // That machine must now be blocked even against an address it has never tried.
    expect(loginAttemptAllowed(["email:never-tried@relaypay.com", ip])).toBe(false);
  });
});
