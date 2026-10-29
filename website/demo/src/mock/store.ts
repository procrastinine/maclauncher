// One launcher state shared by every launcher view on the page. The library
// and each utility window run in their own frames, so the store lives on the
// page that hosts them; a frame opened directly keeps a private copy.
import type { LauncherState } from "../../../../src/renderer/src/ui/types";

export type DemoTopic = { kind: string; id: string; moduleId?: string; detail?: unknown };
/** A launcher window shown as a panel: its title and the query string that selects the view. */
export type DemoWindow = { title: string; search: Record<string, string> };

export type DemoStore = {
  readonly state: LauncherState;
  snapshot(): LauncherState;
  update(change: (state: LauncherState) => LauncherState): void;
  subscribe(callback: (state: LauncherState) => void): () => void;
  topic(topic: DemoTopic): void;
  openWindow(window: DemoWindow): void;
};

export type DemoHost = {
  topic(topic: DemoTopic): void;
  openWindow(window: DemoWindow): void;
};

export function createStore(initial: LauncherState, host: DemoHost | null): DemoStore {
  let state = initial, lastTopic = "";
  const listeners = new Set<(state: LauncherState) => void>();
  return {
    get state() { return state; },
    snapshot: () => state,
    update(change) {
      state = change(state);
      // A closed window's listeners are dropped when they can no longer run.
      for (const listener of [...listeners]) {
        try { listener(state); } catch { listeners.delete(listener); }
      }
    },
    subscribe(callback) {
      listeners.add(callback);
      return () => { listeners.delete(callback); };
    },
    // Repeated reads of the same thing name one topic.
    topic(topic) {
      const key = JSON.stringify([topic.kind, topic.id, topic.moduleId, topic.detail]);
      if (key === lastTopic) return;
      lastTopic = key;
      host?.topic(topic);
    },
    openWindow: window => host?.openWindow(window)
  };
}
