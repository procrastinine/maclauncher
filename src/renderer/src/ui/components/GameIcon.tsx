import React, { useState } from "react";
import type { ModuleManifest, RecentGame } from "../types";

// Vite bundles module-owned images locally; rendering never fetches engine art.
const moduleIcons = import.meta.glob<string>("../../../../modules/*/resources/icon.png", {
  eager: true, query: "?url", import: "default"
});

export function gameIconCandidates(game: Pick<RecentGame, "moduleId" | "iconUrl" | "iconSource">, moduleInfo: ModuleManifest | null) {
  const id = moduleInfo?.id || game.moduleId;
  const path = moduleInfo?.icon?.path || "resources/icon.png";
  const bundled = /^[a-z][a-z0-9-]*$/.test(id) ? moduleIcons[`../../../../modules/${id}/${path}`] : null;
  const candidates: { url: string; source: string }[] = [];
  if (game.iconUrl) candidates.push({ url: game.iconUrl, source: game.iconSource || "game" });
  if (bundled && !candidates.some(candidate => candidate.url === bundled)) candidates.push({ url: bundled, source: "module-default" });
  return candidates;
}

export function GameIcon({ game, moduleInfo, inspector = false }: {
  game: Pick<RecentGame, "moduleId" | "iconUrl" | "iconSource">;
  moduleInfo: ModuleManifest | null;
  inspector?: boolean;
}) {
  const [failedSources, setFailedSources] = useState<string[]>([]);
  const selected = gameIconCandidates(game, moduleInfo).find(candidate => !failedSources.includes(candidate.url));
  return <span className={["gameIcon", inspector ? "gameIconInspector" : "",
    selected?.source === "module-default" ? "gameIconEngine" : "", !selected ? "gameIconGeneric" : ""].filter(Boolean).join(" ")}
    aria-hidden="true" data-icon-source={selected?.source || "generic"}>
    {selected ? <img src={selected.url} alt="" loading={inspector ? "eager" : "lazy"} className="gameIconImage"
      onError={() => setFailedSources(previous => [...previous, selected.url])} /> :
      <svg viewBox="0 0 24 24" width="24" height="24" focusable="false">
        <path d="M7.5 7h9c2 0 3 1.6 3.5 4l1 5.1c.5 2.5-2.3 3.8-4 1.9l-2-2H9l-2 2c-1.7 1.9-4.5.6-4-1.9L4 11c.5-2.4 1.5-4 3.5-4Z"
          fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        <path d="M8 10v5m-2.5-2.5h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="16" cy="11" r="1" fill="currentColor" /><circle cx="18" cy="14" r="1" fill="currentColor" />
      </svg>}
  </span>;
}
