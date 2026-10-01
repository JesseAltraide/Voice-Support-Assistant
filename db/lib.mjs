import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

// Original brief files stay where they are; nothing is copied into this repo.
export const BRIEF_DIR =
  process.env.BRIEF_DIR ||
  "C:/Users/USER/Documents/Important Stuff/Koya/Week 6/aat-c3-week-6-support-agent";

export function adminClient() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env");
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
