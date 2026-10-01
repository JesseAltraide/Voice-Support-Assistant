import "dotenv/config";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set in .env`);
  return value;
}

let cached: SupabaseClient | null = null;

/** Server-side client using the service role key. Never import this from browser code. */
export function getDb(): SupabaseClient {
  if (!cached) {
    cached = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return cached;
}
