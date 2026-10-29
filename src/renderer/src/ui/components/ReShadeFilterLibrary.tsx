import React, { useEffect, useRef, useState } from "react";
import type { LauncherApi, ReShadeFilter } from "../types";
import { FolderIcon } from "../icons";
import { formatUserError } from "../ui-helpers";
import { HelpTip } from "./HelpTip";
import { shaderFamily, shaderFormat, shaderFormatLabel, type ShaderFamily } from "../shader-format";
import {droppedShaderPaths,shaderFileDrag} from "../shader-drop";
import {GRAPHICS_TYPES,implementationsFor} from "../../../../modules/shared/effects/contracts.mjs";
import {importedShaderImplementation} from "../shader-implementations";
import {implementationOutputSummary,implementationHelp} from "../../../../modules/shared/effects/presentation.mjs";

export type ReShadeFilterApi = Pick<LauncherApi, "importReShadeFilters" | "renameReShadeShader" | "updateReShadeFilter" | "removeReShadeFilter" | "pickReShadeFilterPath" | "openUtilityWindow" | "getPathForFile">;

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

export function ReShadeFilterLibrary({ filters, filtersError, api, family, showDownloads = true, query = "",onImported,toolbar,compact=false }: {
  filters: ReShadeFilter[]; filtersError?: string; api?: Partial<ReShadeFilterApi>; family?: ShaderFamily; showDownloads?: boolean; query?: string;
  onImported?:(filters:ReShadeFilter[])=>void;
  toolbar?:React.ReactNode;compact?:boolean;
}) {
  const search = query.trim().toLocaleLowerCase();
  const visibleFilters = filters.filter(filter => (!family || shaderFamily(filter.format ?? shaderFormat(filter.path)) === family) &&
    `${filter.name} ${filter.path} ${filter.format || ""}`.toLocaleLowerCase().includes(search));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string[]>([]);
  const [expanded,setExpanded]=useState(new Set<string>());
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
  const update = (filter: ReShadeFilter, field: "name" | "path", value: string) => {
    const rename = field === "name" && filter.presetId && api?.renameReShadeShader;
    if (!rename && !api?.updateReShadeFilter) return Promise.resolve(false);
    return operate(`update:${filter.id}:${field}`, async () => {
      const success = rename ? await rename(filter.presetId!, value) : await api!.updateReShadeFilter!(filter.filterId || filter.id, { [field]: value });
      if (success !== true) throw new Error("The filter could not be updated.");
    });
  };
  return <section className="settingsSection" aria-label="Shaders and filters"
    onDragOver={event=>{if(shaderFileDrag(event.dataTransfer)){event.preventDefault();event.dataTransfer.dropEffect="copy";}}}
    onDrop={event=>{
      if(event.defaultPrevented)return;
      const paths=droppedShaderPaths(event.dataTransfer,api?.getPathForFile?{getPathForFile:api.getPathForFile}:undefined);if(!paths.length)return;
      event.preventDefault();void operate("import",async()=>{
        if(!api?.importReShadeFilters)throw new Error("Shader import is unavailable.");
        const rows=await api.importReShadeFilters(undefined,paths);if(!Array.isArray(rows))throw new Error("The filters could not be imported.");onImported?.(rows);
      });
    }}>
    <div className="filterLibraryToolbar">
      {!compact&&<div className="settingsTitle">{family ? "Filters" : "Shaders and filters"} <HelpTip label="About the filter library">Shader files, color LUTs and compiled-effect descriptors share this library. Availability follows the selected graphics provider. Drop shader files to register their existing paths. Registrations preserve the original files.</HelpTip></div>}
      {toolbar}
      <div className="detailActions">{showDownloads && <button type="button" className="btn" disabled={!api?.openUtilityWindow}
        onClick={() => void operate("download", async () => { await api!.openUtilityWindow!({ view: "runtimes", managerId: "graphics-shader-library" }); })}>Download shaders…</button>}
      <button type="button" className={family ? "btn primary" : "btn"} disabled={!api?.importReShadeFilters || actionPending}
        aria-busy={pending.includes("import")} onClick={() => void operate("import", async () => {
          const result = await api!.importReShadeFilters!(family);
          if (result !== null && !Array.isArray(result)) throw new Error("The filters could not be imported.");
          if(Array.isArray(result))onImported?.(result);
        })}>{pending.includes("import") ? "Importing…" : "Import filter…"}</button></div>
    </div>
    {(error || filtersError) && <p className="error filterLibraryError" role="alert">{error || filtersError}</p>}
    <div className="filterLibraryScroll" role="region" aria-label="Shaders and filters" tabIndex={0} aria-busy={busy}>
      <table className="filterLibraryTable">
        <colgroup><col className="filterLibraryNameColumn" /><col className="filterLibraryTypeColumn"/><col className="filterLibraryOriginColumn"/><col className="filterLibraryActionsColumn" /></colgroup>
        <thead><tr><th scope="col">Name</th><th scope="col">Input → output</th><th scope="col">Origin / status</th><th scope="col">Actions</th></tr></thead>
        <tbody>{visibleFilters.map(filter => {
          const choice=importedShaderImplementation(filter),types=GRAPHICS_TYPES.filter(type=>implementationsFor(type.id,[choice]).length).map(type=>type.label);
          // Every image filter keeps its size, so its row carries no size tag.
          const typeLabel=types.join(' / ')||'Unknown size',summary=implementationOutputSummary(choice);
          const canRelocate=filter.canRelocate!==false,canRemove=filter.canRemove!==false,sourceOpen=expanded.has(filter.id);
          const format=({fx:'ReShade FX',slangp:'Slang preset',slang:'Slang',libplacebo:'mpv',isf:'ISF',magpie:'Magpie',native:'Native filter'})[filter.format??shaderFormat(filter.path)??'fx'];
          return <React.Fragment key={filter.id}><tr>
          <td><div className="filterLibraryNameControl"><FilterInput value={filter.name} label={`Filter name: ${filter.name}`} readOnly={!(filter.presetId && api?.renameReShadeShader || !filter.origin && api?.updateReShadeFilter || filter.origin === "imported" && api?.updateReShadeFilter) || busy}
            onCommit={value => update(filter, "name", value)} />
            {implementationHelp(choice)&&<HelpTip label={`About ${filter.name}`}>{implementationHelp(choice)}</HelpTip>}</div>
            <span className="filterLibraryFormat">{format}</span></td>
          <td>{typeLabel}{summary!==typeLabel&&!(typeLabel==='Image filter'&&summary==='Same size')&&<span className="filterLibraryFormat">{summary}</span>}</td>
          <td>{filter.origin==='collection'&&filter.collectionLabel?`${filter.collectionLabel}${/collection$/i.test(filter.collectionLabel)?'':' collection'}`:filter.origin?({included:'Included',collection:'Collection',imported:'Imported'})[filter.origin]:'Imported'}
            {!filter.available&&<span className="filterLibraryUnavailable">Unavailable<HelpTip label={`About ${filter.name} availability`}>{filter.reason||'The shader source is unavailable.'}</HelpTip></span>}</td>
          <td><div className="detailActions"><button type="button" className="btn small" aria-expanded={sourceOpen} aria-controls={`shader-source-${filter.id}`}
            onClick={()=>setExpanded(previous=>{const next=new Set(previous);if(next.has(filter.id))next.delete(filter.id);else next.add(filter.id);return next;})}>Source</button>
            {canRemove&&<button type="button" className="btn small iconOnly" aria-label={`Remove filter ${filter.name}`} title="Remove filter"
              aria-busy={pending.includes(`remove:${filter.id}`)} disabled={!api?.removeReShadeFilter||actionPending}
              onClick={()=>void operate(`remove:${filter.id}`,async()=>{if(await api!.removeReShadeFilter!(filter.filterId||filter.id)!==true)throw new Error("The filter could not be removed.");})}>×</button>}
          </div></td></tr>
          {sourceOpen&&<tr id={`shader-source-${filter.id}`} className="filterLibrarySource"><td colSpan={4}>
            <div className="filterLibraryPathControl"><FilterInput value={filter.path||''} path label={`Filter path: ${filter.name}`} readOnly={!canRelocate||!api?.updateReShadeFilter||busy}
              onCommit={value=>update(filter,'path',value)}/>
              {canRelocate&&<button type="button" className="btn small iconOnly" title="Replace file…" aria-label={`Replace file for ${filter.name}`}
                aria-busy={pending.includes(`replace:${filter.id}`)} disabled={!api?.pickReShadeFilterPath||!api?.updateReShadeFilter||actionPending}
                onClick={()=>void operate(`replace:${filter.id}`,async()=>{const selected=await api!.pickReShadeFilterPath!(filter.filterId||filter.id);if(selected===null)return;
                  if(await api!.updateReShadeFilter!(filter.filterId||filter.id,{path:selected})!==true)throw new Error("The filter file could not be replaced.");})}><FolderIcon size="1em"/></button>}
            </div>
          </td></tr>}
          </React.Fragment>;
        })}
        {!visibleFilters.length&&<tr><td colSpan={4} className="dim">{search?'No matching shaders.':'No shaders available.'}</td></tr>}
        </tbody>
      </table>
    </div>
  </section>;
}
