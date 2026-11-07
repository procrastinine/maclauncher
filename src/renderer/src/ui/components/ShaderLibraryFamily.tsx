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

/** Settings → Graphics → Shaders: one searchable table of every included, collection and imported shader. */
export function ShaderLibrary({navigationKey, shaderCategory, filters, filtersError, api}: {
  navigationKey?: number; shaderCategory?: string; filters: ReShadeFilter[]; filtersError?: string; api?: Partial<ReShadeFilterApi>;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<GraphicsType | "all">(() => libraryType(shaderCategory));
  const implementations=useMemo(()=>filters.map(importedShaderImplementation),[filters]);
  const shaderTypes=useMemo(()=>GRAPHICS_TYPES.filter(type=>implementationsFor(type.id,implementations).length>0),[implementations]);
  useEffect(() => {setCategory(libraryType(shaderCategory));}, [shaderCategory, navigationKey]);
  const visibleIds=new Set((category==="all"?[]:implementationsFor(category,implementations)).map(row=>row.template.kind==="shader"?row.template.shader.preset:""));
  const visibleFilters = category === "all" ? filters : filters.filter(filter=>visibleIds.has(filter.presetId || `filter:${filter.id}`));
  return <ReShadeFilterLibrary filters={visibleFilters} filtersError={filtersError} api={api} query={query} compact
    toolbar={<div className="filterLibraryControls"><input id="shader-library-search" className="input" type="search" aria-label="Search shaders" placeholder="Search shaders" value={query}
      onChange={event=>setQuery(event.target.value)} onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();setQuery('');}}}/>
      <select id="shader-library-type" className="input" aria-label="Shader type" value={category} onChange={event=>setCategory(libraryType(event.target.value))}>
        <option value="all">All types</option>{GRAPHICS_TYPES.filter(type=>shaderTypes.includes(type)||type.id===category).map(type=><option key={type.id} value={type.id}>{type.label}</option>)}
      </select></div>}
    onImported={rows=>{const types=new Set(rows.map(row=>{const choice=importedShaderImplementation(row),listed=GRAPHICS_TYPES.filter(type=>implementationsFor(type.id,[choice]).length);return listed.length===1?listed[0].id:"all";}));setQuery("");setCategory(types.size===1?[...types][0]:"all");}} />;
}

/** Runtimes → Effects → Shaders: the downloadable shader collections, one at a time. */
export function ShaderCollections({active, collections, selectedId, onSelectCollection, children}: {
  active: boolean; collections: RuntimeTabSection[]; selectedId?: string;
  onSelectCollection: (choice: RuntimeTabSection) => void; children: React.ReactNode;
}) {
  if (!active) return <>{children}</>;
  const selected = collections.find(row => row.id === selectedId) || collections[0];
  return <section className="shaderLibraryFamily" aria-label="Shader collections">
    {collections.length > 0 ? <section className="runtimeSectionCard shaderCollections">
      <div className="detailRow detailControlRow"><label className="detailLabel" htmlFor="shader-collection">Collection</label>
        <select id="shader-collection" className="input" value={selected?.id || ""}
          onChange={event => {const choice = collections.find(row => row.id === event.target.value);if (choice) onSelectCollection(choice);}}>
          {collections.map(row => <option key={row.id} value={row.id}>{row.section.label || row.label}</option>)}
        </select>
      </div>
      {selected?.id === selectedId && children}
    </section> : <p className="detailMeta">No collections available.</p>}
  </section>;
}
