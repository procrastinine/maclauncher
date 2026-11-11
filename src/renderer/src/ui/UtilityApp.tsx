import React, {useEffect, useLayoutEffect, useMemo, useRef, useState} from "react";
import type {LauncherState, UtilityWindowContext} from "./types";
import {readUtilityWindowContext} from "../../../core/utility-window-model.mjs";
import {restoreLauncherState, subscribeLauncherState} from "./launcher-state-model.mjs";
import {CreditsView} from "./components/CreditsView";
import {ImportBatches, useImportBatches, DropGameHint, useLauncherDrop} from "./components/ImportBatch";
import {ErrorText} from "./components/ErrorText";
import {collectAcknowledgments} from "./acknowledgments-model";
import sharedAcknowledgments from "../../../modules/shared/acknowledgments.json";

const SettingsView = React.lazy(() => import("./components/SettingsView").then(module => ({default: module.SettingsView})));
const UtilityRuntimesView = React.lazy(() => import("./components/RuntimesView").then(module => ({default: module.UtilityRuntimesView})));

performance.mark("launcher:utility-module-ready");
export default function UtilityApp() {
  const api = window.MacLauncher?.launcher;
  const utilityWindowContext = useMemo(() => readUtilityWindowContext(window.location.search)!, []);
  const [initialState] = useState<LauncherState | null>(() => {
    const first = api?.initialState?.() || null;
    performance.mark("launcher:first-state-read");
    return first;
  });
  const [allViews, setAllViews] = useState(() => initialState?.utilityWindow?.prepared !== false);
  const [state, setState] = useState<LauncherState | null>(() => initialState && (
    !allViews && initialState.utilityWindow?.view === "credits" ? initialState : restoreLauncherState(initialState)));
  const [error, setError] = useState<string | null>(null);
  const [navigationRequest, setNavigationRequest] = useState<UtilityWindowContext | null>(null);
  const request: UtilityWindowContext = navigationRequest && (navigationRequest.revision || 0) >= (state?.utilityWindow?.revision || 0)
    ? navigationRequest : state?.utilityWindow || utilityWindowContext;
  const utilityView = request.view;
  const utilityRevision = request.revision;
  const runtimeRequest = utilityView === "runtimes" ? request : null;
  const runtimeState = useMemo(() => state && (runtimeRequest ? {...state, utilityWindow: runtimeRequest} : state), [state, runtimeRequest]);
  const keptUtility = allViews, runtimesOpen = allViews || utilityView === "runtimes", creditsOpen = allViews || utilityView === "credits";
  const utilityNavigation = useRef<Record<string, number>>({});
  if (utilityRevision !== undefined) utilityNavigation.current[utilityView] = utilityRevision;
  useLayoutEffect(() => {
    if (!api?.onUtilityViewSwitch) return;
    return api.onUtilityViewSwitch(request => {
      const {view, revision} = request;
      // A requested replacement mounts its own view first. If retained as the
      // hidden spare it prepares every view before the next use.
      if (!allViews && (request.prepared || view !== utilityView)) {
        const prepare = () => {
          setState(value => value && restoreLauncherState(value));
          setAllViews(true);
          setNavigationRequest(request);
        };
        // Keep the current view drawable if reopened during hidden preparation.
        if (request.prepared) React.startTransition(prepare);
        else prepare();
        return;
      }
      for (const slot of document.querySelectorAll<HTMLElement>("[data-utility-view]")) slot.hidden = slot.dataset.utilityView !== view;
      if (request.managerId || request.sectionId || request.shaderCategory || request.moduleId) {
        setNavigationRequest(request);
        return;
      }
      // All slots are mounted. Acknowledge the DOM switch without a hidden frame wait.
      api.utilityWindowDrawn?.(revision);
    }, utilityRevision);
  }, [api, allViews]);
  const initiallyPainted = useRef(false);
  useLayoutEffect(() => {
    if (utilityRevision === undefined) return;
    if (initiallyPainted.current) { api?.utilityWindowDrawn?.(utilityRevision); return; }
    // Report full controls after their first frame; the HTML shell can already
    // be visible. Later requests acknowledge their committed DOM immediately.
    let second = 0;
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => {
      initiallyPainted.current = true;
      api?.utilityWindowDrawn?.(utilityRevision);
    }); });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [api, utilityView, utilityRevision]);

  useLayoutEffect(() => { performance.mark("launcher:utility-commit"); if (state) document.getElementById?.("utility-shell")?.remove(); }, [Boolean(state)]);
  useEffect(() => {
    if (!api) return;
    return subscribeLauncherState(api, setState, value => setError(String(value)), initialState);
  }, [api, initialState]);
  const importBatches = useImportBatches(api);
  const {addDropActive, onAppDragEnter, onAppDragLeave, onAppDragOver, onDropAdd} = useLauncherDrop(api, importBatches, setError);
  const acknowledgments = useMemo(() => creditsOpen ? collectAcknowledgments(state?.modules || [], sharedAcknowledgments) : [], [state?.modules, creditsOpen]);
  const canOpenExternal = Boolean(api?.openExternal);
  const showIcons = state?.launcherSettings?.showIcons !== false;
  const showNonDefaultTags = state?.launcherSettings?.showNonDefaultTags !== false;
  function onOpenAcknowledgmentsLink(url: string) { api?.openExternal?.(url).catch(() => {}); }
  async function onSetModuleSettings(moduleId: string, patch: Record<string, any>) {
    if (!api) return;
    setError(null);
    try {
      await api.setModuleSettings(moduleId, patch);
    } catch (e: any) {
      setError(String(e?.message || e));
    }
  }

  async function onSetLauncherSettings(patch: Record<string, any>) {
    if (!api) return;
    setError(null);
    try {
      await api.setLauncherSettings(patch);
    } catch (e: any) {
      setError(String(e?.message || e));
    }
  }

  // A targeted Settings request does not invalidate the other mounted views.
  const runtimesPanel = useMemo(() => runtimeState && runtimesOpen && <UtilityRuntimesView
        state={runtimeState} api={api} navigationKey={utilityNavigation.current.runtimes}
        onOpenSource={canOpenExternal ? onOpenAcknowledgmentsLink : undefined}
      />, [runtimeState, api, runtimesOpen, utilityNavigation.current.runtimes]);
  const creditsPanel = useMemo(() => <CreditsView
        acknowledgments={acknowledgments} canOpenExternal={canOpenExternal} onOpenLink={onOpenAcknowledgmentsLink}
      />, [acknowledgments, canOpenExternal, api]);

    return <div className="app utilityWindow" onDragEnter={onAppDragEnter} onDragLeave={onAppDragLeave}
      onDragOver={onAppDragOver} onDrop={onDropAdd}>
      {addDropActive && <div className="dropOverlay">
        <DropGameHint className="dropHintOverlay" title="Drop games, shaders or neural models" modules={state?.modules || []} />
      </div>}
      <ImportBatches {...importBatches} jobs={state?.importing || []} onCancel={input => { api?.cancelImport(input).catch(value => setError(String(value))); }} />
      <ErrorText error={error} onDismiss={() => setError(null)} />
      {!state && !error && <div className="empty" role="status">Loading…</div>}
      {state && (keptUtility || utilityView === "settings") && <div className="utilityViewSlot" data-utility-view="settings" hidden={utilityView !== "settings"}><SettingsView
        state={state} api={api || undefined} showIcons={showIcons} showNonDefaultTags={showNonDefaultTags}
        sectionId={utilityView === "settings" ? request.sectionId : undefined}
        shaderCategory={utilityView === "settings" ? request.shaderCategory : undefined}
        navigationKey={utilityNavigation.current.settings}
        onSetLauncherSettings={onSetLauncherSettings} onSetModuleSettings={onSetModuleSettings}
        onAppUpdate={api?.appUpdate ? action => { void api.appUpdate(action).catch((e: any) => setError(String(e?.message || e))); } : undefined}
      /></div>}
      {state && creditsOpen && <div className="utilityViewSlot" data-utility-view="credits" hidden={utilityView !== "credits"}>{creditsPanel}</div>}
      {state && runtimesOpen && <div className="utilityViewSlot" data-utility-view="runtimes" hidden={utilityView !== "runtimes"}>{runtimesPanel}</div>}
    </div>;
}
