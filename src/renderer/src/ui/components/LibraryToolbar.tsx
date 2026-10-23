import React from "react";
import type { LibrarySort, LibrarySortMode } from "../../../../core/library-view.mjs";
import { XIcon } from "../icons";

export type LibraryScope = "all" | "favorites" | "running";

export function LibrarySearch({ query, onQueryChange }: { query: string; onQueryChange: (query: string) => void }) {
  return (
    <div className="librarySearch">
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path d="m16 16 5 5" stroke="currentColor" strokeWidth="1.8" />
      </svg>
      <input id="game-search-input" className="input" type="search" placeholder="Search games"
        aria-label="Search games" value={query} onChange={event => onQueryChange(event.target.value)} />
      {query ? <button className="searchClear" aria-label="Clear search" onClick={() => onQueryChange("")}><XIcon /></button>
        : <kbd aria-hidden="true">⌘F</kbd>}
    </div>
  );
}

export function LibraryToolbar({ sort, onSortChange, scope, onScopeChange, count,
  typesOpen, onToggleTypes, typesFiltered, hasTypes, inspectorOpen, hasSelection, onToggleInspector
}: {
  count: string;
  sort: LibrarySort; onSortChange: (sort: LibrarySort) => void;
  scope: LibraryScope; onScopeChange: (scope: LibraryScope) => void;
  typesOpen: boolean; onToggleTypes: () => void; typesFiltered: boolean; hasTypes: boolean;
  inspectorOpen: boolean; hasSelection: boolean; onToggleInspector: () => void;
}) {
  return (
    <div className="libraryToolbar">
      <div className="libraryToolbarControls">
        <select className="input scopeSelect" aria-label="Show games" value={scope}
          onChange={event => onScopeChange(event.target.value as LibraryScope)}>
          <option value="all">All games</option><option value="favorites">Favorites</option><option value="running">Running</option>
        </select>
        <button className={["btn", "small", typesFiltered ? "primary" : ""].join(" ")}
          disabled={!hasTypes} aria-label={typesOpen ? "Hide game types" : "Show game types"}
          aria-expanded={typesOpen} aria-controls="game-types-dropdown" onClick={onToggleTypes}>
          Game types{typesFiltered ? " •" : ""}
        </button>
        <span className="libraryCount">{count}</span>
        <label className="librarySort">
          <span>Sort</span>
          <select className="input" aria-label="Sort games" value={sort.mode}
            onChange={event => {
              const mode = event.target.value as LibrarySortMode;
              onSortChange({ mode, direction: mode === "recent" || mode === "added" ? "desc" : "asc" });
            }}>
            <option value="custom">Default</option><option value="recent">Last played</option>
            <option value="added">Date added</option><option value="alphabetical">Alphabetical</option><option value="type">Game type</option>
          </select>
        </label>
        {sort.mode !== "custom" && <button className="btn small iconOnly" title={sort.direction === "asc" ? "Ascending; click to reverse" : "Descending; click to reverse"}
          aria-label="Reverse sort direction" onClick={() => onSortChange({ ...sort, direction: sort.direction === "asc" ? "desc" : "asc" })}>
          <span aria-hidden="true">{sort.direction === "asc" ? "↑" : "↓"}</span>
        </button>}
        {hasSelection && <button className="btn small inspectorToggle" aria-controls="game-details"
          aria-expanded={inspectorOpen} onClick={onToggleInspector}>Details</button>}
      </div>
    </div>
  );
}
