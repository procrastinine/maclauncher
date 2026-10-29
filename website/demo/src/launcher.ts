// Entry for one launcher view. The mock bridge is installed before the
// launcher's own renderer entry runs, so the unmodified launcher UI renders
// against it.
import demoData from "../data/state.json";
import type { LauncherState } from "../../../src/renderer/src/ui/types";
import { createLauncherApi, type DemoGameActions, type DemoGraphics, type DemoSettingsActions } from "./mock/api";
import { createStore, type DemoHost, type DemoStore } from "./mock/store";

declare global {
  interface Window { MacLauncherDemo?: { store: DemoStore; host: DemoHost } }
}

const data = demoData as unknown as {
  state: LauncherState; graphics: DemoGraphics; settingsActions: DemoSettingsActions; gameActions: DemoGameActions;
};

function sharedStore(): DemoStore {
  try {
    const parent = window.parent !== window ? window.parent.MacLauncherDemo : undefined;
    if (parent?.store) return parent.store;
  } catch {}
  return createStore(data.state, null);
}

// Inside the demo's frames, focusing or revealing an element scrolls only
// this view, never the pages around it.
if (window.top !== window) {
  const focus = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function (options?: FocusOptions) {
    focus.call(this, { ...options, preventScroll: true });
  };
  Element.prototype.scrollIntoView = function () {
    for (let box = this.parentElement; box; box = box.parentElement) {
      const style = getComputedStyle(box);
      if (!/auto|scroll/.test(style.overflowY + style.overflowX)) continue;
      const outer = box.getBoundingClientRect(), inner = this.getBoundingClientRect();
      if (inner.top < outer.top) box.scrollTop -= outer.top - inner.top;
      else if (inner.bottom > outer.bottom) box.scrollTop += Math.min(inner.bottom - outer.bottom, inner.top - outer.top);
      if (inner.left < outer.left) box.scrollLeft -= outer.left - inner.left;
      else if (inner.right > outer.right) box.scrollLeft += Math.min(inner.right - outer.right, inner.left - outer.left);
      return;
    }
  };
}

// The launcher's own dialogs, such as "Shortcut saved", follow an action
// whose article the panel already shows, so the demo answers them silently:
// alerts close, confirmations accept and prompts cancel.
window.alert = () => {};
window.confirm = () => true;
window.prompt = () => null;

window.MacLauncher = { launcher: createLauncherApi(sharedStore(), data.graphics, data.settingsActions, data.gameActions) };
await import("../../../src/renderer/src/main");
