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
  useEffect(() => {
    if (!keptUtility || !api?.onUtilityViewSwitch) return;
    // The main process switches the displayed view directly, without a render,
    // then shows the window once the frame holding it has been produced: the
    // task after the next frame callback. A window that receives no frames
    // while hidden reports after one frame interval instead.
    let frame = 0, timer = 0;
    const unsubscribe = api.onUtilityViewSwitch(({ view, revision }) => {
      for (const slot of document.querySelectorAll<HTMLElement>("[data-utility-view]")) slot.hidden = slot.dataset.utilityView !== view;
      cancelAnimationFrame(frame); clearTimeout(timer);
      let reported = false;
      const report = () => { if (reported) return; reported = true; cancelAnimationFrame(frame); clearTimeout(timer); api.utilityWindowDrawn?.(revision); };
      frame = requestAnimationFrame(() => { const channel = new MessageChannel(); channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); report(); }; channel.port2.postMessage(0); });
      timer = window.setTimeout(report, 20);
    });
    return () => { cancelAnimationFrame(frame); clearTimeout(timer); unsubscribe(); };
  }, [api, keptUtility]);
  useEffect(() => {
    if (!utilityView || utilityRevision === undefined || !api?.utilityWindowDrawn) return;
    // Navigation uses the same bounded frame acknowledgement as a direct switch.
    let frame = 0, timer = 0, reported = false;
    const report = () => { if (reported) return; reported = true; cancelAnimationFrame(frame); clearTimeout(timer); api.utilityWindowDrawn?.(utilityRevision); };
    frame = requestAnimationFrame(() => { const channel = new MessageChannel(); channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); report(); }; channel.port2.postMessage(0); });
    timer = window.setTimeout(report, 20);
    return () => { cancelAnimationFrame(frame); clearTimeout(timer); };
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
