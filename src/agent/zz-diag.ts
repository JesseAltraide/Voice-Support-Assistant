import { checkReply } from "./guard.js";
const check = (reply: string) => {
  const r = checkReply({ reply, callerTexts: [], groundedTexts: [], forbiddenNames: [],
    records: { escalationExists: false, ticketExists: false } });
  process.stdout.write(`${r.ok ? "ALLOWED" : "BLOCKED [" + r.reasons.join(",") + "]"}  ${JSON.stringify(reply.slice(0,90))}\n`);
};
// what the model actually said, that got deleted
check("I can only look up details for callers with an active RelayPay account, and your email isn't linked to one on file right now.");
// candidates to replace it with
check("I don't have access to transaction or account information without a matching account on file.");
check("I don't have access to transaction, payout or account information for you.");
check("I'm not able to share any transaction or account information, because there's no account on file for you.");
check("There's no account on file for you, so I can't look into transactions, payouts or anything account-related.");
