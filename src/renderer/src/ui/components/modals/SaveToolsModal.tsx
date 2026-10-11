import React, { useState } from "react";
import type { RecentGame, SaveActionRunner, SaveFileInfo, SaveInfo } from "../../types";
import { formatBytes, formatModuleLabel, formatUserError, formatWhenMs } from "../../ui-helpers";
import { FolderIcon, XIcon } from "../../icons";
import { StructuredSaveEditor } from "../StructuredSaveEditor";
import { SaveSnapshotPanel } from "../SaveSnapshotPanel";

type SaveToolsModalProps = {
  windowMode?: boolean;
  saveGame: RecentGame;
  saveInfo: SaveInfo | null;
  saveFiles: SaveFileInfo[];
  saveBusy: boolean;
  saveError: string | null;
  editingFile: SaveFileInfo | null;
  editingJson: string;
  onClose: () => void;
  onReveal: (path: string) => void;
  onImportSaveDir: () => void;
  onSelectSaveLocation?: (directory: string) => void;
  onExportSaveDir: () => void;
  onImportSaveFiles: () => void;
  onEditSaveFile: (file: SaveFileInfo) => void;
  onFormatJson: () => void;
  onOpenEditedJsonExternal: () => void;
  onReloadEditedJsonExternal: () => void;
  onSaveEditedJson: () => void;
  onEditingJsonChange: (value: string) => void;
  onCancelEdit: () => void;
  runSaveAction: SaveActionRunner;
  saveRevision: number;
};

