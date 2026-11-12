import React, { useEffect, useRef, useState } from "react";
import type { ComponentEntry, ComponentItem, ComponentList } from "../types";
import { confirmAction } from "../confirm-action";
import { FolderIcon, RefreshIcon, TrashIcon } from "../icons";
import { ErrorText } from "./ErrorText";
import { HelpTip } from "./HelpTip";
import { StatusBadge } from "./StatusBadge";
import { componentCpuLabel, componentDeleteRequest, componentDeleteUnusedRequest, componentItemName, componentRows,
  componentSizeText, componentSourceText, retainComponentList, retainedComponentList, unusedComponentRows } from "./components-model";

export type ComponentsApi = { componentAction: NonNullable<Window["MacLauncher"]>["launcher"]["componentAction"] };

// Runtimes → Tools → Downloaded files: downloads without a Runtimes row of
// their own, installed items only and largest first. The list reads local files
// only; Add from file, Delete unused, Delete and Show in Finder act on it.
// The view opens with the last list it read and reads the files again; Delete
// and Delete unused wait for that read, since a file's users may have changed.
export function ComponentsView({ api: suppliedApi, navigationKey, initial }: {
  api?: ComponentsApi; navigationKey?: number; initial?: ComponentList;
}) {
  const api = suppliedApi || (typeof window === "undefined" ? undefined : window.MacLauncher?.launcher);
  const [list, setList] = useState<ComponentList | null>(() => initial || retainedComponentList());
  const [confirmed, setConfirmed] = useState(Boolean(initial));
  const [loading, setLoading] = useState(!initial);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState("");
  const request = useRef(0);
  async function load() {
    const token = ++request.current;
    setConfirmed(false);
    if (!api?.componentAction) { setLoading(false); setError("Downloaded files are unavailable."); return; }
    setLoading(true);
    try {
      const next = await api.componentAction("list");
      if (token === request.current) { setList(next); setConfirmed(true); setError(null); retainComponentList(next); }
    } catch (failure) { if (token === request.current) setError(failure); }
    finally { if (token === request.current) setLoading(false); }
  }
  useEffect(() => { if (!initial) void load(); return () => { request.current++; }; }, [api, navigationKey, initial]);

  // The list is read again after every action; a failed action keeps its reason shown.
  async function act(key: string, run: () => Promise<string>) {
    setBusy(key); setError(null); setMessage("");
    let failed: unknown = null;
    try { const done = await run(); if (done) setMessage(done); }
    catch (failure) { failed = failure; }
    setBusy(""); await load();
    if (failed) setError(failed);
  }
  async function remove(component: ComponentEntry, item: ComponentItem) {
    if (!api || !await confirmAction(componentDeleteRequest(component, item, list?.gameRunning))) return;
    await act(`${component.id}:${item.id}`, async () => await api.componentAction("remove", { componentId: component.id, itemId: item.id })
      ? `Deleted ${componentItemName(component, item)}.` : "");
  }
  async function removeUnused() {
    const unused = unusedComponentRows(componentRows(list));
    if (!api || !unused.length || !await confirmAction(componentDeleteUnusedRequest(unused, list?.gameRunning))) return;
    await act("unused", async () => {
      let deleted = 0;
      for (const { component, item } of unused) if (await api.componentAction("remove", { componentId: component.id, itemId: item.id })) deleted++;
      return deleted === 1 ? "Deleted 1 unused download." : `Deleted ${deleted} unused downloads.`;
    });
  }
  async function add() {
    if (!api) return;
    await act("import", async () => { const added = await api.componentAction("import"); return added ? `Added ${added.label}.` : ""; });
  }
  // A component whose versions come from a catalog reads it on Refresh.
  async function refresh(component: ComponentEntry) {
    if (!api) return;
    await act(`refresh:${component.id}`, async () => await api.componentAction("refresh", { componentId: component.id }));
  }
  async function reveal(component: ComponentEntry, item: ComponentItem) {
    if (!api) return;
    try { await api.componentAction("reveal", { componentId: component.id, itemId: item.id }); }
    catch (failure) { setError(failure); }
  }

  const rows = componentRows(list), unused = unusedComponentRows(rows);
  // One Refresh per catalog, on the first row of its component.
  const refreshRows = new Set(rows.filter(row => row.component.refreshable).filter((row, index, all) =>
    all.findIndex(other => other.component.id === row.component.id) === index).map(row => `${row.component.id}:${row.item.id}`));
  const failed = (list?.components || []).filter(component => component.error);
  const reading = "Reading downloaded files…";
  return <div className="runtimeTabPanel componentsView" id="runtime-panel-components">
    <div className="runtimePanel">
      <div className="runtimeSectionCard">
        <div className="runtimeSectionHeader">
          <div>
            <div className="runtimeSectionTitle">Downloaded files
              <HelpTip label="About downloaded files">Files that runtimes and games download when needed and that have no list of their own.
                A deleted file downloads again, after consent, the next time something needs it. Add from file reads a local copy and
                adds it when it matches a download that MacLauncher records, without network access.</HelpTip>
            </div>
          </div>
          <div className="runtimePanelHeaderActions">
            <button type="button" className="btn small" disabled={Boolean(busy)} onClick={() => void add()}>
              {busy === "import" ? "Adding…" : "Add from file…"}</button>
            <button type="button" className="btn small" disabled={Boolean(busy) || !confirmed || unused.length === 0} onClick={() => void removeUnused()}
              title={!confirmed ? reading : unused.length ? undefined : "Every downloaded file is in use."}>{busy === "unused" ? "Deleting…" : "Delete unused"}</button>
            <button type="button" className={`btn iconOnly runtimeRefresh${loading ? " refreshing" : ""}`} disabled={loading || Boolean(busy)}
              aria-busy={loading} title="Reload downloaded files" aria-label="Reload downloaded files" onClick={() => void load()}><RefreshIcon /></button>
          </div>
        </div>
        {(error || message || failed.length > 0) && <div className="runtimeSectionBody">
          <ErrorText error={error} inline className="runtimeError" onDismiss={() => setError(null)} />
          {message && !error && <div className="dim runtimeActionStatus" role="status">{message}</div>}
          {failed.map(component => <ErrorText key={component.id} error={`${component.label}: ${component.error}`} inline />)}
        </div>}
        {loading && !list && <div className="runtimeSectionBody"><span className="dim" role="status">{reading}</span></div>}
      </div>
      {list && <section className="saveSection runtimeSection componentGroup" aria-label="Downloaded files">
        {rows.length === 0 ? <div className="empty">No downloaded files.</div> : <div className="saveList">
          {rows.map(({ component, item }) => {
            const name = componentItemName(component, item), cpu = componentCpuLabel(item);
            const size = componentSizeText(item), source = componentSourceText(item);
            const removing = busy === `${component.id}:${item.id}`;
            return <div className="saveRow" key={`${component.id}:${item.id}`} data-component-id={component.id} data-component-item={item.id}>
              <div className="saveRowMain">
                <div className="saveName">
                  <span title={item.identity || undefined}>{name}</span>
                  {component.description && <HelpTip label={`About ${component.label}`}>{component.description}</HelpTip>}
                  {cpu && <span className="badge" title="CPU architecture">{cpu}</span>}
                  {item.status && <StatusBadge tone="warning">{item.status}</StatusBadge>}
                </div>
                <div className="dim componentMeta">{[size, source].filter(Boolean).join(" · ")}</div>
                <div className="dim">{item.users.length ? `Used by ${item.users.join(", ")}` : "Not used by an installed runtime"}</div>
                {!item.removable && item.removeReason && <div className="dim">{item.removeReason}</div>}
              </div>
              <div className="saveRowActions">
                {refreshRows.has(`${component.id}:${item.id}`) && <button type="button"
                  className={`btn iconOnly runtimeRefresh${busy === `refresh:${component.id}` ? " refreshing" : ""}`} disabled={Boolean(busy)}
                  title={`Refresh ${component.label}`} aria-label={`Refresh ${component.label}`} onClick={() => void refresh(component)}><RefreshIcon /></button>}
                {item.path && <button type="button" className="btn iconOnly" disabled={Boolean(busy)} title="Show in Finder"
                  aria-label={`Show ${name} in Finder`} onClick={() => void reveal(component, item)}><FolderIcon /></button>}
                <button type="button" className="btn iconOnly danger" disabled={Boolean(busy) || !confirmed || !item.removable}
                  title={!item.removable ? item.removeReason || "This file cannot be deleted here." : confirmed ? "Delete" : reading}
                  aria-label={removing ? `Deleting ${name}` : `Delete ${name}`}
                  onClick={() => void remove(component, item)}><TrashIcon /></button>
              </div>
            </div>;
          })}
        </div>}
      </section>}
    </div>
  </div>;
}
