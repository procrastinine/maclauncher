import React, { memo } from "react";
import type { GamePreparation, RecentGame } from "../types";
import type { LibraryActions } from "./library-actions";
import { formatBytes, formatDownloadPercent } from "../ui-helpers";
import { TrashIcon } from "../icons";

function preparationLabel(preparation: GamePreparation) {
  if (preparation.phase === "remove") return "Removing";
  if (preparation.phase !== "install") return preparation.label || "Starting";
  const percent = typeof preparation.percent === "number" && Number.isFinite(preparation.percent)
    ? Math.floor(Math.max(0, Math.min(100, preparation.percent)))
    : typeof preparation.downloaded === "number" && Number.isFinite(preparation.downloaded) &&
      typeof preparation.total === "number" && Number.isFinite(preparation.total)
      ? formatDownloadPercent({ downloaded: preparation.downloaded, total: preparation.total }) : null;
  const label = preparation.label || "Installing";
  return percent === null ? label : `${label} · ${percent}%`;
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
  const removing = preparation?.phase === "remove";
  const label = isRunning ? "Stop" : waiting && !removing ? "Cancel" : waiting ? preparationLabel(preparation!) : "Play";
  // The status beside the button names the step. Only an icon-only row button
  // starting a game also names it, without the backend's own step label.
  const title = !waiting && launchUnavailable ? "Launch unavailable for this game"
    : waiting && !removing && !showLabel && preparation!.phase !== "install" ? `Starting · ${label}` : label;
  if (launchUnavailable && !waiting) {
    const data = g.moduleData || {};
    const input = data.sourceKind || g.moduleLabel || g.moduleShortLabel || "Game input";
    const reason = data.inspectionReason || data.compatibility;
    const explanation = `${input}: ${reason || "Inspection only. Select a compatible runtime or import a supported game export to play."}`;
    return <span className="detailMeta gameInspectionNotice" role="status" title={explanation}>
      {explanation}
    </span>;
  }
  return (
      <button
        className={[
          "btn",
          showLabel ? "small" : "iconOnly",
          isRunning ? "danger" : "primary"
        ].join(" ")}
        onClick={() =>
          isRunning || waiting ? onStop(g.gamePath) : onPlay(g.gamePath)
        }
        disabled={(!isRunning && Boolean(removing)) || (!waiting && launchUnavailable)}
        title={title}
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
  const canLaunch = g.moduleSupports?.launch !== false;
  const canEditSaves = g.moduleSupports?.saveEditing !== false || g.moduleSupports?.saveLocation === true;
  const canUseCheats = g.moduleSupports?.cheats === true;
  const removing = preparation?.phase === "remove";
  const completed = preparation && typeof preparation.completed === "number" && Number.isFinite(preparation.completed) && preparation.completed >= 0 ? preparation.completed : null;
  const total = preparation && typeof preparation.total === "number" && Number.isFinite(preparation.total) && preparation.total > 0 ? preparation.total : null;
  const percent = preparation && typeof preparation.percent === "number" && Number.isFinite(preparation.percent) ? Math.max(0, Math.min(100, preparation.percent)) : null;
  const countLabel = completed === null ? "" : total === null ? completed.toLocaleString() : `${completed.toLocaleString()} / ${preparation?.estimated ? "~" : ""}${total.toLocaleString()}`;
  const downloadLabel = preparation?.phase === "install" && typeof preparation.downloaded === "number"
    ? `${formatBytes(preparation.downloaded)}${total === null ? "" : ` / ${formatBytes(total)}`}` : "";
  const eta = preparation && typeof preparation.eta === "number" && Number.isFinite(preparation.eta) && preparation.eta >= 0
    ? Math.ceil(preparation.eta) : null;
  const remaining = eta === null ? "" : eta < 60 ? `${eta}s left` : `${Math.ceil(eta / 60)}m left`;
  const progressDetail = [preparation?.stageIndex && `${preparation.stageIndex}${preparation.stageTotal ? ` / ${preparation.stageTotal}` : ""}`,
    preparation?.stage, preparation?.step, preparation?.message, preparation?.note,
    preparation?.elapsed !== undefined && `${Math.round(preparation.elapsed)}s elapsed`].filter(Boolean).join(" · ");
  const exactCount = completed !== null && total !== null && !preparation?.estimated;
  return (
    <div className={`gameActions${inspector ? " inspectorGameActions" : ""}`}>
      <PlayButton g={g} isRunning={isRunning} onPlay={onPlay} onStop={onStop} showLabel={inspector} preparation={preparation} />
      {canLaunch && <button
        className="btn small"
        title="Save a .command file that starts this game when opened"
        disabled={removing}
        onClick={() => onCreateCommand(g.gamePath)}
      >
        {inspector ? "Create shortcut…" : "Shortcut"}
      </button>}
      {preparation && !isRunning && <div className="gameLaunchProgress">
        <span className="gameLaunchStatus" role="status" title={progressDetail || undefined}>{preparationLabel(preparation)}{downloadLabel ? ` · ${downloadLabel}` : countLabel && ` ${countLabel}${preparation.unit ? ` ${preparation.unit}` : ""}`}{remaining && ` · ~${remaining}`}
          {preparation.phase === "install" && (preparation.step || preparation.message) && ` · ${preparation.step || preparation.message}`}</span>
        {!removing && <progress aria-label={preparationLabel(preparation)} max={exactCount ? total : 100}
          value={exactCount ? Math.min(completed!, total!) : percent ?? undefined}
          aria-valuetext={countLabel || undefined} />}
      </div>}
      {inspector && canLaunch && canEditSaves && <button className="btn small" title="Save tools" onClick={() => onOpenSaveTools(g)} disabled={removing}>
        {g.moduleSupports?.saveEditing === true ? "Edit saves" : "Saves"}
      </button>}
      {inspector && canLaunch && canUseCheats && <button className="btn small" title="Cheats" onClick={() => openCheats(g)} disabled={removing}>Cheats</button>}
      <button
        className="btn iconOnly danger forgetAction"
        title={removing ? "Removing" : isRunning || preparation ? "Stop or finish launching before removal" : "Forget game"}
        aria-label={`${removing ? "Removing" : "Forget"} ${g.name}`}
        aria-busy={removing || undefined}
        disabled={isRunning || Boolean(preparation)}
        onClick={() => onForgetGame(g.gamePath)}
      >
        <TrashIcon />
      </button>
    </div>
  );
});
