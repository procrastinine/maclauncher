import React, { useEffect, useMemo, useState } from "react";
import type { ReShadeFilter } from "../types";
import { ReShadeFilterLibrary, type ReShadeFilterApi } from "./ReShadeFilterLibrary";
import type { RuntimeTabSection } from "./runtime-tabs-model";
import { GRAPHICS_TYPES, implementationsFor, type GraphicsType } from "../../../../modules/shared/effects/contracts.mjs";
import {importedShaderImplementation} from "../shader-implementations";

// Older callers name resize directions; an unknown or retired type shows all.
function libraryType(value?: string): GraphicsType | "all" {
  const type = value === "downscaling" ? "downsample" : value === "upscaling" ? "upscale" : value;
  return GRAPHICS_TYPES.some(row => row.id === type) ? type as GraphicsType : "all";
}

export function ShaderLibraryFamily({active, collections, selectedId, navigationKey, shaderCategory, filters, filtersError, api, onSelectCollection, children}: {
  active: boolean; collections: RuntimeTabSection[]; selectedId?: string; navigationKey?: number; shaderCategory?: string;
  filters: ReShadeFilter[]; filtersError?: string; api?: Partial<ReShadeFilterApi>;
  onSelectCollection: (choice: RuntimeTabSection) => void; children: React.ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"library" | "collections">("library");
  const [category, setCategory] = useState<GraphicsType | "all">(() => libraryType(shaderCategory));
  const implementations=useMemo(()=>filters.map(importedShaderImplementation),[filters]);
  const shaderTypes=useMemo(()=>GRAPHICS_TYPES.filter(type=>implementationsFor(type.id,implementations).length>0),[implementations]);
  useEffect(() => {setCategory(libraryType(shaderCategory));}, [shaderCategory, navigationKey]);
  if (!active) return <>{children}</>;
  // The search belongs to the Library tab; Collections always lists every collection.
  const selected = collections.find(row => row.id === selectedId) || collections[0];
  const visibleIds=new Set((category==="all"?[]:implementationsFor(category,implementations)).map(row=>row.template.kind==="shader"?row.template.shader.preset:""));
  const visibleFilters = category === "all" ? filters : filters.filter(filter=>visibleIds.has(filter.presetId || `filter:${filter.id}`));
  return <section className="shaderLibraryFamily" aria-label="Shader library">
    <div className="settingsTabs shaderLibraryTabs" role="tablist" aria-label="Shaders" onKeyDown={event=>{
      if(["ArrowLeft","ArrowRight","Home","End"].includes(event.key)){event.preventDefault();const next=event.key==="Home"?"library":event.key==="End"?"collections":view==="library"?"collections":"library";
        setView(next);event.currentTarget.querySelector<HTMLButtonElement>(`#shader-${next === "library" ? "library" : "collections"}-tab`)?.focus();}
    }}>
      <button type="button" role="tab" id="shader-library-tab" aria-controls="shader-library-panel" aria-selected={view === "library"}
        tabIndex={view === "library"?0:-1} className={`settingsTab${view === "library" ? " active" : ""}`} onClick={() => setView("library")}>Library</button>
      <button type="button" role="tab" id="shader-collections-tab" aria-controls="shader-collections-panel" aria-selected={view === "collections"}
        tabIndex={view === "collections"?0:-1} className={`settingsTab${view === "collections" ? " active" : ""}`} onClick={() => setView("collections")}>Collections</button>
    </div>
    <div role="tabpanel" id="shader-library-panel" aria-labelledby="shader-library-tab" hidden={view !== "library"}>
    <ReShadeFilterLibrary filters={visibleFilters} filtersError={filtersError} api={api} showDownloads={false} query={query} compact
      toolbar={<div className="filterLibraryControls"><input id="shader-library-search" className="input" type="search" aria-label="Search shaders" placeholder="Search shaders" value={query}
        onChange={event=>setQuery(event.target.value)} onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();setQuery('');}}}/>
        <select id="shader-library-type" className="input" aria-label="Shader type" value={category} onChange={event=>setCategory(libraryType(event.target.value))}>
          <option value="all">All types</option>{GRAPHICS_TYPES.filter(type=>shaderTypes.includes(type)||type.id===category).map(type=><option key={type.id} value={type.id}>{type.label}</option>)}
        </select></div>}
      onImported={rows=>{const types=new Set(rows.map(row=>{const choice=importedShaderImplementation(row),listed=GRAPHICS_TYPES.filter(type=>implementationsFor(type.id,[choice]).length);return listed.length===1?listed[0].id:"all";}));setQuery("");setCategory(types.size===1?[...types][0]:"all");}} />
    </div>
    <div role="tabpanel" id="shader-collections-panel" aria-labelledby="shader-collections-tab" hidden={view !== "collections"}>
    {collections.length > 0 ? <section className="runtimeSectionCard shaderCollections">
      <div className="detailRow detailControlRow"><label className="detailLabel" htmlFor="shader-collection">Collection</label>
        <select id="shader-collection" className="input" value={selected?.id || ""}
          onChange={event => {const choice = collections.find(row => row.id === event.target.value);if (choice) onSelectCollection(choice);}}>
          {collections.map(row => <option key={row.id} value={row.id}>{row.section.label || row.label}</option>)}
        </select>
      </div>
      {selected?.id === selectedId && children}
    </section> : <p className="detailMeta">No collections available.</p>}
    </div>
  </section>;
}
