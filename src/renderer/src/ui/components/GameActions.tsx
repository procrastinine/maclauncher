import React, { memo } from "react";
import type { GamePreparation, RecentGame } from "../types";
import type { LibraryActions } from "./library-actions";
import { formatDownloadPercent } from "../ui-helpers";

function preparationLabel(preparation: GamePreparation) {
  if (preparation.phase === "remove") return "Removing";
  if (preparation.phase !== "install") return "Starting";
  const percent = typeof preparation.percent === "number" && Number.isFinite(preparation.percent)
    ? Math.floor(Math.max(0, Math.min(100, preparation.percent)))
    : typeof preparation.downloaded === "number" && Number.isFinite(preparation.downloaded) &&
      typeof preparation.total === "number" && Number.isFinite(preparation.total)
      ? formatDownloadPercent({ downloaded: preparation.downloaded, total: preparation.total }) : null;
  return percent === null ? "Installing" : `Installing ${percent}%`;
}

type PlayButtonProps = {
  g: RecentGame;
  isRunning: boolean;
  onPlay: LibraryActions["onPlay"];
  onStop: LibraryActions["onStop"];
  showLabel?: boolean;
  preparation?: GamePreparation;
};

export const PlayButton = memo(function PlayButton({ g, isRunning, onPlay, onStop, showLabel, preparation }: PlayButtonProps) {
  const waiting = Boolean(preparation && !isRunning);
  const launchUnavailable = !isRunning && g.moduleSupports?.launch === false;
  const label = waiting ? preparationLabel(preparation!) : isRunning ? "Stop" : "Play";
  return (
      <button
        className={[
          "btn",
          showLabel ? "small" : "iconOnly",
          isRunning ? "danger" : "primary"
        ].join(" ")}
        onClick={() =>
          isRunning ? onStop(g.gamePath) : onPlay(g.gamePath)
        }
        disabled={waiting || launchUnavailable}
        title={launchUnavailable ? "Launch unavailable for this game" : label}
        aria-label={`${label} ${g.name}`}
        aria-busy={waiting || undefined}
      >
        {waiting ? <span className="gameLaunchSpinner" aria-hidden="true" /> : <svg
          viewBox="0 0 24 24"
          width="18"
          height="18"
          aria-hidden="true"
          focusable="false"
        >
          {isRunning ? (
            <path
              fill="currentColor"
              d="M6 6h12v12H6z"
            />
          ) : (
            <path
              fill="currentColor"
              d="M8 5v14l11-7z"
            />
          )}
        </svg>}
        {showLabel && label}
      </button>
  );
});

export const GameActions = memo(function GameActions({ g, isRunning, actions, inspector = false, preparation }: {
  g: RecentGame;
  isRunning: boolean;
  actions: LibraryActions;
  inspector?: boolean;
  preparation?: GamePreparation;
}) {
  const { onPlay, onStop, onOpenSaveTools, openCheats, onCreateCommand, onForgetGame } = actions;
  const canEditSaves = g.moduleSupports?.saveEditing !== false || g.moduleSupports?.saveLocation === true;
  const canUseCheats = g.moduleSupports?.cheats === true;
  const canLaunch = g.moduleSupports?.launch !== false;
  const removing = preparation?.phase === "remove";
  return (
    <div className={`gameActions${inspector ? " inspectorGameActions" : ""}`}>
      <PlayButton g={g} isRunning={isRunning} onPlay={onPlay} onStop={onStop} showLabel={inspector} preparation={preparation} />
      {preparation && !isRunning && !inspector && <span className="gameLaunchStatus" role="status">{preparationLabel(preparation)}</span>}
      {(!inspector || canEditSaves) &&
      <button
        className="btn small"
        title={
          canEditSaves
            ? "Save tools"
            : "Save tools not available for this game type"
        }
        onClick={() => onOpenSaveTools(g)}
        disabled={!canEditSaves || removing}
      >
        {inspector ? g.moduleSupports?.saveEditing === true ? "Edit saves" : "Save tools" : "Saves"}
      </button>}
      {(!inspector || canUseCheats) &&
      <button
        className="btn small"
        title={
          canUseCheats
            ? "Cheats"
            : "Cheats not available for this game type"
        }
        onClick={() => openCheats(g)}
        disabled={!canUseCheats || removing}
      >
        Cheats
      </button>}
      <button
        className="btn small"
        title={canLaunch ? "Create a .command shortcut" : "Launch shortcut unavailable for this game"}
        disabled={!canLaunch || removing}
        onClick={() => onCreateCommand(g.gamePath)}
      >
        Shortcut
      </button>
      <button
        className="btn iconOnly danger forgetAction"
        title={removing ? "Removing" : isRunning || preparation ? "Stop or finish launching before removal" : "Forget game"}
        aria-label={`${removing ? "Removing" : "Forget"} ${g.name}`}
        aria-busy={removing || undefined}
        disabled={isRunning || Boolean(preparation)}
        onClick={() => onForgetGame(g.gamePath)}
      >
        <svg
          viewBox="0 0 24 24"
          width="18"
          height="18"
          aria-hidden="true"
          focusable="false"
        >
          <path
            fill="currentColor"
            d="M9 3h6l1 2h4v2H4V5h4l1-2zm1 6h2v9h-2V9zm4 0h2v9h-2V9zM6 7h12l-1 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L6 7z"
          />
        </svg>
      </button>
    </div>
  );
});
