import React from "react";
import type { RecentGame, SaveFileInfo, SaveInfo } from "../../types";
import { formatBytes, formatModuleLabel, formatWhenMs } from "../../ui-helpers";
import { FolderIcon } from "../../icons";

type SaveToolsModalProps = {
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
  onExportSaveDir: () => void;
  onImportSaveFiles: () => void;
  onEditSaveFile: (file: SaveFileInfo) => void;
  onFormatJson: () => void;
  onOpenEditedJsonExternal: () => void;
  onReloadEditedJsonExternal: () => void;
  onSaveEditedJson: () => void;
  onEditingJsonChange: (value: string) => void;
  onCancelEdit: () => void;
};

export function SaveToolsModal({
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
  onExportSaveDir,
  onImportSaveFiles,
  onEditSaveFile,
  onFormatJson,
  onOpenEditedJsonExternal,
  onReloadEditedJsonExternal,
  onSaveEditedJson,
  onEditingJsonChange,
  onCancelEdit
}: SaveToolsModalProps) {
  return (
    <div className="modalBackdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modalHeader">
          <div>
            <div className="modalTitle">Save tools</div>
            <div className="modalSubtitle">
              {saveInfo?.name || saveGame.name} ·{" "}
              {formatModuleLabel(
                saveInfo?.moduleLabel || saveGame.moduleLabel,
                saveInfo?.moduleShortLabel || saveGame.moduleShortLabel,
                saveInfo?.moduleId || saveGame.moduleId
              )}
            </div>
          </div>
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="modalBody">
          {saveError && <div className="error">Error: {saveError}</div>}

          <div className="modalRow">
            <div className="dim">
              Save dir: <span className="mono">{saveInfo?.saveDir || "—"}</span>
            </div>
            {saveInfo?.saveDir && (
              <button
                className="link iconOnly"
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
            <div className="saveSectionTitle">Files in save dir</div>
            {saveFiles.length === 0 ? (
              <div className="empty">No save files found yet.</div>
            ) : (
              <div className="saveList">
                {saveFiles.map(f => (
                  <div className="saveRow" key={f.path}>
                    <div className="saveRowMain">
                      <div className="saveName">{f.name}</div>
                      <div className="dim">
                        {formatBytes(f.size)} · modified {formatWhenMs(f.mtimeMs)}
                      </div>
                    </div>
                    <div className="saveRowActions">
                      <button
                        className="link iconOnly"
                        disabled={saveBusy}
                        onClick={() => onReveal(f.path)}
                        title="Reveal in Finder"
                        aria-label="Reveal in Finder"
                      >
                        <FolderIcon />
                      </button>
                      <span className="sep">·</span>
                      <button
                        className="link"
                        disabled={saveBusy}
                        onClick={() => onEditSaveFile(f)}
                      >
                        Edit JSON
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {editingFile && (
            <div className="editor">
              <div className="editorHeader">
                <div className="editorTitle">Editing: {editingFile.name}</div>
                <div className="editorActions">
                  <button className="btn" disabled={saveBusy} onClick={onFormatJson}>
                    Format
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
      </div>
    </div>
  );
}
