import { describe, expect, test } from "vitest";
import { SYSTEM_PROMPT } from "./prompt.js";

describe("the system prompt matches the flow that exists", () => {
  test("never promises an on-screen check that was removed", () => {
    expect(SYSTEM_PROMPT).not.toMatch(/check (your name and email|everything) before this is sent/i);
    expect(SYSTEM_PROMPT).not.toMatch(/checked on screen/i);
  });

  test("does not tell the model to read the email back, which the guard would block", () => {
    expect(SYSTEM_PROMPT).not.toMatch(/Read the email back/);
  });

  test("says name and email come from the form and are not asked for", () => {
    expect(SYSTEM_PROMPT).toMatch(/name and email normally come from the form/);
  });
});

describe("account setup and the email read-back", () => {
  test("tells the model not to invent sign-up steps", () => {
    expect(SYSTEM_PROMPT).toMatch(/no sign-up steps/);
  });
  test("no longer claims the caller can see their email on screen", () => {
    expect(SYSTEM_PROMPT).not.toMatch(/they can see it on screen/);
  });
});
