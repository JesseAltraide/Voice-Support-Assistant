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

describe("all three identifiers must agree to verify", () => {
  it("email, name and company all matching the same account verifies", () => {
    const r = verifyCaller(CUSTOMERS, typed({ email: "amara@lagosledger.example", name: "Amara", company: "LagosLedger" }));
    expect(r).toEqual({ state: "verified", customerId: "CUS-1001" });
  });

  it("two of three agreeing, company given and correct, still verifies", () => {
    const r = verifyCaller(CUSTOMERS, typed({ email: "amara@lagosledger.example", name: "Amara Okafor", company: "lagosledger" }));
    expect(r.state).toBe("verified");
  });

  it("two agreeing is no longer enough on its own — company omitted means not yet verified", () => {
    const r = verifyCaller(CUSTOMERS, typed({ email: "amara@lagosledger.example", name: "Amara" }));
    expect(r.state).not.toBe("verified");
  });
});

describe("email and name agreeing, company never given, asks for the company", () => {
  it("both mandatory fields match, company omitted — unconfirmed, not guest", () => {
    const r = verifyCaller(CUSTOMERS, typed({ email: "amara@lagosledger.example", name: "Amara" }));
    expect(r).toEqual({ state: "unconfirmed", customerId: null });
  });

  it("the same, with the full recorded name instead of a first name", () => {
    const r = verifyCaller(CUSTOMERS, typed({ email: "amara@lagosledger.example", name: "Amara Okafor" }));
    expect(r.state).toBe("unconfirmed");
  });
});

describe("only one of the two mandatory fields agreeing is a guest, not unconfirmed", () => {
  it("email matches, name does not — company could never bring this to three either way", () => {
    const r = verifyCaller(CUSTOMERS, typed({ email: "amara@lagosledger.example", name: "Someone Else" }));
    expect(r).toEqual({ state: "guest", customerId: null });
  });

  it("name matches, email does not", () => {
    const r = verifyCaller(CUSTOMERS, typed({ email: "wrong@nowhere.test", name: "Amara" }));
    expect(r.state).toBe("guest");
  });
});

describe("a guest, with nothing left worth asking", () => {
  it("company was already given and still not all three agree — no second question to ask", () => {
    const r = verifyCaller(CUSTOMERS, typed({ email: "amara@lagosledger.example", name: "Amara", company: "Wrong Co" }));
    expect(r).toEqual({ state: "guest", customerId: null });
  });

  it("email and name both match, but company was given and wrong — still guest, not asked again", () => {
    const r = verifyCaller(CUSTOMERS, typed({ email: "amara@lagosledger.example", name: "Amara Okafor", company: "Totally Different Co" }));
    expect(r.state).toBe("guest");
  });

  it("neither email nor name matches any account", () => {
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
  it("a bare first name still agrees with the full recorded name, for the purpose of reaching three", () => {
    const r = verifyCaller(CUSTOMERS, typed({ email: "amara@lagosledger.example", name: "amara", company: "LagosLedger" }));
    expect(r.state).toBe("verified");
  });

  it("a different person's name does not agree just because it's a real name", () => {
    const r = verifyCaller(CUSTOMERS, typed({ email: "amara@lagosledger.example", name: "Daniel", company: "LagosLedger" }));
    expect(r.state).toBe("guest");
  });
});

describe("company matching is case- and spacing-insensitive, consistent with lookup_customer", () => {
  it("different case and extra spacing still agree", () => {
    const r = verifyCaller(CUSTOMERS, typed({ email: "amara@lagosledger.example", name: "Amara", company: "  lagosLEDGER  " }));
    expect(r.state).toBe("verified");
  });
});

describe("the best-matching account wins when candidates disagree", () => {
  it("picks the customer with the higher score, not merely the first row", () => {
    const r = verifyCaller(CUSTOMERS, typed({ email: "daniel@nairobiops.example", name: "Daniel Mwangi", company: "NairobiOps" }));
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

  it("the same tie is a guest, not unconfirmed — company was already given and didn't disambiguate", () => {
    const r = verifyCaller(TIED, typed({ name: "Chris", company: "Acme Corp" }));
    expect(r.state).toBe("guest");
  });

  it("breaking the tie with a correct email resolves it normally", () => {
    const r = verifyCaller(TIED, typed({ name: "Chris", company: "Acme Corp", email: "chris.b@acme.example" }));
    expect(r).toEqual({ state: "verified", customerId: "CUS-B" });
  });

  it("a tie at score 1 does not falsely invite a company question pointed at one candidate", () => {
    const sameFirstName: CustomerCandidate[] = [
      { customer_id: "CUS-A", contact_email: "a@one.example", contact_name: "Chris Adeyemi", company_name: "One Co" },
      { customer_id: "CUS-B", contact_email: "b@two.example", contact_name: "Chris Baptiste", company_name: "Two Co" },
    ];
    const r = verifyCaller(sameFirstName, typed({ name: "Chris" }));
    expect(r.customerId).toBeNull();
    expect(r.state).toBe("guest");
  });
});

describe("company said by voice as speech-to-text writes it", () => {
  it("'Lagos Ledger' agrees with 'LagosLedger'", () => {
    const r = verifyCaller(CUSTOMERS, typed({ email: "amara@lagosledger.example", name: "Amara Okafor", company: "Lagos Ledger" }));
    expect(r.state).toBe("verified");
  });

  it("punctuation and spacing differences do not matter, a different company still does", () => {
    expect(verifyCaller(CUSTOMERS, typed({ email: "daniel@nairobiops.example", name: "Daniel", company: "Nairobi Ops." })).state).toBe("verified");
    expect(verifyCaller(CUSTOMERS, typed({ email: "amara@lagosledger.example", name: "Amara", company: "Lagos Ledgers" })).state).toBe("guest");
  });
});
