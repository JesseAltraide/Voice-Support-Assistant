import { describe, expect, test } from "vitest";
// The machine ships to the browser as plain JS with no build step, so the test reaches
// across into public/. Nothing else in public/ is imported here: the module is DOM-free.
import { initialState, reduce, view, END_TIMEOUT_MS, CLOSE_GRACE_MS } from "../../public/call-state.js";

/** Drive the machine through a list of events and return the final state. */
function run(events: { type: string; message?: string }[]) {
  return events.reduce((state, event) => reduce(state, event).state, initialState());
}

const ASKING = [{ type: "ready" }, { type: "start-clicked" }];
const CONNECTING = [...ASKING, { type: "microphone-granted" }];
const LIVE_CALL = [...CONNECTING, { type: "call-started" }];

describe("startup", () => {
  test("starts disabled until the microphone and config have been checked", () => {
    const v = view(initialState());
    expect(v.start.enabled).toBe(false);
    expect(v.status).toBe("Getting ready");
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

// H3: the permission prompt is modal and open-ended, and the page used to call that wait
// "Connecting" — describing work it had not started, with no way for the caller to tell.
describe("H3 — the microphone prompt is its own state, not a lie about connecting", () => {
  test("clicking start waits on the microphone before it claims to be connecting", () => {
    const v = view(run(ASKING));
    expect(v.status).toBe("Waiting for microphone access");
    expect(v.start).toMatchObject({ visible: true, enabled: false });
    expect(v.end.visible).toBe(false);
  });

  test("connecting begins only once permission is granted", () => {
    expect(view(run(CONNECTING)).status).toBe("Connecting");
  });

  test("a refusal at the prompt is recoverable, not a dead end", () => {
    const refused = run([...ASKING, { type: "start-failed", message: "Microphone access was refused." }]);
    const v = view(refused);
    expect(v.start).toMatchObject({ visible: true, enabled: true, label: "Try again" });
    expect(v.reason).toBe("Microphone access was refused.");
  });

  test("a second click while the prompt is open is ignored", () => {
    const asking = run(ASKING);
    expect(reduce(asking, { type: "start-clicked" }).state).toEqual(asking);
  });

  test("permission granted out of nowhere cannot fake a connection", () => {
    const idle = run([{ type: "ready" }]);
    expect(reduce(idle, { type: "microphone-granted" }).state).toEqual(idle);
  });
});

describe("a normal call", () => {
  test("connecting disables start without hiding it", () => {
    const v = view(run(CONNECTING));
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

  test("a new call clears the previous call's transcript", () => {
    const ended = run([...LIVE_CALL, { type: "call-ended" }]);
    expect(reduce(ended, { type: "start-clicked" }).effects).toContain("clear-transcript");
  });

  test("a refused start does not clear the transcript of the call still running", () => {
    const live = run(LIVE_CALL);
    expect(reduce(live, { type: "start-clicked" }).effects).toEqual([]);
  });
});

// M1: the gap between the caller finishing and the assistant speaking runs to several seconds
// on the hosted tier, and the page used to call that gap "Listening".
describe("M1 — the wait is reported as thinking, not listening", () => {
  test("the page says Thinking once the caller has finished", () => {
    const v = view(run([...LIVE_CALL, { type: "caller-finished" }]));
    expect(v.status).toBe("Thinking");
    expect(v.tone).toBe("live");
  });

  test("thinking gives way to speaking when the assistant starts", () => {
    const thinking = run([...LIVE_CALL, { type: "caller-finished" }]);
    expect(view(reduce(thinking, { type: "speech-started" }).state).status).toBe("Assistant speaking");
  });

  test("the assistant finishing returns to listening, not to thinking", () => {
    const after = run([
      ...LIVE_CALL,
      { type: "caller-finished" },
      { type: "speech-started" },
      { type: "speech-ended" },
    ]);
    expect(view(after).status).toBe("Listening");
  });

  test("barge-in does not claim the assistant is thinking while it is still speaking", () => {
    const speaking = run([...LIVE_CALL, { type: "speech-started" }]);
    const interrupted = reduce(speaking, { type: "caller-finished" });
    expect(interrupted.state).toEqual(speaking);
    expect(view(interrupted.state).status).toBe("Assistant speaking");
  });

  test("the assistant finishing after a barge-in still returns to listening", () => {
    const after = run([
      ...LIVE_CALL,
      { type: "speech-started" },
      { type: "caller-finished" },
      { type: "speech-ended" },
    ]);
    expect(view(after).status).toBe("Listening");
  });

  test("a caller transcript arriving after the call ended cannot show Thinking", () => {
    const ended = run([...LIVE_CALL, { type: "call-ended" }, { type: "caller-finished" }]);
    expect(view(ended).status).toBe("Call ended");
  });

  test("a fresh call starts at listening rather than inheriting the last activity", () => {
    const again = run([
      ...LIVE_CALL,
      { type: "caller-finished" },
      { type: "call-ended" },
      { type: "start-clicked" },
      { type: "call-started" },
    ]);
    expect(view(again).status).toBe("Listening");
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
    // The verdict waits, but the call is stopped at once either way.
    expect(step.state.phase).toBe("closing");
  });

  test("an error while connecting also stops the call, since it may be half open", () => {
    const connecting = run(CONNECTING);
    expect(reduce(connecting, { type: "error" }).effects).toContain("stop-call");
  });

  test("a failed start stops the call rather than assuming it never opened", () => {
    const connecting = run(CONNECTING);
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
    const v = view(run([...LIVE_CALL, { type: "error", message: "network gone" }, { type: "close-timeout" }]));
    expect(v.status).toBe("Connection lost");
    expect(v.reason).toBe("network gone");
    expect(v.reasonTone).toBe("error");
  });

  test("speech events after a lost call cannot resurrect the live status", () => {
    const lost = run([...LIVE_CALL, { type: "error" }, { type: "close-timeout" }, { type: "speech-started" }]);
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
    const connecting = run(CONNECTING);
    expect(reduce(connecting, { type: "start-clicked" }).state).toEqual(connecting);
  });

  test("clicking start while ending is ignored", () => {
    const ending = run([...LIVE_CALL, { type: "end-clicked" }]);
    expect(reduce(ending, { type: "start-clicked" }).state).toEqual(ending);
  });

  test("starting again is allowed only once the call is really over", () => {
    for (const ending of [[{ type: "call-ended" }], [{ type: "error" }, { type: "close-timeout" }]]) {
      const closed = run([...LIVE_CALL, ...ending]);
      expect(reduce(closed, { type: "start-clicked" }).state.phase).toBe("requesting-microphone");
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
    expect(step.state.phase).toBe("closing");
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

// A call ending and a call breaking look identical at the instant the transport reports an
// error: Vapi hangs up remotely when the assistant says its closing phrase, and the error
// arrives before the call-end that explains it. Everything read as "Connection lost".
describe("a call that ended is not a call that broke", () => {
  test("an error does not announce a lost connection straight away", () => {
    const step = reduce(run(LIVE_CALL), { type: "error", message: "daily-error" });
    expect(step.state.phase).toBe("closing");
    expect(view(step.state).status).toBe("Ending");
    // The call is still stopped immediately; only the verdict waits.
    expect(step.effects).toEqual(expect.arrayContaining(["stop-call", "arm-close-timer"]));
  });

  test("a call-end arriving behind the error means the call simply ended", () => {
    const closing = run([...LIVE_CALL, { type: "error", message: "daily-error" }]);
    const step = reduce(closing, { type: "call-ended" });
    expect(view(step.state).status).toBe("Call ended");
    expect(view(step.state).tone).toBeNull();
    expect(step.effects).toContain("cancel-close-timer");
  });

  test("no call-end means the line really was lost, and the reason is shown", () => {
    const closing = run([...LIVE_CALL, { type: "error", message: "network gone" }]);
    const lost = reduce(closing, { type: "close-timeout" }).state;
    expect(view(lost).status).toBe("Connection lost");
    expect(view(lost).tone).toBe("error");
    expect(view(lost).reason).toBe("network gone");
  });

  test("a second error while closing does not restart the wait", () => {
    const closing = run([...LIVE_CALL, { type: "error", message: "first" }]);
    const step = reduce(closing, { type: "error", message: "second" });
    expect(step.state).toEqual(closing);
    expect(step.effects).toEqual([]);
  });

  test("the caller is never stranded while the verdict is pending", () => {
    const v = view(run([...LIVE_CALL, { type: "error" }]));
    expect(v.start.visible || v.end.visible).toBe(true);
  });

  test("the wait is short enough to feel like the call finishing", () => {
    expect(CLOSE_GRACE_MS).toBeLessThanOrEqual(4000);
  });

  // Pressing End and then seeing the transport fail is still the caller ending their own call.
  test("a hang-up the caller asked for is never reported as a lost line", () => {
    const afterEnd = run([...LIVE_CALL, { type: "end-clicked" }, { type: "error", message: "socket closed" }]);
    const resolved = reduce(afterEnd, { type: "close-timeout" }).state;
    expect(view(resolved).status).toBe("Call ended");
    expect(view(resolved).tone).toBeNull();
    expect(view(resolved).reason).toBe("");
  });

  test("an error with no hang-up behind it still reports the line as lost", () => {
    const resolved = run([...LIVE_CALL, { type: "error", message: "network gone" }, { type: "close-timeout" }]);
    expect(view(resolved).status).toBe("Connection lost");
  });

  test("a later call does not inherit the previous one's hang-up", () => {
    const again = run([
      ...LIVE_CALL,
      { type: "end-clicked" },
      { type: "error" },
      { type: "close-timeout" },
      { type: "start-clicked" },
      { type: "microphone-granted" },
      { type: "call-started" },
      { type: "error", message: "network gone" },
      { type: "close-timeout" },
    ]);
    expect(view(again).status).toBe("Connection lost");
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
      ASKING,
      CONNECTING,
      LIVE_CALL,
      [...LIVE_CALL, { type: "speech-started" }],
      [...LIVE_CALL, { type: "end-clicked" }],
      [...LIVE_CALL, { type: "end-clicked" }, { type: "end-timeout" }],
      [...LIVE_CALL, { type: "call-ended" }],
      [...LIVE_CALL, { type: "error", message: "x" }],
      [...CONNECTING, { type: "start-failed", message: "x" }],
    ];

    for (const path of paths) {
      const v = view(run(path));
      expect(v.start.visible || v.end.visible, `dead end after ${JSON.stringify(path)}`).toBe(true);
    }
  });

  test("the live indicator is only used while a call is actually running", () => {
    for (const phase of terminal) {
      const state = { phase, activity: "listening", message: "" };
      expect(view(state as never).tone).not.toBe("live");
    }
  });

  test("every phase renders a status line, so the page is never blank", () => {
    const phases = ["startup", "unavailable", "blocked", "idle", "requesting-microphone", "connecting", "live", "ending", ...terminal];
    for (const phase of phases) {
      const v = view({ phase, activity: "listening", message: "" } as never);
      expect(v.status, phase).toBeTruthy();
    }
  });
});
