import React, {useEffect, useLayoutEffect, useMemo, useRef, useState} from "react";
import type {LauncherState} from "./types";
import {readUtilityWindowContext} from "../../../core/utility-window-model.mjs";
import {restoreLauncherState, subscribeLauncherState} from "./launcher-state-model.mjs";
import {SettingsView} from "./components/SettingsView";
import {CreditsView} from "./components/CreditsView";
import {RuntimesView, useRuntimeManagement} from "./components/RuntimesView";
import {ImportBatches, useImportBatches, DropGameHint, useLauncherDrop} from "./components/ImportBatch";
import {ErrorText} from "./components/ErrorText";
import {collectAcknowledgments} from "./acknowledgments-model";
import sharedAcknowledgments from "../../../modules/shared/acknowledgments.json";

performance.mark("launcher:utility-module-ready");
export default function UtilityApp() {
  const api = window.MacLauncher?.launcher;
  const utilityWindowContext = useMemo(() => readUtilityWindowContext(window.location.search)!, []);
  const [initialState] = useState<LauncherState | null>(() => {
    const first = api?.initialState?.() || null;
    performance.mark("launcher:first-state-read");
    return first;
  });
  const [state, setState] = useState<LauncherState | null>(() => initialState && restoreLauncherState(initialState));
  const [error, setError] = useState<string | null>(null);
  const utilityView = state?.utilityWindow?.view || utilityWindowContext.view;
  const utilityRevision = state?.utilityWindow?.revision;
  const keptUtility = true, runtimesOpen = true, creditsOpen = true;
  const utilityNavigation = useRef<Record<string, number>>({});
  if (utilityRevision !== undefined) utilityNavigation.current[utilityView] = utilityRevision;
  useLayoutEffect(() => {
    if (!api?.onUtilityViewSwitch) return;
    return api.onUtilityViewSwitch(({view, revision}) => {
      for (const slot of document.querySelectorAll<HTMLElement>("[data-utility-view]")) slot.hidden = slot.dataset.utilityView !== view;
      // All slots are mounted. Acknowledge the DOM switch without a hidden frame wait.
      api.utilityWindowDrawn?.(revision);
    });
  }, [api]);
  const initiallyPainted = useRef(false);
  useLayoutEffect(() => {
    if (utilityRevision === undefined) return;
    if (initiallyPainted.current) { api?.utilityWindowDrawn?.(utilityRevision); return; }
    // A fresh page must produce content before its first show. Later requests
    // reuse that painted page and acknowledge their committed DOM immediately.
    let second = 0;
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => {
      initiallyPainted.current = true;
      api?.utilityWindowDrawn?.(utilityRevision);
    }); });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [api, utilityView, utilityRevision]);

  useLayoutEffect(() => { performance.mark("launcher:utility-commit"); }, []);
  useEffect(() => {
    if (!api) return;
    return subscribeLauncherState(api, setState, value => setError(String(value)), initialState);
  }, [api, initialState]);
  const importBatches = useImportBatches(api);
  const {addDropActive, onAppDragEnter, onAppDragLeave, onAppDragOver, onDropAdd} = useLauncherDrop(api, importBatches, setError);
  const {runtimeManagerId, setRuntimeManagerId, runtimeSectionId, setRuntimeSectionId, runtimeUi,
    updateRuntimeUiSection, onRuntimeRefresh, onRuntimeInstall, onRuntimeImport, onRuntimeRegister,
    onRuntimeSetupAction, onRuntimeInstalledAction, onRuntimeSetDefault, onRuntimeUninstall} = useRuntimeManagement(api, state, true, utilityWindowContext.managerId);
  const runtimeManagers = useMemo(() => Object.values(state?.runtimeManagers || {}), [state?.runtimeManagers]);
  const acknowledgments = useMemo(() => collectAcknowledgments(state?.modules || [], sharedAcknowledgments), [state?.modules]);
  const canOpenExternal = Boolean(api?.openExternal);
  const showIcons = state?.launcherSettings?.showIcons !== false;
  const showNonDefaultTags = state?.launcherSettings?.showNonDefaultTags !== false;
  const downloadTasks = useMemo(() => (state?.downloads || []).filter(task => task.status === "downloading"), [state?.downloads]);
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
        sectionId={utilityView === "settings" ? state.utilityWindow?.sectionId || utilityWindowContext.sectionId : undefined}
        shaderCategory={utilityView === "settings" ? state.utilityWindow?.shaderCategory || utilityWindowContext.shaderCategory : undefined}
        navigationKey={utilityNavigation.current.settings}
        onSetLauncherSettings={onSetLauncherSettings} onSetModuleSettings={onSetModuleSettings}
        onAppUpdate={api?.appUpdate ? action => { void api.appUpdate(action).catch((e: any) => setError(String(e?.message || e))); } : undefined}
      /></div>}
      {state && creditsOpen && <div className="utilityViewSlot" data-utility-view="credits" hidden={utilityView !== "credits"}><CreditsView
        acknowledgments={acknowledgments} canOpenExternal={canOpenExternal} onOpenLink={onOpenAcknowledgmentsLink}
      /></div>}
      {state && runtimesOpen && <div className="utilityViewSlot" data-utility-view="runtimes" hidden={utilityView !== "runtimes"}><RuntimesView
        state={state} settingsApi={api} getPathForFile={api?.getPathForFile}
        runtimeManagers={runtimeManagers} runtimeUi={runtimeUi} runtimeManagerId={runtimeManagerId}
        navigationKey={utilityNavigation.current.runtimes}
        runtimeSectionId={runtimeSectionId} downloadTasks={downloadTasks} setRuntimeManagerId={setRuntimeManagerId}
        setRuntimeSectionId={setRuntimeSectionId} updateRuntimeUiSection={updateRuntimeUiSection}
        onRuntimeRefresh={onRuntimeRefresh} onRuntimeInstall={onRuntimeInstall} onRuntimeImport={onRuntimeImport} onRuntimeRegister={onRuntimeRegister}
        onRuntimeSetupAction={onRuntimeSetupAction} onRuntimeInstalledAction={onRuntimeInstalledAction}
        onRuntimeSetDefault={onRuntimeSetDefault} onRuntimeUninstall={onRuntimeUninstall}
        onCancelDownload={id => api?.cancelDownload(id)} onOpenSource={canOpenExternal ? onOpenAcknowledgmentsLink : undefined}
      /></div>}
    </div>;
}
