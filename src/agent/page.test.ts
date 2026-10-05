import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const html = readFileSync(new URL("../../public/index.html", import.meta.url), "utf8");

function pageScript(): string {
  const open = html.indexOf('<script type="module">');
  const start = html.indexOf(">", open) + 1;
  return html.slice(start, html.indexOf("</script>", start));
}

describe("the voice page", () => {
  test("its script parses, so the Start button can work at all", () => {
    // Imports are stripped and the body wrapped, because a module cannot be compiled by Function.
    // A deleted function header or a stray brace still fails here, which is the point.
    const body = pageScript().replace(/^\s*import\s[^;]+;\s*$/gm, "");
    expect(() => new Function(`return (async () => {${body}\n});`)).not.toThrow();
  });

  test("every element the script looks up exists in the markup", () => {
    const used = new Set([...pageScript().matchAll(/\bel\("([^"]+)"\)/g)].map((m) => m[1]!));
    expect(used.size).toBeGreaterThan(5);
    const missing = [...used].filter((id) => !html.includes(`id="${id}"`));
    expect(missing).toEqual([]);
  });

  test("the removed confirmation form is gone from markup and script", () => {
    for (const gone of ["review-submit", "review-name", "review-email", "/escalation/confirm", "Confirm and send"]) {
      expect(html).not.toContain(gone);
    }
  });
});

describe("call errors are shown in plain English", () => {
  const block = html.slice(html.indexOf("// <friendly-errors>"), html.indexOf("// </friendly-errors>"));
  const friendly = new Function(`${block}\nreturn friendlyCallError;`)() as (raw: unknown) => string;

  test("an empty wallet reads as the service being out of credit", () => {
    expect(friendly("Your Wallet Balance is -0.08. Please Purchase More Credits or Upgrade Your Plan Before Proceeding.")).toMatch(/out of credit/);
  });

  test("the SDK's own generic label is replaced, not shown", () => {
    for (const raw of ["start-method-error", "Start method error", "", undefined, "unknown"]) {
      expect(friendly(raw)).toBe("We could not start the call. Please try again in a moment.");
    }
  });

  test("microphone, key and network failures each get their own sentence", () => {
    expect(friendly("NotAllowedError: Permission denied")).toMatch(/microphone/);
    expect(friendly("401 Unauthorized")).toMatch(/did not accept this connection/);
    expect(friendly("Failed to fetch")).toMatch(/connection dropped/);
  });

  test("a generic error in the middle of a call does not claim the call never started", () => {
    const f = friendly as (raw: unknown, fallback?: string) => string;
    expect(f("unknown", "The call could not continue.")).toBe("The call could not continue.");
  });

  test("the transport's own label is never shown", () => {
    expect(friendly("daily-error")).toMatch(/microphone is on and allowed/);
  });

  test("an ejection or ended meeting reads as the service ending the call", () => {
    expect(friendly("Meeting ended due to ejection: Meeting has ended")).toMatch(/ended by the voice service/);
    expect(friendly("ejected")).toMatch(/ended by the voice service/);
  });

  test("the real reason is read from inside a transport error", () => {
    const pick = new Function(`${html.slice(html.indexOf("function errorMessage"), html.indexOf("// <friendly-errors>"))}
return errorMessage;`)() as (e: unknown) => string;
    expect(pick({ type: "daily-error", error: { errorMsg: "Meeting has ended", error: { msg: "ejected" } } })).toBe("Meeting has ended");
    expect(pick({ type: "daily-error", error: { error: { msg: "Connection error" } } })).toBe("Connection error");
    expect(pick({ type: "daily-error" })).toBe("daily-error");
  });

  test("an unrecognised message is shown as it came", () => {
    expect(friendly("Something specific happened")).toBe("Something specific happened");
  });
});
