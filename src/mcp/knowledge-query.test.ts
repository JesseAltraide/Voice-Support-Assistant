import { describe, expect, it } from "vitest";
import { buildOrQuery, keepRelevant } from "./knowledge-query.js";

describe("buildOrQuery", () => {
  it("joins meaningful words with OR and drops stopwords and short tokens", () => {
    expect(buildOrQuery("What fees does RelayPay charge for international payments?")).toBe(
      "fees | charge | international | payments",
    );
  });
  it("returns null when nothing searchable remains (negative case)", () => {
    expect(buildOrQuery("what is it")).toBeNull();
    expect(buildOrQuery("")).toBeNull();
    expect(buildOrQuery("?!")).toBeNull();
  });
  it("cannot smuggle tsquery operators through the caller's text", () => {
    const q = buildOrQuery("fees & !secret | ) ( ' ; drop");
    expect(q).toBe("fees | secret | drop");
  });
  it("de-duplicates and caps the term count", () => {
    const q = buildOrQuery("fee fee fee " + Array.from({ length: 30 }, (_, i) => `word${i}x`).join(" "));
    expect(q!.split(" | ").length).toBeLessThanOrEqual(12);
    expect(q!.match(/fee/g)!.length).toBe(1);
  });
});

describe("keepRelevant", () => {
  const row = (slug: string, score: number) => ({ slug, score });
  it("drops noise far below the top score but keeps close matches", () => {
    const kept = keepRelevant([row("a", 0.41), row("b", 0.21), row("c", 0.03)]);
    expect(kept.map((r) => r.slug)).toEqual(["a", "b"]);
  });
  it("keeps a lone weak match, since the true crypto hit scores only 0.03", () => {
    expect(keepRelevant([row("crypto", 0.03)]).map((r) => r.slug)).toEqual(["crypto"]);
  });
  it("returns nothing for nothing", () => {
    expect(keepRelevant([])).toEqual([]);
  });
});
