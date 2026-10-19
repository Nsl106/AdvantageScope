// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

/**
 * Embedded mode: AdvantageScope Lite loaded in a frame with "?embed" in its URL,
 * controlled by the page that contains it through window.postMessage.
 *
 * Page to viewer:
 *   { type: "ascope:open-log", url: string, name: string }
 *   { type: "ascope:set-time", time: number }
 *   { type: "ascope:set-playing", playing: boolean }
 *   { type: "ascope:set-range", range: [number, number] }
 *   { type: "ascope:set-layout", layout: HubState }
 *   { type: "ascope:key", event: "keydown" | "keyup", key: string, code: string,
 *     shiftKey: boolean, ctrlKey: boolean, metaKey: boolean, altKey: boolean, repeat: boolean }
 * Viewer to page:
 *   { type: "ascope:ready", version: string, tabTypes: number[] }
 *   { type: "ascope:log-opened" }
 *   { type: "ascope:time", time: number | null, playing: boolean }
 *   { type: "ascope:range", range: [number, number], full: boolean }
 *   { type: "ascope:layout", layout: HubState }
 *   { type: "ascope:key", event: "keydown", key: string, code: string,
 *     shiftKey: boolean, ctrlKey: boolean, metaKey: boolean, altKey: boolean, repeat: boolean }
 *
 * Both sides must share an origin.
 */

import { LITE_VERSION } from "../../shared/buildConstants";
import { HubState } from "../../shared/HubState";
import Selection, { SelectionMode } from "../../shared/Selection";
import { LITE_COMPATIBLE_TABS } from "../../shared/TabType";

export const IS_EMBEDDED = new URLSearchParams(window.location.search).has("embed");

/** Log names opened by the page, mapped to the URLs to fetch them from. */
const logUrls = new Map<string, string>();

/** Reports the hub's state to the page, once the channel has started. */
let reportState: ((state: HubState) => void) | null = null;

/** Returns the URL for a log the page opened, or null if the page didn't open it. */
export function getEmbeddedLogUrl(name: string): string | null {
  return logUrls.get(name) ?? null;
}

/** Call with each state the hub saves; the page hears of it when it changed. */
export function reportEmbeddedState(state: HubState) {
  reportState?.(state);
}

/**
 * Starts listening to the containing page. Call once the hub has restored its saved
 * state and is showing, so the first layout the page hears of is the one it opened with.
 * @param hubFrame The hub's frame
 * @param sendToHub Sends a message to the hub
 */
