import React, { useEffect, useRef, useState } from "react";
import type { ComponentEntry, ComponentItem, ComponentList } from "../types";
import { confirmAction } from "../confirm-action";
import { FolderIcon, RefreshIcon, TrashIcon } from "../icons";
import { ErrorText } from "./ErrorText";
import { HelpTip } from "./HelpTip";
import { StatusBadge } from "./StatusBadge";
import { componentCpuLabel, componentDeleteRequest, componentIdentityText, componentImportLabel, componentItemName,
  componentSizeText, componentSourceText } from "./components-model";

export type ComponentsApi = { componentAction: NonNullable<Window["MacLauncher"]>["launcher"]["componentAction"] };

// Runtimes → Components: downloads without a Runtimes row of their own. The list
// reads local files only; Delete, Add and Show in Finder act on one item.
export function ComponentsView({ api: suppliedApi, navigationKey, initial }: {
  api?: ComponentsApi; navigationKey?: number; initial?: ComponentList;
}) {
  const api = suppliedApi || (typeof window === "undefined" ? undefined : window.MacLauncher?.launcher);
  const [list, setList] = useState<ComponentList | null>(initial || null);
  const [loading, setLoading] = useState(!initial);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState("");
  const request = useRef(0);
  async function load() {
    const token = ++request.current;
    if (!api?.componentAction) { setLoading(false); setError("Components are unavailable."); return; }
    setLoading(true);
    try {
      const next = await api.componentAction("list");
      if (token === request.current) { setList(next); setError(null); }
    } catch (failure) { if (token === request.current) setError(failure); }
    finally { if (token === request.current) setLoading(false); }
  }
  useEffect(() => { if (!initial) void load(); return () => { request.current++; }; }, [api, navigationKey, initial]);

  // The list is read again after every action; a failed action keeps its reason shown.
  async function act(key: string, run: () => Promise<boolean>, done?: string) {
    setBusy(key); setError(null); setMessage("");
    let failed: unknown = null;
    try { if (await run() && done) setMessage(done); }
    catch (failure) { failed = failure; }
    setBusy(""); await load();
    if (failed) setError(failed);
  }
  async function remove(component: ComponentEntry, item: ComponentItem) {
    if (!api || !await confirmAction(componentDeleteRequest(component, item, list?.gameRunning))) return;
    await act(`${component.id}:${item.id}`, () => api.componentAction("remove", { componentId: component.id, itemId: item.id }),
      `Deleted ${componentItemName(component, item)}.`);
  }
  async function add(component: ComponentEntry) {
    if (!api) return;
    await act(`${component.id}:import`, () => api.componentAction("import", { componentId: component.id }), `Added ${component.label}.`);
  }
  async function reveal(component: ComponentEntry, item: ComponentItem) {
    if (!api) return;
    try { await api.componentAction("reveal", { componentId: component.id, itemId: item.id }); }
    catch (failure) { setError(failure); }
  }

  const components = list?.components || [];
  return <div className="runtimeTabPanel componentsView" id="runtime-panel-components">
    <div className="runtimePanel">
      <div className="runtimeSectionCard">
        <div className="runtimeSectionHeader">
          <div>
            <div className="runtimeSectionTitle">Components
              <HelpTip label="About components">Files that runtimes and games download when needed and that have no list of their own.
                A deleted item downloads again, after consent, the next time something needs it. Add reads a local copy and checks it
                against the identity MacLauncher records for that item, without network access.</HelpTip>
            </div>
          </div>
          <div className="runtimePanelHeaderActions">
            <button type="button" className={`btn iconOnly runtimeRefresh${loading ? " refreshing" : ""}`} disabled={loading || Boolean(busy)}
              aria-busy={loading} title="Reload components" aria-label="Reload components" onClick={() => void load()}><RefreshIcon /></button>
          </div>
        </div>
        {(error || message) && <div className="runtimeSectionBody">
          <ErrorText error={error} inline className="runtimeError" onDismiss={() => setError(null)} />
          {message && !error && <div className="dim runtimeActionStatus" role="status">{message}</div>}
        </div>}
        {loading && !list && <div className="runtimeSectionBody"><span className="dim" role="status">Reading installed components…</span></div>}
      </div>
      {components.map(component => <section key={component.id} className="saveSection runtimeSection componentGroup"
        aria-label={component.label} data-component-id={component.id}>
        <div className="saveSectionTitle runtimeInstalledHeader">
          <span>{component.label}{component.description && <HelpTip label={`About ${component.label}`}>{component.description}</HelpTip>}</span>
          {component.importable && <span className="runtimeInstalledHeaderRight">
            <button type="button" className="btn small" disabled={Boolean(busy)} onClick={() => void add(component)}>
              {busy === `${component.id}:import` ? "Adding…" : componentImportLabel(component)}
            </button>
          </span>}
        </div>
        {component.error && <ErrorText error={component.error} inline />}
        {component.items.length === 0 ? <div className="empty">Not installed.</div> : <div className="saveList">
          {component.items.map(item => {
            const cpu = componentCpuLabel(item), size = componentSizeText(item), source = componentSourceText(item);
            const identity = componentIdentityText(item.identity);
            const removing = busy === `${component.id}:${item.id}`;
            return <div className="saveRow" key={item.id} data-component-item={item.id}>
              <div className="saveRowMain">
                <div className="saveName">
                  {item.version || component.label}
                  {cpu && <span className="badge" title="CPU architecture">{cpu}</span>}
                  {item.status && <StatusBadge tone="warning">{item.status}</StatusBadge>}
                </div>
                <div className="dim componentMeta">
                  {[size, source].filter(Boolean).join(" · ")}
                  {identity && <>{(size || source) && " · "}<span className="mono" title={item.identity}>{identity}</span></>}
                </div>
                <div className="dim">{item.users.length ? `Used by ${item.users.join(", ")}` : "Not used by an installed runtime"}</div>
                {!item.removable && item.removeReason && <div className="dim">{item.removeReason}</div>}
              </div>
              <div className="saveRowActions">
                {item.path && <button type="button" className="btn iconOnly" disabled={Boolean(busy)} title="Show in Finder"
                  aria-label={`Show ${componentItemName(component, item)} in Finder`} onClick={() => void reveal(component, item)}><FolderIcon /></button>}
                <button type="button" className="btn iconOnly danger" disabled={Boolean(busy) || !item.removable}
                  title={item.removable ? "Delete" : item.removeReason || "This item cannot be deleted here."}
                  aria-label={removing ? `Deleting ${componentItemName(component, item)}` : `Delete ${componentItemName(component, item)}`}
                  onClick={() => void remove(component, item)}><TrashIcon /></button>
              </div>
            </div>;
          })}
        </div>}
      </section>)}
    </div>
  </div>;
}
