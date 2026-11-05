import React, { useState } from "react";
import type { RecentGame } from "../types";

// The main process resolves each game's icon and falls back to the module's own
// icon file, so the renderer bundles no copies of module artwork.
export function gameIconCandidates(game: Pick<RecentGame, "iconUrl" | "iconSource">) {
  return game.iconUrl ? [{ url: game.iconUrl, source: game.iconSource || "game" }] : [];
}

// A pending icon keeps its empty tile instead of flashing the generic glyph.
export function GameIcon({ game, inspector = false }: {
  game: Pick<RecentGame, "iconUrl" | "iconSource" | "iconPending">;
  inspector?: boolean;
}) {
  const [failedSources, setFailedSources] = useState<string[]>([]);
  const selected = gameIconCandidates(game).find(candidate => !failedSources.includes(candidate.url));
  const pending = !selected && game.iconPending === true;
  return <span className={["gameIcon", inspector ? "gameIconInspector" : "",
    selected?.source === "module-default" ? "gameIconEngine" : "", !selected && !pending ? "gameIconGeneric" : ""].filter(Boolean).join(" ")}
    aria-hidden="true" data-icon-source={selected?.source || (pending ? "pending" : "generic")}>
    {pending ? null : selected ? <img src={selected.url} alt="" loading={inspector ? "eager" : "lazy"} className="gameIconImage"
      onError={() => setFailedSources(previous => [...previous, selected.url])} /> :
      <svg viewBox="0 0 24 24" width="24" height="24" focusable="false">
        <path d="M7.5 7h9c2 0 3 1.6 3.5 4l1 5.1c.5 2.5-2.3 3.8-4 1.9l-2-2H9l-2 2c-1.7 1.9-4.5.6-4-1.9L4 11c.5-2.4 1.5-4 3.5-4Z"
          fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        <path d="M8 10v5m-2.5-2.5h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="16" cy="11" r="1" fill="currentColor" /><circle cx="18" cy="14" r="1" fill="currentColor" />
      </svg>}
  </span>;
}
