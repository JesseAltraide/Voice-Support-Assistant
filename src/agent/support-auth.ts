/**
 * Signing in to the support dashboard.
 *
 * The dashboard used to be gated by the same shared bearer token the Vapi webhook uses, typed
 * into a box. That token still works for scripts and for the evaluation runner; this adds a
 * per-person login so a browser session can be ended without taking the phone line down.
 *
 * Passwords are hashed with scrypt from node:crypto — no new dependency, and deliberately slow.
 * Session tokens are random and stored only as a SHA-256 digest, so a copy of the table does not
 * let anyone resume a session.
 */
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";

/** Wrapped by hand: promisify drops the overload that carries the cost parameters. */
const scrypt = (password: string, salt: Buffer, keylen: number): Promise<Buffer> =>
  new Promise((resolve, reject) =>
    scryptCb(password, salt, keylen, { N: SCRYPT_N }, (err, key) => (err ? reject(err) : resolve(key))),
  );

/** Cost parameters. N=16384 is the node default and takes roughly 100ms, which is the point. */
const SCRYPT_N = 16_384;
const KEY_BYTES = 64;
const SALT_BYTES = 16;

/** How long a browser stays signed in. A support shift, not a fortnight. */
export const SESSION_HOURS = 12;

/** `scrypt$<saltHex>$<keyHex>`. The format is stored so the parameters can change later. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scrypt(password, salt, KEY_BYTES);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

/**
 * Whether a password matches a stored hash.
 *
 * Compared in constant time, and a malformed stored hash is a false rather than a throw: a row
 * someone edited by hand must fail the login, not crash the endpoint for everyone.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, keyHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !keyHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(keyHex, "hex");
  if (salt.length === 0 || expected.length === 0) return false;
  const actual = await scrypt(password, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A new session token for the browser, with the digest to store beside it. */
export function newSessionToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashToken(token) };
}

export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

export const sessionExpiry = (now: Date = new Date()): string =>
  new Date(now.getTime() + SESSION_HOURS * 60 * 60_000).toISOString();

/**
 * How many sign-in attempts are allowed before the door shuts for a while.
 *
 * The general public limiter allows thirty requests a minute, which is right for a caller's
 * browser and far too generous for a password field: it leaves tens of thousands of guesses a
 * day against whatever password someone actually chose. This is counted per address AND per IP,
 * so a weak password cannot be found by spreading guesses across addresses, and one person
 * guessing from one machine cannot be hidden in the noise of a shared office IP.
 */
export const LOGIN_MAX_ATTEMPTS = 5;
export const LOGIN_WINDOW_MS = 15 * 60_000;

const attempts = new Map<string, { count: number; resetAt: number }>();

/**
 * Records a sign-in attempt and says whether it is allowed.
 *
 * Deliberately in memory: this server is a single process, and a limiter that needs a database
 * round trip is a limiter that fails open when the database is the thing under load. A restart
 * clears it, which is the known cost.
 */
export function loginAttemptAllowed(keys: string[], now = Date.now()): boolean {
  let allowed = true;
  for (const key of keys) {
    const seen = attempts.get(key);
    if (!seen || seen.resetAt <= now) {
      attempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
      continue;
    }
    seen.count += 1;
    if (seen.count > LOGIN_MAX_ATTEMPTS) allowed = false;
  }
  // Every key is counted before any refusal is returned, so a blocked address still accrues
  // attempts rather than being let off while another key does the refusing.
  if (attempts.size > 5000) {
    for (const [k, v] of attempts) if (v.resetAt <= now) attempts.delete(k);
  }
  return allowed;
}

/** Called on success: a person who proves who they are should not stay locked out. */
export function clearLoginAttempts(keys: string[]): void {
  for (const key of keys) attempts.delete(key);
}

/**
 * The session token out of a Cookie header, or null.
 *
 * Written by hand rather than pulling in a cookie parser: one cookie is read, in one place, and
 * a dependency that can parse everything is a dependency that can be surprised by everything.
 */
export function sessionCookie(header: string | undefined, name = "support_session"): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    // Only ever our own base64url token. Anything else is not a session we issued.
    return /^[A-Za-z0-9_-]{16,128}$/.test(value) ? value : null;
  }
  return null;
}
