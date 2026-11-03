import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LauncherViewHeader } from "./LauncherViewHeader";
import "./AppActionPicker.css";

export type AppActionPickerTarget = {
  id: string; label: string; detail?: string; icon?: string; preview?: boolean; previews?: string[];
  group?: { id: string; label: string; icon?: string };
  searchOnly?: boolean; // Shown only while the search matches it; the tile shows the app icon.
};
export type AppActionPickerModel = {
  title?: string | null;
  sections: Array<{ id: string; label: string; empty?: string; targets: AppActionPickerTarget[] }>;
  notice?: { message: string; link?: { label: string } };
  thumbnails: Record<string, string>;
};
export type AppActionPickerUpdate = { model?: AppActionPickerModel; thumbnails?: Record<string, string> };
export type AppActionPickerApi = {
  appActionPickerState(): Promise<AppActionPickerModel | null>;
  chooseAppActionTarget(targetId: string): Promise<boolean>;
  openAppActionPickerLink(): Promise<boolean>;
  onAppActionPicker(callback: (update: AppActionPickerUpdate) => void): () => void;
};

const matches = (target: AppActionPickerTarget, query: string) =>
  !query || [target.label, target.detail, target.group?.label].some(value => value?.toLocaleLowerCase().includes(query));

// Arrow keys move between tiles by position: across a row, or to the tile in
// the next or previous row nearest to the current one's center.
function nextTile(tiles: HTMLElement[], current: HTMLElement, key: string) {
  const index = tiles.indexOf(current);
  if (key === "ArrowLeft") return tiles[index - 1];
  if (key === "ArrowRight") return tiles[index + 1];
  const box = current.getBoundingClientRect(), center = box.left + box.width / 2;
  const rows = tiles.filter(tile => {
    const top = tile.getBoundingClientRect().top;
    return key === "ArrowDown" ? top > box.top + 1 : top < box.top - 1;
  });
  if (!rows.length) return undefined;
  const rowTop = key === "ArrowDown" ? Math.min(...rows.map(tile => tile.getBoundingClientRect().top))
    : Math.max(...rows.map(tile => tile.getBoundingClientRect().top));
  return rows.filter(tile => Math.abs(tile.getBoundingClientRect().top - rowTop) < 1).reduce((best, tile) => {
    const value = tile.getBoundingClientRect(), distance = Math.abs(value.left + value.width / 2 - center);
    const bestBox = best.getBoundingClientRect();
    return distance < Math.abs(bestBox.left + bestBox.width / 2 - center) ? tile : best;
  });
}

function Tile({ target, thumbnails, onChoose }: { target: AppActionPickerTarget; thumbnails: Record<string, string>; onChoose: (id: string) => void }) {
  const images = target.previews ? target.previews.map(id => thumbnails[id]).filter(Boolean) : thumbnails[target.id] ? [thumbnails[target.id]] : [];
  return <button type="button" className="pickerTile" data-picker-tile="" onClick={() => onChoose(target.id)}
    aria-label={[target.group?.label, target.label, target.detail].filter(Boolean).join(", ")}>
    <span className={"pickerPreview" + (images.length > 1 ? " pickerPreviewMany" : "")} aria-hidden="true">
      {images.length ? images.map((image, index) => <img key={index} src={image} alt="" draggable={false} />)
        : (target.icon || target.group?.icon) ? <img className="pickerPreviewIcon" src={target.icon || target.group?.icon} alt="" draggable={false} />
        : <span className="pickerPreviewEmpty">{target.preview ? "" : target.label.slice(0, 1)}</span>}
    </span>
    <span className="pickerTileLabel" title={target.label}>{target.label}</span>
    {target.detail && <span className="pickerTileDetail">{target.detail}</span>}
  </button>;
}

