import React, { memo } from "react";
import type { GamePreparation, LauncherState, ModuleManifest, RecentGame } from "../types";
import {
  formatModuleBadge,
  formatRuntimeLabel,
  formatWhen,
  normalizeRuntimeSettings,
  resolveDefaultRuntime,
  resolveModuleRuntimeSettings,
  resolveRuntimeSettingsSchema,
  runtimeSettingsEqual
} from "../ui-helpers";
import { GameActions } from "./GameActions";
import { GameIcon } from "./GameIcon";
import { StarIcon } from "../icons";
import type { LibraryActions } from "./library-actions";
import { gameRowSelectionAction } from "./game-row-selection-model";

type GameRowProps = {
  g: RecentGame;
  moduleInfo: ModuleManifest | null;
  moduleSettings: LauncherState["moduleSettings"];
  runtimeDefaults: LauncherState["runtimeDefaults"];
  isRunning: boolean;
  preparation?: GamePreparation;
  showIcons: boolean;
  showNonDefaultTags: boolean;
  selected: boolean;
  dragging: boolean;
  dragDisabled: boolean;
  favorite: boolean;
  selectionMode?: boolean;
  selectionDisabled?: boolean;
  checked?: boolean;
  missing?: boolean;
  actions: LibraryActions;
  onSelect: (gamePath: string, options?: { toggleSelection: boolean; range: boolean }) => void;
  onDragStart: (event: React.DragEvent, gamePath: string) => void;
  onDragEnd: () => void;
};

