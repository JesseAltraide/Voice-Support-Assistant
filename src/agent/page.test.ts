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
