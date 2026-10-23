import React, { useEffect, useState } from "react";
import type { ReShadeFilter } from "../types";
import { shaderFamilies, type ShaderFamily } from "../shader-format";
import { ReShadeFilterLibrary, type ReShadeFilterApi } from "./ReShadeFilterLibrary";
import { ScrollableTabStrip } from "./ScrollableTabStrip";
import { runtimeTabMovement, type RuntimeTabSection } from "./runtime-tabs-model";

export function ShaderLibraryFamily({ active, collections, selectedId, requestedSectionId, navigationKey,
  filters, filtersError, api, onSelectCollection, children }: {
  active: boolean; collections: RuntimeTabSection[]; selectedId?: string;
  requestedSectionId?: string | null; navigationKey?: number;
  filters: ReShadeFilter[]; filtersError?: string; api?: Partial<ReShadeFilterApi>;
  onSelectCollection: (choice: RuntimeTabSection) => void; children: React.ReactNode;
}) {
  const requestedFamily = () => shaderFamilies.find(family => family.id === collections.find(row => row.sectionId === requestedSectionId)?.section.shaderFamily)?.id;
  const [family, setFamily] = useState<ShaderFamily>(() => requestedFamily() || "reshade");
  useEffect(() => {
    const requested = requestedFamily();
    if (active && requested && shaderFamilies.some(row => row.id === requested)) setFamily(requested);
  }, [navigationKey]);
  if (!active) return <>{children}</>;
  const choices = collections.filter(row => row.section.shaderFamily === family);
  const selected = choices.find(row => row.id === selectedId) || choices[0];
  function selectFamily(next: ShaderFamily) {
    setFamily(next);
    const current = collections.find(row => row.id === selectedId && row.section.shaderFamily === next);
    const choice = current || collections.find(row => row.section.shaderFamily === next);
    if (choice && choice.id !== selectedId) onSelectCollection(choice);
  }
  return <section className="shaderLibraryFamily" aria-label="Shader library">
    <ScrollableTabStrip label="Shader families" tabsClassName="runtimeTabs" selectedTabId={"shader-family-tab-" + family}>
      {shaderFamilies.map((row, index) => <button key={row.id} type="button" role="tab"
        id={"shader-family-tab-" + row.id} className={"runtimeTab" + (row.id === family ? " active" : "")}
        aria-selected={row.id === family} aria-controls={"shader-family-panel-" + row.id}
        tabIndex={row.id === family ? 0 : -1} onClick={() => selectFamily(row.id)}
        onKeyDown={event => {
          const next = runtimeTabMovement(event.key, index, shaderFamilies.length);
          if (next === null) return;
          event.preventDefault();selectFamily(shaderFamilies[next].id);
          document.getElementById("shader-family-tab-" + shaderFamilies[next].id)?.focus({ preventScroll: true });
        }}>{row.label}</button>)}
    </ScrollableTabStrip>
    <div role="tabpanel" id={"shader-family-panel-" + family} aria-labelledby={"shader-family-tab-" + family}>
      <ReShadeFilterLibrary filters={filters} filtersError={filtersError} api={api} family={family} showDownloads={false} />
      {choices.length > 0 && <details className="runtimeSectionCard shaderCollections">
        <summary>Collections</summary>
        <div className="detailRow detailControlRow"><label className="detailLabel" htmlFor="shader-collection">Collection</label>
          <select id="shader-collection" className="input" value={selected?.id || ""}
            onChange={event => { const choice = choices.find(row => row.id === event.target.value);if (choice) onSelectCollection(choice); }}>
            {choices.map(row => <option key={row.id} value={row.id}>{row.section.label || row.label}</option>)}
          </select>
        </div>
        {selected?.id === selectedId && children}
      </details>}
    </div>
  </section>;
}
