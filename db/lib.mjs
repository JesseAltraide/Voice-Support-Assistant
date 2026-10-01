import "dotenv/config";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";

// The brief's assets stay where they are; nothing is copied into this repo. That means the
// location differs per machine, so it is asked for rather than guessed: a default pointing at
// one developer's home directory makes `npm run seed` fail for everyone else, with an ENOENT
// naming a path they have never heard of.
const REQUIRED_ASSETS = ["assets/relaypay-knowledge-base.md", "assets/seed-data"];

let cached = null;

/**
 * Resolved when the path is first needed, not when this module loads. Validating at import
 * time would gate `adminClient` — which has nothing to do with the brief — on BRIEF_DIR, so
 * a future migration script importing only the Supabase handle would fail citing a variable
 * it never uses.
 *
 * @returns {string} absolute path to the brief directory
 */
export function briefDir() {
  if (cached === null) cached = resolveBriefDir();
  return cached;
}

function resolveBriefDir() {
  const configured = process.env.BRIEF_DIR;
  if (!configured) {
    throw new Error(
      "BRIEF_DIR is not set. Point it at the unpacked brief directory — the one containing " +
        "assets/relaypay-knowledge-base.md — for example:\n" +
        '  BRIEF_DIR="/path/to/aat-c3-week-6-support-agent" npm run seed\n' +
        "or add BRIEF_DIR to .env.",
    );
  }

  const dir = resolve(configured);
  const missing = REQUIRED_ASSETS.filter((asset) => !existsSync(join(dir, asset)));
  if (missing.length > 0) {
    throw new Error(
      `BRIEF_DIR is set to ${dir}, but it is missing: ${missing.join(", ")}.\n` +
        "Check it points at the brief directory itself, not its parent.",
    );
  }
  return dir;
}

export function adminClient() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env");
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
