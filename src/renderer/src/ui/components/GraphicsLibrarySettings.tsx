import React, { useEffect, useState } from "react";
import type { ReShadeFilterApi } from "./ReShadeFilterLibrary";
import { ShaderLibrary } from "./ShaderLibraryFamily";
import { EffectsPresetManager } from "./EffectsPresetManager";
import { useGraphicsCatalog } from "../useGraphicsCatalog";

type GraphicsLibraryTab = "shaders" | "presets";
const TABS: Array<{ id: GraphicsLibraryTab; label: string }> = [{ id: "shaders", label: "Shaders" }, { id: "presets", label: "Presets" }];

/** The Graphics settings section a request names: `graphics`, `graphics:shaders`, `graphics:presets` or `graphics:presets:<preset id>`. */
export function graphicsLibraryRoute(sectionId?: string | null): { tab: GraphicsLibraryTab; presetId?: string } {
  const [, tab, ...preset] = String(sectionId || "").split(":");
  return /^presets?$/.test(tab || "") ? { tab: "presets", ...(preset.length ? { presetId: preset.join(":") } : {}) } : { tab: "shaders" };
}

// Settings → Graphics holds the shader library and the saved presets. Shader
// collections are downloads and stay in Runtimes → Effects → Shaders.
export function GraphicsLibrarySettings({ api, sectionId, shaderCategory, navigationKey }: {
  api?: Partial<ReShadeFilterApi>; sectionId?: string | null; shaderCategory?: string; navigationKey?: number;
}) {
  const route = graphicsLibraryRoute(sectionId);
  const [tab, setTab] = useState<GraphicsLibraryTab>(route.tab);
  useEffect(() => { setTab(graphicsLibraryRoute(sectionId).tab); }, [sectionId, navigationKey]);
  const catalog = useGraphicsCatalog(true);
  const select = (next: GraphicsLibraryTab, focus = false) => {
    setTab(next);
    if (focus && typeof document !== "undefined") document.getElementById(`graphics-${next}-tab`)?.focus();
  };
  return <div className="settingsSection graphicsLibrarySettings">
    <div className="settingsTitle">Graphics</div>
    <div className="settingsTabs" role="tablist" aria-label="Graphics" onKeyDown={event => {
      const index = TABS.findIndex(row => row.id === tab);
      const next = event.key === "Home" ? 0 : event.key === "End" ? TABS.length - 1
        : event.key === "ArrowRight" ? (index + 1) % TABS.length : event.key === "ArrowLeft" ? (index + TABS.length - 1) % TABS.length : -1;
      if (next < 0) return;
      event.preventDefault(); select(TABS[next].id, true);
    }}>
      {TABS.map(row => <button key={row.id} type="button" role="tab" id={`graphics-${row.id}-tab`} aria-controls={`graphics-${row.id}-panel`}
        aria-selected={tab === row.id} tabIndex={tab === row.id ? 0 : -1} className={`settingsTab${tab === row.id ? " active" : ""}`}
        onClick={() => select(row.id)}>{row.label}</button>)}
    </div>
    <div role="tabpanel" id={`graphics-${tab}-panel`} aria-labelledby={`graphics-${tab}-tab`}>
      {tab === "shaders" ? <ShaderLibrary navigationKey={navigationKey} shaderCategory={shaderCategory}
        filters={catalog?.shaderLibrary || catalog?.filters || []} filtersError={catalog?.shaderLibraryError || catalog?.filtersError} api={api} />
        : <EffectsPresetManager status={catalog} navigationKey={navigationKey} selectedId={route.tab === "presets" ? route.presetId : undefined} />}
    </div>
  </div>;
}
