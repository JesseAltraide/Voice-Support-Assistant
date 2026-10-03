/**
 * The facts about their own account a fully verified caller may be told: plan, account status and
 * verification status, in plain words. Support notes, balances, contact details and the reason an
 * account is in its state are never returned by any tool, so they can never be spoken.
 */
export function describeAccount(plan: string, accountStatus: string, kycStatus: string): string {
  return `Their plan is ${plan}. Their account status is ${accountStatus}. Their verification status is ${kycStatus}.`;
}
