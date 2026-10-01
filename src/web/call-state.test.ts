import { describe, expect, test } from "vitest";
// The machine ships to the browser as plain JS with no build step, so the test reaches
// across into public/. Nothing else in public/ is imported here: the module is DOM-free.
import { initialState, reduce, view, END_TIMEOUT_MS } from "../../public/call-state.js";

/** Drive the machine through a list of events and return the final state. */
function run(events: { type: string; message?: string }[]) {
  return events.reduce((state, event) => reduce(state, event).state, initialState());
}

const LIVE_CALL = [{ type: "ready" }, { type: "start-clicked" }, { type: "call-started" }];

describe("startup", () => {
  test("starts disabled until the microphone and config have been checked", () => {
    const v = view(initialState());
    expect(v.start.enabled).toBe(false);
    expect(v.status).toBe("Checking your microphone");
  });

  test("a blocked microphone disables the button and shows the reason", () => {
    const state = run([{ type: "mic-blocked", message: "Microphone access is blocked." }]);
    const v = view(state);
    expect(v.start.enabled).toBe(false);
    expect(v.reason).toBe("Microphone access is blocked.");
    expect(v.reasonTone).toBe("warn");
  });

  test("missing config is an error, not a warning, and never enables the button", () => {
    const v = view(run([{ type: "config-failed", message: "not configured" }]));
    expect(v.start.enabled).toBe(false);
    expect(v.reasonTone).toBe("error");
  });

  test("ready enables the button", () => {
    expect(view(run([{ type: "ready" }])).start.enabled).toBe(true);
  });

  test("a late ready cannot re-enable the button after the microphone was refused", () => {
    const v = view(run([{ type: "mic-blocked", message: "blocked" }, { type: "ready" }]));
    expect(v.start.enabled).toBe(false);
  });
});

describe("a normal call", () => {
  test("connecting disables start without hiding it", () => {
    const v = view(run([{ type: "ready" }, { type: "start-clicked" }]));
    expect(v.start.visible).toBe(true);
    expect(v.start.enabled).toBe(false);
    expect(v.start.label).toBe("Connecting");
  });

  test("a live call swaps start for end", () => {
    const v = view(run(LIVE_CALL));
    expect(v.start.visible).toBe(false);
    expect(v.end).toEqual({ visible: true, enabled: true });
    expect(v.status).toBe("Listening");
  });

  test("speech events move between listening and speaking", () => {
    const speaking = run([...LIVE_CALL, { type: "speech-started" }]);
    expect(view(speaking).status).toBe("Assistant speaking");
    expect(view(reduce(speaking, { type: "speech-ended" }).state).status).toBe("Listening");
  });

  test("hanging up offers another call", () => {
    const v = view(run([...LIVE_CALL, { type: "call-ended" }]));
    expect(v.status).toBe("Call ended");
    expect(v.start).toMatchObject({ visible: true, enabled: true, label: "Start another call" });
    expect(v.end.visible).toBe(false);
  });
});

// H1: an error used to reset the page to idle without stopping the call, so the page said the
// call was lost while the microphone was still live, and starting again stacked a second call.
describe("H1 — an error must stop the call, not just relabel the page", () => {
  test("an error during a live call emits stop-call", () => {
    const live = run(LIVE_CALL);
    const step = reduce(live, { type: "error", message: "network gone" });
    expect(step.effects).toContain("stop-call");
    expect(step.state.phase).toBe("lost");
  });

  test("an error while connecting also stops the call, since it may be half open", () => {
    const connecting = run([{ type: "ready" }, { type: "start-clicked" }]);
    expect(reduce(connecting, { type: "error" }).effects).toContain("stop-call");
  });

  test("a failed start stops the call rather than assuming it never opened", () => {
    const connecting = run([{ type: "ready" }, { type: "start-clicked" }]);
    const step = reduce(connecting, { type: "start-failed", message: "denied" });
    expect(step.effects).toContain("stop-call");
    expect(view(step.state).status).toBe("Could not start the call");
  });

  test("an error that arrives after the call already ended does not stop anything", () => {
    const ended = run([...LIVE_CALL, { type: "call-ended" }]);
    const step = reduce(ended, { type: "error" });
    expect(step.effects).toEqual([]);
    expect(step.state.phase).toBe("ended");
  });

  test("the error message is shown to the caller", () => {
    const v = view(run([...LIVE_CALL, { type: "error", message: "network gone" }]));
    expect(v.status).toBe("Connection lost");
    expect(v.reason).toBe("network gone");
    expect(v.reasonTone).toBe("error");
  });

  test("speech events after a lost call cannot resurrect the live status", () => {
    const lost = run([...LIVE_CALL, { type: "error" }, { type: "speech-started" }]);
    expect(view(lost).status).toBe("Connection lost");
  });
});