export function AppActionPicker({ api }: { api: AppActionPickerApi }) {
  const [model, setModel] = useState<AppActionPickerModel | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const search = useRef<HTMLInputElement>(null), body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let active = true;
    const stop = api.onAppActionPicker(update => {
      if (update.model) setModel(update.model);
      else if (update.thumbnails) setModel(current => current ? { ...current, thumbnails: { ...current.thumbnails, ...update.thumbnails } } : current);
    });
    void api.appActionPickerState().then(value => { if (active && value) setModel(current => current || value); }).catch(() => {});
    return () => { active = false;stop(); };
  }, [api]);
  const onChoose = useCallback((id: string) => {
    setError(null);
    void api.chooseAppActionTarget(id).catch((value: any) => setError(String(value?.message || value)));
  }, [api]);
  const needle = query.trim().toLocaleLowerCase();
  const sections = useMemo(() => (model?.sections || []).map(section => ({ ...section, targets: section.targets.filter(target => (needle || !target.searchOnly) && matches(target, needle)) })), [model, needle]);
  const onKeyDown = (event: React.KeyboardEvent) => {
    if ((event.metaKey && event.key.toLowerCase() === "f") || (event.key === "/" && event.target !== search.current)) {
      event.preventDefault();search.current?.focus();search.current?.select();return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (query) setQuery("");else window.close();
      return;
    }
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    const tiles = Array.from(body.current?.querySelectorAll<HTMLElement>("[data-picker-tile]") || []);
    if (!tiles.length) return;
    const active = document.activeElement as HTMLElement | null;
    if (active === search.current) {
      if (event.key !== "ArrowDown") return;
      event.preventDefault();tiles[0].focus();return;
    }
    if (!active || !tiles.includes(active)) return;
    event.preventDefault();
    const next = nextTile(tiles, active, event.key);
    if (next) next.focus();else if (event.key === "ArrowUp") search.current?.focus();
  };
  const title = model?.title || "Choose";
  return <main className="launcherView appActionPicker" aria-labelledby="app-action-picker-title" onKeyDown={onKeyDown}>
    <LauncherViewHeader title={title} titleId="app-action-picker-title">
      <input ref={search} className="input pickerSearch" type="search" placeholder="Search apps and windows" aria-label="Search apps and windows"
        value={query} onChange={event => setQuery(event.target.value)} autoFocus />
    </LauncherViewHeader>
    {model?.notice && <div className="pickerNotice" role="status">
      <span>{model.notice.message}</span>
      {model.notice.link && <button type="button" className="btn small" onClick={() => { void api.openAppActionPickerLink().catch(() => {}); }}>{model.notice.link.label}</button>}
    </div>}
    {error && <div className="pickerNotice pickerError" role="alert">{error}</div>}
    <div className="launcherViewBody pickerBody" ref={body}>
      {!model && <div className="empty" role="status">Loading…</div>}
      {sections.map(section => {
        const groups: Array<{ id: string; label?: string; icon?: string; targets: AppActionPickerTarget[] }> = [];
        for (const target of section.targets) {
          const key = target.group?.id || "";
          const last = groups[groups.length - 1];
          if (last && last.id === key) last.targets.push(target);
          else groups.push({ id: key, label: target.group?.label, icon: target.group?.icon, targets: [target] });
        }
        return <section className="pickerSection" key={section.id} aria-labelledby={`picker-section-${section.id}`}>
          <h2 className="pickerSectionTitle" id={`picker-section-${section.id}`}>{section.label}</h2>
          {!section.targets.length && <div className="pickerEmpty dim">{needle ? "No matches." : section.empty || "None."}</div>}
          {groups.map(group => <div className="pickerGroup" key={group.id || "ungrouped"} role="group" aria-label={group.label || section.label}>
            {group.label && <div className="pickerGroupTitle">
              {group.icon && <img src={group.icon} alt="" width={16} height={16} draggable={false} />}
              <span>{group.label}</span>
            </div>}
            <div className="pickerGrid">
              {group.targets.map(target => <Tile key={target.id} target={target} thumbnails={model?.thumbnails || {}} onChoose={onChoose} />)}
            </div>
          </div>)}
        </section>;
      })}
    </div>
  </main>;
}