export function SaveToolsModal({
  windowMode = false,
  saveGame,
  saveInfo,
  saveFiles,
  saveBusy,
  saveError,
  editingFile,
  editingJson,
  onClose,
  onReveal,
  onImportSaveDir,
  onSelectSaveLocation,
  onExportSaveDir,
  onImportSaveFiles,
  onEditSaveFile,
  onFormatJson,
  onOpenEditedJsonExternal,
  onReloadEditedJsonExternal,
  onSaveEditedJson,
  onEditingJsonChange,
  onCancelEdit,
  runSaveAction,
  saveRevision
}: SaveToolsModalProps) {
  const [tab, setTab] = useState<"files" | "snapshots">("files");
  const [structuredFile, setStructuredFile] = useState<SaveFileInfo | null>(null);
  return (
    <div className={windowMode ? "saveEditorWindow" : "modalBackdrop"} onClick={windowMode ? undefined : onClose}>
      <div className={windowMode ? "saveEditorPanel" : "modal saveToolsModal"} role={windowMode ? undefined : "dialog"} aria-modal={windowMode ? undefined : true} aria-labelledby={windowMode ? undefined : "save-tools-title"} aria-label={windowMode ? `Save editor for ${saveGame.name}` : undefined} onClick={e => e.stopPropagation()}
        onKeyDown={event => {
          if (event.key === "Escape" && !windowMode) { event.preventDefault(); onClose(); }
          else if (event.metaKey && event.key.toLowerCase() === "s" && editingFile && tab === "files") {
            event.preventDefault(); if (!saveBusy) onSaveEditedJson();
          }
        }}>
        {!windowMode && <div className="modalHeader">
          <div>
            <div className="modalTitle" id="save-tools-title">{saveGame.moduleSupports?.saveEditing ? "Save editor" : "Save tools"}</div>
            <div className="modalSubtitle">
              {saveInfo?.name || saveGame.name} ·{" "}
              {formatModuleLabel(
                saveInfo?.moduleLabel || saveGame.moduleLabel,
                saveInfo?.moduleShortLabel || saveGame.moduleShortLabel,
                saveInfo?.moduleId || saveGame.moduleId
              )}
            </div>
          </div>
          {!windowMode && <button
            className="btn iconOnly"
            onClick={onClose}
            disabled={saveBusy}
            title="Close"
            aria-label="Close"
          >
            <XIcon />
          </button>}
        </div>}

        <div className="saveToolsTabs" role="tablist" aria-label="Save tools views">
          {(["files", "snapshots"] as const).map((id, index) => <button key={id} role="tab" type="button"
            id={`save-tools-tab-${id}`} aria-controls={`save-tools-panel-${id}`} aria-selected={tab === id}
            tabIndex={tab === id ? 0 : -1} aria-disabled={saveBusy || undefined}
            onClick={() => { if (!saveBusy) setTab(id); }} onKeyDown={event => {
              let next = index;
              if (event.key === "ArrowRight" || event.key === "ArrowLeft") next = 1 - index;
              else if (event.key === "Home") next = 0;
              else if (event.key === "End") next = 1;
              else return;
              event.preventDefault();
              if (saveBusy) return;
              setTab(next === 0 ? "files" : "snapshots");
              event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
            }}>{id === "files" ? "Save files" : "Snapshots"}</button>)}
        </div>

        <div className="modalBody">
          {saveError && <div className="error">Error: {formatUserError(saveError)}</div>}

          <div role="tabpanel" id="save-tools-panel-files" aria-labelledby="save-tools-tab-files" hidden={tab !== "files"}>

          <div className="modalRow">
            {(saveInfo?.directoryChoices?.length || 0) > 1 && onSelectSaveLocation ? <select className="input" aria-label="Save location"
              value={saveInfo!.saveDir} disabled={saveBusy} onChange={event => { setStructuredFile(null); onCancelEdit(); onSelectSaveLocation(event.target.value); }}>
              {!saveInfo!.directoryChoices!.some(location => location.directory === saveInfo!.saveDir) && <option value={saveInfo!.saveDir} disabled>{saveInfo!.saveDir}</option>}
              {saveInfo!.directoryChoices!.map(location => <option key={location.directory} value={location.directory}>{location.label ? `${location.label} · ` : ""}{location.directory}</option>)}
            </select> : <div className="dim">
              Save dir: <span className="mono">{saveInfo?.saveDir || "—"}</span>
            </div>}
            {saveInfo?.saveDir && (
              <button
                className="btn iconOnly"
                onClick={() => onReveal(saveInfo.saveDir)}
                title="Reveal in Finder"
                aria-label="Reveal in Finder"
              >
                <FolderIcon />
              </button>
            )}
          </div>

          <div className="modalActions">
            <button className="btn" disabled={saveBusy} onClick={onImportSaveDir}>
              Import folder…
            </button>
            <button className="btn" disabled={saveBusy} onClick={onExportSaveDir}>
              Export folder…
            </button>
            <button className="btn" disabled={saveBusy} onClick={onImportSaveFiles}>
              Import files…
            </button>
          </div>

          <div className="saveSection">
            {saveFiles.length === 0 ? (
              <div className="empty">No save files found yet.</div>
            ) : (
              <div className="saveList">
                {saveFiles.map(f => (
                  <div className="saveRow" key={f.path}>
                    <div className="saveRowMain">
                      <div className="saveName">{f.name}</div>
                      <div className="dim saveMeta">
                        {formatBytes(f.size)} · modified {formatWhenMs(f.mtimeMs)}
                      </div>
                    </div>
                    <div className="saveRowActions">
                      {saveInfo?.structuredActions && <button className="btn" disabled={saveBusy}
                        onClick={() => { onCancelEdit(); setStructuredFile(f); }}>Edit values</button>}
                      <button
                        className="btn iconOnly"
                        disabled={saveBusy}
                        onClick={() => onReveal(f.path)}
                        title="Reveal in Finder"
                        aria-label="Reveal in Finder"
                      >
                        <FolderIcon />
                      </button>
                      {saveInfo?.canEditJson && <button
                        className="btn"
                        disabled={saveBusy}
                        onClick={() => { setStructuredFile(null); onEditSaveFile(f); }}
                      >
                        Edit JSON
                      </button>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {structuredFile && saveInfo?.structuredActions && <StructuredSaveEditor key={structuredFile.name}
            fileName={structuredFile.name} actions={saveInfo.structuredActions} busy={saveBusy} runAction={runSaveAction}
            onClose={() => setStructuredFile(null)} />}

          {editingFile && (
            <div className="editor">
              <div className="editorHeader">
                <div className="editorTitle">Editing: {editingFile.name}</div>
                <div className="editorActions">
                  <button className="btn" disabled={saveBusy} onClick={onFormatJson}>
                    Format
                  </button>
                  <button className="btn" disabled={saveBusy} onClick={() => onEditSaveFile(editingFile)}>
                    Reload save
                  </button>
                  <button
                    className="btn"
                    disabled={saveBusy}
                    onClick={onOpenEditedJsonExternal}
                  >
                    Open in editor
                  </button>
                  <button
                    className="btn"
                    disabled={saveBusy}
                    onClick={onReloadEditedJsonExternal}
                  >
                    Reload from editor
                  </button>
                  <button
                    className="btn primary"
                    disabled={saveBusy}
                    onClick={onSaveEditedJson}
                  >
                    Save
                  </button>
                  <button className="btn" disabled={saveBusy} onClick={onCancelEdit}>
                    Cancel
                  </button>
                </div>
              </div>
              <textarea
                className="codeArea"
                disabled={saveBusy}
                spellCheck={false}
                value={editingJson}
                onChange={e => onEditingJsonChange(e.target.value)}
              />
              <div className="dim editorHint">
                External file:{" "}
                <span className="mono">{editingFile.path}.maclauncher.json</span> ·
                Writes a backup to{" "}
                <span className="mono">{editingFile.path}.maclauncher.bak</span>
              </div>
            </div>
          )}
          </div>
          <div role="tabpanel" id="save-tools-panel-snapshots" aria-labelledby="save-tools-tab-snapshots" hidden={tab !== "snapshots"}>
            {tab === "snapshots" && saveInfo && <SaveSnapshotPanel busy={saveBusy} runAction={runSaveAction} revision={saveRevision}
              onRestored={() => { setStructuredFile(null); onCancelEdit(); }} />}
          </div>
        </div>
      </div>
    </div>
  );
}