// H1, second half: the error path shows a button again, so the machine has to refuse a start
// from any phase where a call might still be running.
describe("H1 — a second call cannot be stacked on a running one", () => {
  test("clicking start during a live call is ignored", () => {
    const live = run(LIVE_CALL);
    const step = reduce(live, { type: "start-clicked" });
    expect(step.state).toEqual(live);
    expect(step.effects).toEqual([]);
  });

  test("clicking start while connecting is ignored", () => {
    const connecting = run([{ type: "ready" }, { type: "start-clicked" }]);
    expect(reduce(connecting, { type: "start-clicked" }).state).toEqual(connecting);
  });

  test("clicking start while ending is ignored", () => {
    const ending = run([...LIVE_CALL, { type: "end-clicked" }]);
    expect(reduce(ending, { type: "start-clicked" }).state).toEqual(ending);
  });

  test("starting again is allowed only once the call is really over", () => {
    for (const closing of [{ type: "call-ended" }, { type: "error" }]) {
      const closed = run([...LIVE_CALL, closing]);
      expect(reduce(closed, { type: "start-clicked" }).state.phase).toBe("connecting");
    }
  });

  test("a blocked microphone still cannot start a call", () => {
    const blocked = run([{ type: "mic-blocked", message: "blocked" }]);
    expect(reduce(blocked, { type: "start-clicked" }).state).toEqual(blocked);
  });
});

// H2: pressing End hid every control and waited for a "call-ended" that a dead socket will
// never send, leaving the page on "Ending" with nothing to press and no way out but a reload.
describe("H2 — ending always resolves", () => {
  test("pressing end arms a timer rather than trusting the acknowledgement", () => {
    const live = run(LIVE_CALL);
    const step = reduce(live, { type: "end-clicked" });
    expect(step.effects).toContain("arm-end-timer");
    expect(step.state.phase).toBe("ending");
  });

  test("the timeout resets the page when the acknowledgement never arrives", () => {
    const ending = run([...LIVE_CALL, { type: "end-clicked" }]);
    const v = view(reduce(ending, { type: "end-timeout" }).state);
    expect(v.status).toBe("Call ended");
    expect(v.start).toMatchObject({ visible: true, enabled: true });
  });

  test("a prompt acknowledgement cancels the timer", () => {
    const ending = run([...LIVE_CALL, { type: "end-clicked" }]);
    const step = reduce(ending, { type: "call-ended" });
    expect(step.effects).toContain("cancel-end-timer");
    expect(step.state.phase).toBe("ended");
  });

  test("an error while ending cancels the timer and still stops the call", () => {
    const ending = run([...LIVE_CALL, { type: "end-clicked" }]);
    const step = reduce(ending, { type: "error", message: "socket closed" });
    expect(step.effects).toEqual(expect.arrayContaining(["stop-call", "cancel-end-timer"]));
    expect(step.state.phase).toBe("lost");
  });

  test("a late acknowledgement after the timeout changes nothing", () => {
    const resolved = run([...LIVE_CALL, { type: "end-clicked" }, { type: "end-timeout" }]);
    expect(reduce(resolved, { type: "call-ended" }).state).toEqual(resolved);
  });

  test("the end button is visible but disabled while ending, so the state is legible", () => {
    const v = view(run([...LIVE_CALL, { type: "end-clicked" }]));
    expect(v.end).toEqual({ visible: true, enabled: false });
    expect(v.status).toBe("Ending");
  });

  test("the timeout is short enough to be a recovery, not a wait", () => {
    expect(END_TIMEOUT_MS).toBeLessThanOrEqual(5000);
  });
});

describe("the page never claims a state it is not in", () => {
  const terminal = ["unavailable", "blocked", "ended", "lost", "failed"];

  test("no phase both hides the start button and leaves no end button", () => {
    const paths: { type: string; message?: string }[][] = [
      [],
      [{ type: "ready" }],
      [{ type: "mic-blocked", message: "x" }],
      [{ type: "config-failed", message: "x" }],
      [{ type: "ready" }, { type: "start-clicked" }],
      LIVE_CALL,
      [...LIVE_CALL, { type: "speech-started" }],
      [...LIVE_CALL, { type: "end-clicked" }],
      [...LIVE_CALL, { type: "end-clicked" }, { type: "end-timeout" }],
      [...LIVE_CALL, { type: "call-ended" }],
      [...LIVE_CALL, { type: "error", message: "x" }],
      [{ type: "ready" }, { type: "start-clicked" }, { type: "start-failed", message: "x" }],
    ];

    for (const path of paths) {
      const v = view(run(path));
      expect(v.start.visible || v.end.visible, `dead end after ${JSON.stringify(path)}`).toBe(true);
    }
  });

  test("the live indicator is only used while a call is actually running", () => {
    for (const phase of terminal) {
      const state = { phase, speaking: false, message: "" };
      expect(view(state as never).tone).not.toBe("live");
    }
  });

  test("every phase renders a status line, so the page is never blank", () => {
    const phases = ["startup", "unavailable", "blocked", "idle", "connecting", "live", "ending", ...terminal];
    for (const phase of phases) {
      const v = view({ phase, speaking: false, message: "" } as never);
      expect(v.status, phase).toBeTruthy();
    }
  });
});
