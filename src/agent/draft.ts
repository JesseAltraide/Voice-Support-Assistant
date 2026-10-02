/**
 * What the caller is shown after the call, assembled from whatever the call actually produced.
 *
 * Kept apart from the route so it can be tested: the server binds a port on import, and the
 * shaping here is the part that decides whether a caller sees the time they agreed to.
 */

export interface DraftEscalation {
  user_name: string | null;
  user_email: string | null;
  reason: string | null;
  case_reference: string | null;
  contact_confirmed_at: string | null;
}

export interface DraftCallback {
  slot_start: string;
  reads_as: string;
}

export interface DraftPayload {
  has_escalation: boolean;
  callback: DraftCallback | null;
  name: string | null;
  email: string | null;
  reasons: string[];
  reference: string | null;
  confirmed: boolean;
}

/**
 * A call can produce an escalation, a callback, both, or neither. Only the last of those is
 * nothing to show: a booking on its own is still a commitment the caller should see written
 * down, even though there is no contact form attached to it.
 */
export function draftPayload(row: DraftEscalation | null, callback: DraftCallback | null): DraftPayload {
  return {
    has_escalation: row !== null,
    callback,
    name: row?.user_name ?? null,
    email: row?.user_email ?? null,
    // Read-only on purpose. The wording was agreed aloud during the call; only the contact
    // details are open to correction here.
    reasons: String(row?.reason ?? "")
      .split("\n")
      .filter(Boolean),
    reference: row?.case_reference ?? null,
    confirmed: row !== null && row.contact_confirmed_at !== null,
  };
}
