import { describe, expect, it } from "vitest";
import { type CustomerCandidate, verifyCaller } from "./verify.js";

const CUSTOMERS: CustomerCandidate[] = [
  { customer_id: "CUS-1001", contact_email: "amara@lagosledger.example", contact_name: "Amara Okafor", company_name: "LagosLedger" },
  { customer_id: "CUS-1002", contact_email: "daniel@nairobiops.example", contact_name: "Daniel Mwangi", company_name: "NairobiOps" },
];

const typed = (over: Partial<{ email: string | null; name: string | null; company: string | null }> = {}) => ({
  email: null,
  name: null,
  company: null,
  ...over,
});

describe("two of three agreeing identifiers verifies outright", () => {
  it("email and name both matching the same account verifies, no company needed", () => {
    const r = verifyCaller(CUSTOMERS, typed({ email: "amara@lagosledger.example", name: "Amara" }));
    expect(r).toEqual({ state: "verified", customerId: "CUS-1001" });
  });

  it("email and company both matching verifies, even if name was never given", () => {
    const r = verifyCaller(CUSTOMERS, typed({ email: "amara@lagosledger.example", company: "LagosLedger" }));
    expect(r.state).toBe("verified");
  });

  it("name and company both matching verifies even with no email typed", () => {
    const r = verifyCaller(CUSTOMERS, typed({ name: "Amara Okafor", company: "lagosledger" }));
    expect(r.state).toBe("verified");
  });
});

describe("exactly one identifier agreeing, with no company given, asks for the company", () => {
  it("name matches, email does not, company was never asked — unconfirmed, not guest", () => {
    const r = verifyCaller(CUSTOMERS, typed({ email: "wrong@nowhere.test", name: "Amara" }));
    expect(r).toEqual({ state: "unconfirmed", customerId: null });
  });

  it("only the email matches — still unconfirmed until company is checked", () => {
    const r = verifyCaller(CUSTOMERS, typed({ email: "amara@lagosledger.example", name: "Someone Else" }));
    expect(r.state).toBe("unconfirmed");
  });
});

describe("a guest, with nothing left worth asking", () => {
  it("company was already given and still only one field agreed — no second question to ask", () => {
    const r = verifyCaller(CUSTOMERS, typed({ email: "amara@lagosledger.example", name: "Someone Else", company: "Wrong Co" }));
    expect(r).toEqual({ state: "guest", customerId: null });
  });

  it("neither email nor name matches any account — a correct company could never reach two anyway", () => {
    const r = verifyCaller(CUSTOMERS, typed({ email: "nobody@nowhere.test", name: "Nobody At All" }));
    expect(r).toEqual({ state: "guest", customerId: null });
  });

  it("nothing typed at all is a guest", () => {
    expect(verifyCaller(CUSTOMERS, typed())).toEqual({ state: "guest", customerId: null });
  });

  it("every field wrong, including a typed company, is a guest", () => {
    const r = verifyCaller(CUSTOMERS, typed({ email: "x@y.test", name: "Nobody", company: "Nonexistent Co" }));
    expect(r.state).toBe("guest");
  });
});

describe("name matching is first-name tolerant, the same rule lookup_customer already uses", () => {
  it("a bare first name agrees with the full recorded name", () => {
    const r = verifyCaller(CUSTOMERS, typed({ email: "amara@lagosledger.example", name: "amara" }));
    expect(r.state).toBe("verified");
  });

  it("a different person's name does not agree just because it's a real name", () => {
    const r = verifyCaller(CUSTOMERS, typed({ email: "amara@lagosledger.example", name: "Daniel" }));
    expect(r.state).toBe("unconfirmed");
  });
});

describe("company matching is case- and spacing-insensitive, consistent with lookup_customer", () => {
  it("different case and extra spacing still agree", () => {
    const r = verifyCaller(CUSTOMERS, typed({ name: "Amara", company: "  lagosLEDGER  " }));
    expect(r.state).toBe("verified");
  });
});

describe("the best-matching account wins when candidates disagree", () => {
  it("picks the customer with the higher score, not merely the first row", () => {
    const r = verifyCaller(CUSTOMERS, typed({ email: "daniel@nairobiops.example", name: "Daniel Mwangi" }));
    expect(r).toEqual({ state: "verified", customerId: "CUS-1002" });
  });
});

describe("a tie at the winning score never picks a customer arbitrarily", () => {
  // The scenario the security review found: two different customers share a company name, and
  // a tolerant first-name match lands on both. Whichever row the database happened to return
  // first must not become "the" verified account.
  const TIED: CustomerCandidate[] = [
    { customer_id: "CUS-A", contact_email: "chris.a@acme.example", contact_name: "Chris Adeyemi", company_name: "Acme Corp" },
    { customer_id: "CUS-B", contact_email: "chris.b@acme.example", contact_name: "Chris Baptiste", company_name: "Acme Corp" },
  ];

  it("two customers tying at score 2 (name + company) never verifies either one", () => {
    const r = verifyCaller(TIED, typed({ name: "Chris", company: "Acme Corp" }));
    expect(r.state).not.toBe("verified");
    expect(r.customerId).toBeNull();
  });

  it("the same tie is still a guest, not unconfirmed — company was already given and didn't disambiguate", () => {
    const r = verifyCaller(TIED, typed({ name: "Chris", company: "Acme Corp" }));
    expect(r.state).toBe("guest");
  });

  it("breaking the tie with a correct email resolves it normally", () => {
    const r = verifyCaller(TIED, typed({ name: "Chris", company: "Acme Corp", email: "chris.b@acme.example" }));
    expect(r).toEqual({ state: "verified", customerId: "CUS-B" });
  });

  it("a tie at score 1 does not falsely invite a company question pointed at one candidate", () => {
    // Two different customers both happen to be named "Chris" at different companies; nothing
    // else typed. Still ties at 1, and the eventual lookup_customer call enforces its own
    // uniqueness check regardless, but this must not silently prefer one of them either.
    const sameFirstName: CustomerCandidate[] = [
      { customer_id: "CUS-A", contact_email: "a@one.example", contact_name: "Chris Adeyemi", company_name: "One Co" },
      { customer_id: "CUS-B", contact_email: "b@two.example", contact_name: "Chris Baptiste", company_name: "Two Co" },
    ];
    const r = verifyCaller(sameFirstName, typed({ name: "Chris" }));
    expect(r.customerId).toBeNull();
  });
});
