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
 *   { type: "ascope:key", event: "keydown" | "keyup", key: string, code: string,
 *     shiftKey: boolean, ctrlKey: boolean, metaKey: boolean, altKey: boolean, repeat: boolean }
 * Viewer to page:
 *   { type: "ascope:ready" }
 *   { type: "ascope:time", time: number | null, playing: boolean }
 *
 * Both sides must share an origin.
 */

import Selection, { SelectionMode } from "../../shared/Selection";

export const IS_EMBEDDED = new URLSearchParams(window.location.search).has("embed");

/** Log names opened by the page, mapped to the URLs to fetch them from. */
const logUrls = new Map<string, string>();

/** Returns the URL for a log the page opened, or null if the page didn't open it. */
export function getEmbeddedLogUrl(name: string): string | null {
  return logUrls.get(name) ?? null;
}

/**
 * Starts listening to the containing page. Call once the hub is ready.
 * @param hubFrame The hub's frame
 * @param openFile Opens a log in the hub by name
 */
export function startEmbedChannel(hubFrame: HTMLIFrameElement, openFile: (name: string) => void) {
  if (!IS_EMBEDDED || window.parent === window) return;
  const post = (message: object) => window.parent.postMessage(message, window.location.origin);
  const getSelection = () => (hubFrame.contentWindow as (Window & { selection?: Selection }) | null)?.selection;

  // Lite cancels mousedown events, which also keeps the browser from moving keyboard focus
  // into this frame. Take focus on click so keyboard shortcuts reach Lite, as they do when
  // Lite is the whole page.
  const takeFocus = () => window.focus();
  window.addEventListener("mousedown", takeFocus, { capture: true });
  hubFrame.contentWindow?.addEventListener("mousedown", takeFocus, { capture: true });

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || event.origin !== window.location.origin) return;
    const message = event.data;
    if (typeof message !== "object" || message === null) return;
    switch (message.type) {
      case "ascope:open-log":
        if (typeof message.url === "string" && typeof message.name === "string") {
          logUrls.set(message.name, message.url);
          openFile(message.name);
        }
        break;
      case "ascope:set-time":
        if (typeof message.time === "number") getSelection()?.setSelectedTime(message.time);
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

  // Report the selected time whenever it changes
  let lastTime: number | null | undefined = undefined;
  let lastPlaying: boolean | undefined = undefined;
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
    }
    window.requestAnimationFrame(reportTime);
  };
  window.requestAnimationFrame(reportTime);

  post({ type: "ascope:ready" });
}
