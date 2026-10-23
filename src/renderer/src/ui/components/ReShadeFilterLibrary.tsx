import React, { useEffect, useRef, useState } from "react";
import type { LauncherApi, ReShadeFilter } from "../types";
import { FolderIcon } from "../icons";
import { formatUserError } from "../ui-helpers";
import { HelpTip } from "./HelpTip";
import { shaderFamily, shaderFormat, type ShaderFamily } from "../shader-format";

export type ReShadeFilterApi = Pick<LauncherApi, "importReShadeFilters" | "updateReShadeFilter" | "removeReShadeFilter" | "pickReShadeFilterPath" | "openUtilityWindow">;

function FilterInput({ value, label, readOnly, path = false, onCommit }: {
  value: string; label: string; readOnly: boolean; path?: boolean; onCommit: (value: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(value);
  const [invalid, setInvalid] = useState(false);
  const focused = useRef(false);
  const dirty = useRef(false);
  const cancelBlur = useRef(false);
  const saved = useRef(value);
  saved.current = value;
  useEffect(() => { if (!focused.current || !dirty.current) { setDraft(value); setInvalid(false); dirty.current = false; } }, [value]);
  return <input type="text" className={`input filterLibraryInput${path ? " filterLibraryPath" : ""}`}
    aria-label={label} aria-invalid={invalid || undefined} title={draft}
    value={draft} readOnly={readOnly} spellCheck={false} autoComplete="off"
    onFocus={() => { focused.current = true; }}
    onChange={event => { dirty.current = true; setDraft(event.currentTarget.value); setInvalid(false); }}
    onBlur={event => {
      focused.current = false;
      if (cancelBlur.current) { cancelBlur.current = false; return; }
      const next = event.currentTarget.value;
      if (!dirty.current || next === value) { dirty.current = false; setDraft(value); return; }
      void onCommit(next).then(success => {
        setInvalid(!success);
        if (success && !focused.current) { dirty.current = false; setDraft(saved.current); }
      });
    }}
    onKeyDown={event => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
      else if (event.key === "Escape") {
        event.preventDefault(); cancelBlur.current = true; dirty.current = false; setDraft(value); setInvalid(false); event.currentTarget.blur();
      }
    }} />;
}

export function ReShadeFilterLibrary({ filters, filtersError, api, family, showDownloads = true }: {
  filters: ReShadeFilter[]; filtersError?: string; api?: Partial<ReShadeFilterApi>; family?: ShaderFamily; showDownloads?: boolean;
}) {
  const visibleFilters = family ? filters.filter(filter => shaderFamily(filter.format ?? shaderFormat(filter.path)) === family) : filters;
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string[]>([]);
  const pendingKeys = useRef(new Set<string>());
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const busy = pending.length > 0;
  const actionPending = pending.some(key => !key.startsWith("update:"));
  // A blur save can precede a row-button click. Keep that action and execute it
  // after the save, while coalescing repeated clicks on the same operation.
  function operate(key: string, action: () => Promise<void>) {
    if (pendingKeys.current.has(key)) return Promise.resolve(false);
    pendingKeys.current.add(key); setPending([...pendingKeys.current]);
    const work = queue.current.then(async () => {
      setError(null);
      try { await action(); return true; }
      catch (cause) { setError(formatUserError(cause)); return false; }
    }).finally(() => { pendingKeys.current.delete(key); setPending([...pendingKeys.current]); });
    queue.current = work;
    return work;
  }
  const update = (id: string, field: "name" | "path", value: string) => {
    if (!api?.updateReShadeFilter) return Promise.resolve(false);
    return operate(`update:${id}:${field}`, async () => {
      if (await api.updateReShadeFilter!(id, { [field]: value }) !== true) throw new Error("The filter could not be updated.");
    });
  };
  return <section className="settingsSection" aria-label="Shaders and filters">
    <div className="filterLibraryToolbar">
      <div className="settingsTitle">{family ? "Filters" : "Shaders and filters"} <HelpTip label="About the filter library">ReShade .fx, libretro .slangp or .slang, and MPV/libplacebo .glsl or .hook files appear in each game's preset list. Names and paths can be edited here. Removing a filter leaves its files in place.</HelpTip></div>
      <div className="detailActions">{showDownloads && <button type="button" className="btn" disabled={!api?.openUtilityWindow}
        onClick={() => void operate("download", async () => { await api!.openUtilityWindow!({ view: "runtimes", managerId: "graphics-shader-library" }); })}>Download shaders…</button>}
      <button type="button" className={family ? "btn primary" : "btn"} disabled={!api?.importReShadeFilters || actionPending}
        aria-busy={pending.includes("import")} onClick={() => void operate("import", async () => {
          const result = await api!.importReShadeFilters!(family);
          if (result !== null && !Array.isArray(result)) throw new Error("The filters could not be imported.");
        })}>{pending.includes("import") ? "Importing…" : "Import filter…"}</button></div>
    </div>
    {(error || filtersError) && <p className="error filterLibraryError" role="alert">{error || filtersError}</p>}
    <div className="filterLibraryScroll" role="region" aria-label="Imported shaders and filters" tabIndex={0} aria-busy={busy}>
      <table className="filterLibraryTable">
        <colgroup><col className="filterLibraryNameColumn" /><col /><col className="filterLibraryActionsColumn" /></colgroup>
        <thead><tr><th scope="col">Name</th><th scope="col">Path</th><th scope="col">Actions</th></tr></thead>
        <tbody>{visibleFilters.map(filter => <tr key={filter.id}>
          <td><FilterInput value={filter.name} label={`Filter name: ${filter.name}`} readOnly={!api?.updateReShadeFilter || busy}
            onCommit={value => update(filter.id, "name", value)} /></td>
          <td><div className="filterLibraryPathControl">
            <FilterInput value={filter.path} path label={`Filter path: ${filter.name}`} readOnly={!api?.updateReShadeFilter || busy}
              onCommit={value => update(filter.id, "path", value)} />
            <button type="button" className="btn small iconOnly" title="Replace file…" aria-label={`Replace file for ${filter.name}`}
              aria-busy={pending.includes(`replace:${filter.id}`)} disabled={!api?.pickReShadeFilterPath || !api?.updateReShadeFilter || actionPending}
              onClick={() => void operate(`replace:${filter.id}`, async () => {
                const selected = await api!.pickReShadeFilterPath!(filter.id);
                if (selected === null) return;
                if (await api!.updateReShadeFilter!(filter.id, { path: selected }) !== true) throw new Error("The filter file could not be replaced.");
              })}><FolderIcon size="1em" /></button>
          </div>
          {!filter.available && <span className="filterLibraryUnavailable" role="status">{filter.reason || "The filter file is unavailable."}</span>}</td>
          <td><button type="button" className="btn small" aria-label={`Remove filter ${filter.name}`}
            aria-busy={pending.includes(`remove:${filter.id}`)} disabled={!api?.removeReShadeFilter || actionPending}
            onClick={() => void operate(`remove:${filter.id}`, async () => {
              if (await api!.removeReShadeFilter!(filter.id) !== true) throw new Error("The filter could not be removed.");
            })}>Remove</button></td>
        </tr>)}
        {!visibleFilters.length && <tr><td colSpan={3} className="dim">No imported filters.</td></tr>}
        </tbody>
      </table>
    </div>
  </section>;
}
