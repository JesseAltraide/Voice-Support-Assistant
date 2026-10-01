import { readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import { adminClient, BRIEF_DIR } from "./lib.mjs";

// Boundary normalisation: CRLF is handled by the parser, blank cells become NULL,
// values are trimmed. Status text such as "review required" is kept as written;
// the MCP tools normalise it when they read.
const blank = (v) => (v === undefined || v === null || String(v).trim() === "" ? null : String(v).trim());
const num = (v) => (blank(v) === null ? null : Number(v));

function load(name) {
  const text = readFileSync(`${BRIEF_DIR}/assets/seed-data/${name}.csv`, "utf8");
  return parse(text, { columns: true, skip_empty_lines: true, bom: true });
}

const customers = load("customers").map((r) => ({
  customer_id: r.customer_id.trim(),
  company_name: r.company_name.trim(),
  contact_name: r.contact_name.trim(),
  contact_email: r.contact_email.trim().toLowerCase(),
  plan: r.plan.trim(),
  account_status: r.account_status.trim(),
  region: r.region.trim(),
  kyc_status: r.kyc_status.trim(),
  support_notes: blank(r.support_notes),
}));

const transactions = load("transactions").map((r) => ({
  transaction_id: r.transaction_id.trim(),
  customer_id: r.customer_id.trim(),
  transaction_type: r.transaction_type.trim(),
  amount: num(r.amount),
  currency: r.currency.trim(),
  destination_country: blank(r.destination_country),
  status: r.status.trim(),
  created_at: blank(r.created_at),
  estimated_arrival: blank(r.estimated_arrival),
  support_summary: blank(r.support_summary),
}));

const payouts = load("payouts").map((r) => ({
  payout_id: r.payout_id.trim(),
  transaction_id: blank(r.transaction_id),
  customer_id: r.customer_id.trim(),
  recipient_name: blank(r.recipient_name),
  amount: num(r.amount),
  currency: r.currency.trim(),
  status: r.status.trim(),
  scheduled_for: blank(r.scheduled_for),
  failure_reason: blank(r.failure_reason),
}));

const db = adminClient();

// Parents first: transactions reference customers, payouts reference both.
// upsert on the primary key makes re-running a no-op rather than a duplicate.
for (const [table, rows, key] of [
  ["customers", customers, "customer_id"],
  ["transactions", transactions, "transaction_id"],
  ["payouts", payouts, "payout_id"],
]) {
  const { error } = await db.from(table).upsert(rows, { onConflict: key });
  if (error) {
    console.error(`FAILED ${table}:`, error.message);
    process.exit(1);
  }
  const { count } = await db.from(table).select("*", { count: "exact", head: true });
  console.log(`${table}: loaded ${rows.length}, table now holds ${count}`);
}
