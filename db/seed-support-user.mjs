/**
 * Creates or updates the support dashboard login.
 *
 * The password is hashed here and only the hash is stored, so no plaintext password exists in
 * the repository, in the database, or in a migration. Run it again at any time to change the
 * password: the row is updated in place rather than duplicated.
 *
 *   node db/seed-support-user.mjs
 *   SUPPORT_EMAIL=someone@relaypay.com SUPPORT_PASSWORD='...' node db/seed-support-user.mjs
 *
 * The defaults are demo credentials for local testing. Anything reachable from the internet
 * should be given a real password through the environment variables above.
 */
import { randomBytes, scrypt as scryptCb } from "node:crypto";
import { adminClient } from "./lib.mjs";

const EMAIL = (process.env.SUPPORT_EMAIL ?? "customersupport@relaypay.com").trim().toLowerCase();
const PASSWORD = process.env.SUPPORT_PASSWORD ?? "relaypay";
const NAME = process.env.SUPPORT_NAME ?? "RelayPay Support";

const scrypt = (password, salt, keylen) =>
  new Promise((resolve, reject) =>
    scryptCb(password, salt, keylen, { N: 16_384 }, (err, key) => (err ? reject(err) : resolve(key))),
  );

const salt = randomBytes(16);
const key = await scrypt(PASSWORD, salt, 64);
const passwordHash = `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;

const db = adminClient();
const existing = await db.from("support_users").select("id").eq("email", EMAIL).maybeSingle();
if (existing.error) {
  console.error(`could not read support_users: ${existing.error.message}`);
  console.error("Has migration 006 been run?");
  process.exit(1);
}

const { error } = existing.data
  ? await db.from("support_users").update({ password_hash: passwordHash, display_name: NAME }).eq("id", existing.data.id)
  : await db.from("support_users").insert({ email: EMAIL, password_hash: passwordHash, display_name: NAME });

if (error) {
  console.error(`could not write support user: ${error.message}`);
  process.exit(1);
}

// Any session signed in under the old password is ended, which is the whole point of changing it.
if (existing.data) await db.from("support_sessions").delete().eq("user_id", existing.data.id);

console.log(`${existing.data ? "Updated" : "Created"} support login for ${EMAIL}.`);
console.log("The password was not written anywhere; only its hash is stored.");
