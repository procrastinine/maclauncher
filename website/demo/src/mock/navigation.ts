// Sidebar sections and tabs inside the launcher's windows change only the
// view's own state, so the bridge never hears about them. After each
// navigation input the demo reads the selection the view now shows, and a
// changed selection names the topic for what is on screen.
import type { LauncherState } from "../../../../src/renderer/src/ui/types";
import { presentRuntimeManagers, withLauncherLibraries } from "../../../../src/modules/runtime-presentations";
import type { DemoStore, DemoTopic } from "./store";

type Selection = { section: string; tab: string };
type Reader = (state: LauncherState, selection: Selection, previous: Selection | null) => DemoTopic;

function runtimeManagers(state: LauncherState) {
  return presentRuntimeManagers(withLauncherLibraries(Object.values(state.runtimeManagers)));
}

/** A Runtimes window topic for one manager: its sidebar group and the game type that lists it. */
export function runtimeTopic(state: LauncherState, kind: string, managerId: string): DemoTopic {
  const manager = runtimeManagers(state).find(item => item.id === managerId);
  const moduleId = state.modules.find(info => (info.runtime as { managerUi?: Record<string, unknown> } | undefined)?.managerUi?.[managerId])?.id;
  return { kind, id: "runtimes", moduleId, detail: { managerId, groupId: manager?.ui?.groupId || managerId } };
}

const after = (value: string, prefix: string) => value.startsWith(prefix) ? value.slice(prefix.length) : "";

const READERS: Record<string, Reader> = {
  // A game type's section, then one of its runtime tabs.
  settings(_state, { section, tab }, previous) {
    const moduleId = after(section, "settings-panel-");
    if (!moduleId || moduleId === "launcher") return { kind: "section", id: "settings", detail: "launcher" };
    const runtimeId = previous?.section === section ? after(tab, `settings-runtime-tab-${moduleId}-`) : "";
    return { kind: "section", id: "settings", moduleId, detail: runtimeId || undefined };
  },
  // A section tab names its manager; a group without tabs has one.
  runtimes(state, { section, tab }) {
    let managerId = "";
    try {
      const [owner, kind] = JSON.parse(decodeURIComponent(after(tab, "runtime-section-tab-")));
      if (kind !== "group") managerId = owner;
    } catch {}
    const group = after(section, "runtime-group-panel-");
    managerId ||= runtimeManagers(state).find(manager => (manager.ui?.groupId || manager.id) === group)?.id || group;
    return runtimeTopic(state, "section", managerId);
  },
  external: (_state, { tab }) => ({ kind: "section", id: "external", detail: after(tab, "steam-").replace(/-tab$/, "") })
};

function readSelection(): Selection {
  return {
    section: document.querySelector('.launcherSidebarItem[aria-current="page"]')?.getAttribute("aria-controls") || "",
    tab: document.querySelector('[role="tablist"] > [role="tab"][aria-selected="true"]')?.id || ""
  };
}

export function followNavigation(store: DemoStore, view: string) {
  const read = READERS[view];
  if (!read) return;
  let shown: Selection | null = null;
  const check = () => {
    const selection = readSelection();
    if (shown?.section === selection.section && shown.tab === selection.tab) return;
    const topic = read(store.state, selection, shown);
    shown = selection;
    store.topic(topic);
  };
  // The view updates within the input's own event, so the selection is read
  // once it has rendered.
  const onInput = (event: Event) => {
    if (event.target instanceof Element && event.target.closest('.launcherSidebar, [role="tablist"]')) setTimeout(check);
  };
  document.addEventListener("click", onInput);
  document.addEventListener("keydown", onInput);
}