export function startEmbedChannel(hubFrame: HTMLIFrameElement, sendToHub: (name: string, data?: unknown) => void) {
  if (!IS_EMBEDDED || window.parent === window || reportState !== null) return;
  const post = (message: object) => window.parent.postMessage(message, window.location.origin);
  const getSelection = () => (hubFrame.contentWindow as (Window & { selection?: Selection }) | null)?.selection;

  // Lite cancels mousedown events, which also keeps the browser from moving keyboard focus
  // into this frame. Take focus on click so keyboard shortcuts reach Lite, as they do when
  // Lite is the whole page.
  const takeFocus = () => window.focus();
  window.addEventListener("mousedown", takeFocus, { capture: true });
  hubFrame.contentWindow?.addEventListener("mousedown", takeFocus, { capture: true });

  // Report keys pressed in this frame, so the page's own shortcuts work while it has
  // focus. Only keys pressed outside text fields and without Ctrl, ⌘, or Alt; keys the
  // page sent (dispatched here, so untrusted) aren't sent back.
  const reportKey = (event: KeyboardEvent) => {
    if (!event.isTrusted || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    if (target !== event.view && target !== event.view?.document.body) return;
    post({
      type: "ascope:key",
      event: "keydown",
      key: event.key,
      code: event.code,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      repeat: event.repeat
    });
  };
  window.addEventListener("keydown", reportKey, { capture: true });
  hubFrame.contentWindow?.addEventListener("keydown", (event) => reportKey(event as KeyboardEvent), {
    capture: true
  });

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || event.origin !== window.location.origin) return;
    const message = event.data;
    if (typeof message !== "object" || message === null) return;
    switch (message.type) {
      case "ascope:open-log":
        if (typeof message.url === "string" && typeof message.name === "string") {
          logUrls.set(message.name, message.url);
          sendToHub("open-files", { files: [message.name], merge: false });
        }
        break;
      case "ascope:set-layout":
        if (isHubState(message.layout)) sendToHub("restore-state", message.layout);
        break;
      case "ascope:set-range":
        if (
          Array.isArray(message.range) &&
          message.range.length === 2 &&
          message.range.every((value: unknown) => typeof value === "number" && isFinite(value)) &&
          message.range[0] < message.range[1]
        ) {
          getSelection()?.setTimelineRange([message.range[0], message.range[1]], false);
        }
        break;
      case "ascope:set-time":
        if (typeof message.time === "number") getSelection()?.setSelectedTime(message.time);
        break;
      case "ascope:set-playing":
        if (message.playing === true) getSelection()?.play();
        else if (message.playing === false) getSelection()?.pause();
        break;
      case "ascope:key":
        // A key pressed on the page, handled as if pressed in this window
        if (
          (message.event === "keydown" || message.event === "keyup") &&
          typeof message.key === "string" &&
          typeof message.code === "string"
        ) {
          window.dispatchEvent(
            new KeyboardEvent(message.event, {
              key: message.key,
              code: message.code,
              shiftKey: message.shiftKey === true,
              ctrlKey: message.ctrlKey === true,
              metaKey: message.metaKey === true,
              altKey: message.altKey === true,
              repeat: message.repeat === true
            })
          );
        }
        break;
    }
  });

  // The hub dispatches this when a log it opened has loaded and its timeline is reset
  hubFrame.contentWindow?.addEventListener("historical-opened", () => post({ type: "ascope:log-opened" }));

  // Report the selected time and the timeline's range whenever they change
  let lastTime: number | null | undefined = undefined;
  let lastPlaying: boolean | undefined = undefined;
  let lastRange: [number, number] | undefined = undefined;
  let lastFull: boolean | undefined = undefined;
  const reportTime = () => {
    const selection = getSelection();
    if (selection !== undefined) {
      const time = selection.getSelectedTime();
      const mode = selection.getMode();
      const playing = mode === SelectionMode.Playback || mode === SelectionMode.Locked;
      if (time !== lastTime || playing !== lastPlaying) {
        lastTime = time;
        lastPlaying = playing;
        post({ type: "ascope:time", time: time, playing: playing });
      }
      const range = selection.getTimelineRange();
      const full = selection.getTimelineIsMaxZoom();
      if (range[0] !== lastRange?.[0] || range[1] !== lastRange?.[1] || full !== lastFull) {
        lastRange = range;
        lastFull = full;
        post({ type: "ascope:range", range: range, full: full });
      }
    }
    window.requestAnimationFrame(reportTime);
  };
  window.requestAnimationFrame(reportTime);

  // Report the layout when it changes (the hub saves its state several times a second)
  let lastState: string | null = null;
  reportState = (state) => {
    const json = JSON.stringify(state);
    if (json !== lastState) {
      lastState = json;
      post({ type: "ascope:layout", layout: state });
    }
  };

  post({ type: "ascope:ready", version: LITE_VERSION, tabTypes: LITE_COMPATIBLE_TABS });
}

/** Whether a layout from the page has the outline of a HubState. */
function isHubState(value: unknown): value is HubState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Partial<HubState>;
  return (
    typeof state.sidebar === "object" &&
    state.sidebar !== null &&
    typeof state.tabs === "object" &&
    state.tabs !== null &&
    typeof state.tabs.selected === "number" &&
    Array.isArray(state.tabs.tabs)
  );
}
