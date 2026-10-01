/**
 * The call state machine, with no DOM and no SDK in it.
 *
 * It exists as its own module so the transitions can be tested. Two defects found in review
 * lived here when this logic was inline in the page, and both were invisible to any test:
 *
 *   H1 — an error raised mid-call reset the page to idle without stopping the call, so the
 *        page said "Connection lost" while the microphone was still live, and starting again
 *        opened a second concurrent call.
 *   H2 — pressing End hid every control and waited for a "call-ended" that may never arrive,
 *        leaving the page stuck on "Ending" with no button to press.
 *
 * Both are now decisions this file makes, which means both are now assertable. `reduce`
 * returns the effects the caller must perform rather than performing them, so a test can
 * check that an error really does stop the call, not merely that the label changed.
 */

/** How long to wait for "call-ended" after asking to stop, before resetting anyway. */
export const END_TIMEOUT_MS = 4000;

/**
 * @typedef {"startup"|"unavailable"|"blocked"|"idle"|"requesting-microphone"|"connecting"|"live"|"ending"|"ended"|"lost"|"failed"} Phase
 * @typedef {"listening"|"thinking"|"speaking"} Activity
 * @typedef {{ phase: Phase, activity: Activity, message: string }} State
 * @typedef {"stop-call"|"arm-end-timer"|"cancel-end-timer"|"clear-transcript"} Effect
 * @typedef {{ state: State, effects: Effect[] }} Step
 */

/** Phases from which starting a call is allowed. Starting from any other phase is ignored. */
const STARTABLE = new Set(["idle", "ended", "lost", "failed"]);

/** Phases where a call may still be running, so an error has to stop it rather than assume. */
const CALL_MAY_BE_RUNNING = new Set(["connecting", "live", "ending"]);

/** @returns {State} */
export function initialState() {
  return { phase: "startup", activity: "listening", message: "" };
}

/**
 * @param {State} state
 * @param {{ type: string, message?: string }} event
 * @returns {Step}
 */
export function reduce(state, event) {
  const stay = { state, effects: [] };
  const to = (phase, patch = {}, effects = []) => ({
    state: { phase, activity: "listening", message: "", ...patch },
    effects,
  });

  switch (event.type) {
    case "config-failed":
      return to("unavailable", { message: event.message ?? "" });

    case "mic-blocked":
      return to("blocked", { message: event.message ?? "" });

    case "ready":
      return state.phase === "startup" ? to("idle") : stay;

    case "start-clicked":
      // Refusing this outside a startable phase is half of H1: after an error arrives
      // mid-call the page shows a button again, and without this guard pressing it would
      // open a second call on top of the first.
      // Clearing the transcript keeps a second call from appending under the first.
      // The first stop is the permission prompt, not the connection. Calling that wait
      // "Connecting" would be the page describing work it has not started, and the prompt
      // is modal and open-ended, so the caller could sit on that lie indefinitely.
      return STARTABLE.has(state.phase) ? to("requesting-microphone", {}, ["clear-transcript"]) : stay;

    case "microphone-granted":
      return state.phase === "requesting-microphone" ? to("connecting") : stay;

    case "call-started":
      return to("live");

    case "caller-finished":
      // The gap between the caller finishing and the assistant speaking runs to several
      // seconds on the hosted tier. Calling that gap "Listening" is the page asserting
      // something untrue at the one moment a caller is most likely to think it has hung up.
      // It stays "Assistant speaking" through a barge-in, though: the caller talking over
      // the assistant does not stop the assistant, and the page should not say it has.
      if (state.phase !== "live" || state.activity === "speaking") return stay;
      return to("live", { activity: "thinking" });

    case "speech-started":
      return state.phase === "live" ? to("live", { activity: "speaking" }) : stay;

    case "speech-ended":
      return state.phase === "live" ? to("live", { activity: "listening" }) : stay;

    case "end-clicked":
      // Arming the timer here is H2: the reset must not depend on "call-ended" arriving,
      // because a socket that is already dead will never send it.
      return state.phase === "live" ? to("ending", {}, ["arm-end-timer"]) : stay;

    case "call-ended":
      if (!CALL_MAY_BE_RUNNING.has(state.phase)) return stay;
      return to("ended", {}, state.phase === "ending" ? ["cancel-end-timer"] : []);

    case "end-timeout":
      // The stop was requested and never acknowledged. Reset anyway rather than leave the
      // caller looking at "Ending" with nothing to press.
      return state.phase === "ending" ? to("ended") : stay;

    case "error": {
      if (!CALL_MAY_BE_RUNNING.has(state.phase)) return stay;
      // The other half of H1. The call is not known to be over just because an error was
      // reported, so stop it explicitly instead of inferring that it stopped.
      const effects = ["stop-call"];
      if (state.phase === "ending") effects.push("cancel-end-timer");
      return to("lost", { message: event.message ?? "" }, effects);
    }

    case "start-failed":
      // A start can fail after the call is half open, so stop it rather than assume it is not.
      return to("failed", { message: event.message ?? "" }, ["stop-call"]);

    default:
      return stay;
  }
}

const STATUS = {
  startup: "Getting ready",
  unavailable: "Unavailable",
  blocked: "Microphone unavailable",
  idle: "Ready when you are",
  "requesting-microphone": "Waiting for microphone access",
  connecting: "Connecting",
  ending: "Ending",
  ended: "Call ended",
  lost: "Connection lost",
  failed: "Could not start the call",
};

const ACTIVITY = { listening: "Listening", thinking: "Thinking", speaking: "Assistant speaking" };

const TONE = { unavailable: "error", blocked: "warn", lost: "error", failed: "error", live: "live" };

const START_LABEL = { connecting: "Connecting", ended: "Start another call", lost: "Try again", failed: "Try again" };

/**
 * Everything the page needs to render, derived from the state alone. Keeping this a pure
 * function is what stops the page from drifting into a state it was never put in.
 *
 * @param {State} state
 */
export function view(state) {
  const { phase, activity, message } = state;
  const inCall = phase === "live" || phase === "ending";

  return {
    status: phase === "live" ? ACTIVITY[activity] : STATUS[phase],
    tone: TONE[phase] ?? null,
    start: {
      visible: !inCall,
      enabled: STARTABLE.has(phase),
      label: START_LABEL[phase] ?? "Start call",
    },
    end: { visible: inCall, enabled: phase === "live" },
    reason: message,
    reasonTone: phase === "blocked" ? "warn" : "error",
    hintVisible: !inCall,
  };
}