export const GameRow = memo(function GameRow({
  g, moduleInfo, moduleSettings, runtimeDefaults, isRunning, preparation, showIcons,
  showNonDefaultTags, selected, dragging, dragDisabled, favorite, actions, onSelect,
  selectionMode = false, selectionDisabled = false, checked = false, missing = false,
  onDragStart, onDragEnd
}: GameRowProps) {
  const defaultRuntime = resolveDefaultRuntime(moduleInfo, moduleSettings[g.moduleId] || {});
  const runtimeIsCustom = Boolean(defaultRuntime && g.runtimeId !== defaultRuntime);
  const runtimeSchema = resolveRuntimeSettingsSchema(moduleInfo, g.runtimeId);
  const moduleRuntimeSettings = runtimeSchema
    ? resolveModuleRuntimeSettings({ moduleSettings, runtimeDefaults }, g.moduleId, moduleInfo, g.runtimeId)
    : null;
  const gameRuntimeOverrides = g.runtimeSettings?.[g.runtimeId];
  const normalizedGameOverride = runtimeSchema && gameRuntimeOverrides && typeof gameRuntimeOverrides === "object"
    ? normalizeRuntimeSettings(runtimeSchema, gameRuntimeOverrides, moduleRuntimeSettings || {})
    : null;
  const runtimeSettingsModified = runtimeSchema && moduleRuntimeSettings && normalizedGameOverride
    ? !runtimeSettingsEqual(runtimeSchema, normalizedGameOverride, moduleRuntimeSettings)
    : false;
  function activate(event: React.MouseEvent) {
    const action = gameRowSelectionAction({ selectionMode, selectionDisabled, metaKey: event.metaKey, shiftKey: event.shiftKey });
    if (action.kind === "none") return;
    if (action.kind === "toggle") {
      if (selectionMode) actions.onToggleSelection(g.gamePath, action.range);
      else onSelect(g.gamePath, { toggleSelection: true, range: action.range });
    } else onSelect(g.gamePath);
  }

  return (
    <li className={["gameItem", selected ? "selected" : "", dragging ? "dragging" : ""].filter(Boolean).join(" ")}
      onClick={event => {
        // Child controls keep their own behavior; padding and open row space
        // share the identity button's selection behavior.
        const target = event.target as Element;
        if (target.closest('button, a, input, select, textarea, [role="button"], [role="link"]')) return;
        activate(event);
      }}>
      <div className={["gameRow", !dragDisabled || selectionMode ? "withHandle" : ""].filter(Boolean).join(" ")}>
        {selectionMode ? <input type="checkbox" className="gameCheckbox" checked={checked} disabled={selectionDisabled}
          aria-label={`Select ${g.name}`}
          onChange={event => actions.onToggleSelection(g.gamePath, Boolean((event.nativeEvent as MouseEvent).shiftKey))}
          onKeyDown={event => { if (event.shiftKey && event.key === " ") { event.preventDefault(); actions.onToggleSelection(g.gamePath, true); } }} /> : !dragDisabled && <button
          type="button"
          className={["dragHandle", dragDisabled ? "disabled" : ""].filter(Boolean).join(" ")}
          draggable={!dragDisabled}
          disabled={dragDisabled}
          onDragStart={event => onDragStart(event, g.gamePath)}
          onDragEnd={onDragEnd}
          onKeyDown={event => {
            if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
              event.preventDefault();
              void actions.onMoveGame(g.gamePath, event.key === "ArrowUp" ? -1 : 1);
            }
          }}
          title={dragDisabled ? "Use Default sort to reorder" : "Drag to reorder, or use Option–Up / Option–Down"}
          aria-label={`Reorder ${g.name}`}
        >
          <span aria-hidden="true">⋮⋮</span>
        </button>}
        <button
          type="button"
          className={["favoriteButton", favorite ? "active" : ""].filter(Boolean).join(" ")}
          onClick={() => actions.onSetFavorite(g.gamePath, !favorite)}
          aria-label={`${favorite ? "Remove" : "Add"} ${g.name} ${favorite ? "from" : "to"} favorites`}
          aria-pressed={favorite}
          title={favorite ? "Remove from favorites" : "Add to favorites"}
        >
          <StarIcon filled={favorite} />
        </button>
        <button
          type="button"
          className="gameSelect"
          disabled={selectionMode && selectionDisabled}
          aria-label={selectionMode ? `Toggle selection for ${g.name}` : `Show details for ${g.name}`}
          aria-pressed={selectionMode ? checked : selected}
          aria-controls={selectionMode ? undefined : "game-details"}
          data-game-path={g.gamePath}
          onClick={activate}
        >
          {showIcons && <GameIcon game={g} moduleInfo={moduleInfo} />}
          <span className="gameMain">
            <span className="gameTopLine">
              <span className="gameName" title={g.name}>{g.name}</span>
              <span className="gameTags">
              {showNonDefaultTags && runtimeIsCustom && (
                <span className="badge badgeWarn" title={formatRuntimeLabel(g.runtimeId, moduleInfo)}>{formatRuntimeLabel(g.runtimeId, moduleInfo)}</span>
              )}
              {showNonDefaultTags && runtimeIsCustom && runtimeSettingsModified && (
                <span className="badge badgeWarn" title="Modified runtime settings">Modified</span>
              )}
              </span>
              <span className="badge">{formatModuleBadge(g.moduleShortLabel, g.moduleLabel, g.moduleId)}</span>
              {showNonDefaultTags && g.saveDirOverride && <span className="badge badgeAccent" title="Custom save location">Custom saves</span>}
            </span>
            <span className="gameBottomLine">
              <span className="lastPlayed" title={g.lastPlayedAt ? `Last played ${formatWhen(g.lastPlayedAt)}` : "Not played"}>
                {g.lastPlayedAt ? `Played ${new Date(g.lastPlayedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}` : "Not played"}
              </span>
              <span className="dot" aria-hidden="true">·</span>
              {missing && <span className="missingLabel">Missing</span>}
              <span className="mono ellipsis" title={g.gamePath}>{g.gamePath}</span>
            </span>
          </span>
        </button>
        <GameActions g={g} isRunning={isRunning} preparation={preparation} actions={actions} />
      </div>
    </li>
  );
});
