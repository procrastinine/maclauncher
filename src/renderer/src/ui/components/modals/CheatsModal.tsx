import React from "react";
import type {
  CheatsConfig,
  CheatsField,
  CheatsPatchStatus,
  ModuleUiAction,
  ModuleUiCheatsPatch,
  RecentGame
} from "../../types";
import { formatModuleLabel } from "../../ui-helpers";
import { ActionIcon, RefreshIcon, XIcon } from "../../icons";

type CheatsModalProps = {
  cheatGame: RecentGame;
  cheatDraft: CheatsConfig;
  cheatError: string | null;
  cheatBusy: boolean;
  cheatAddonBusy: boolean;
  showCheatFields: boolean;
  cheatNumbers: CheatsField[];
  cheatToggles: CheatsField[];
  cheatDefaults: CheatsConfig;
  toolsButtonSettingAvailable: boolean;
  toolsButtonUsesDefault: boolean;
  toolsButtonEffective: boolean;
  toolsButtonVisible: boolean;
  setCheatDraft: React.Dispatch<React.SetStateAction<CheatsConfig | null>>;
  setToolsButtonOverride: React.Dispatch<React.SetStateAction<boolean | null>>;
  onClose: () => void;
  cheatAddonStatusAction: string | null;
  onRefreshCheatAddonStatus: () => void;
  cheatAddonPatches: ModuleUiCheatsPatch[];
  cheatAddonStatus: CheatsPatchStatus | null;
  cheatModuleActionsById: Map<string, ModuleUiAction>;
  onCheatAddonAction: (
    gamePath: string,
    actionId: string,
    actionMeta?: ModuleUiAction
  ) => void;
};

export function CheatsModal({
  cheatGame,
  cheatDraft,
  cheatError,
  cheatBusy,
  cheatAddonBusy,
  showCheatFields,
  cheatNumbers,
  cheatToggles,
  cheatDefaults,
  toolsButtonSettingAvailable,
  toolsButtonUsesDefault,
  toolsButtonEffective,
  toolsButtonVisible,
  setCheatDraft,
  setToolsButtonOverride,
  onClose,
  cheatAddonStatusAction,
  onRefreshCheatAddonStatus,
  cheatAddonPatches,
  cheatAddonStatus,
  cheatModuleActionsById,
  onCheatAddonAction
}: CheatsModalProps) {
  return (
    <div className="modalBackdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modalHeader">
          <div>
            <div className="modalTitle">Cheats</div>
            <div className="modalSubtitle">
              {cheatGame.name} ·{" "}
              {formatModuleLabel(
                cheatGame.moduleLabel,
                cheatGame.moduleShortLabel,
                cheatGame.moduleId
              )}
            </div>
          </div>
          <div className="modalHeaderActions">
            {cheatAddonStatusAction && (
              <button
                className="btn iconOnly"
                disabled={cheatBusy || cheatAddonBusy}
                onClick={onRefreshCheatAddonStatus}
                title="Refresh"
                aria-label="Refresh"
              >
                <RefreshIcon />
              </button>
            )}
            <button
              className="btn iconOnly"
              onClick={onClose}
              title="Close"
              aria-label="Close"
            >
              <XIcon />
            </button>
          </div>
        </div>

        <div className="modalBody">
          {cheatError && <div className="error">Error: {cheatError}</div>}
          {showCheatFields && (
            <>
              <div className="dim">
                Changes save automatically and apply immediately if the game is running. Otherwise on
                next launch.
              </div>

              <div className="formGrid">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={cheatDraft.enabled}
                    disabled={cheatBusy}
                    onChange={e =>
                      setCheatDraft(d => (d ? { ...d, enabled: e.target.checked } : d))
                    }
                  />
                  <span>Enable cheats</span>
                </label>

                {toolsButtonSettingAvailable && (
                  <div className="field">
                    <div className="fieldLabel">Tools button</div>
                    <label className="inlineCheck">
                      <input
                        type="checkbox"
                        checked={toolsButtonEffective}
                        disabled={cheatBusy}
                        onChange={e => setToolsButtonOverride(e.target.checked)}
                      />
                      <span>Show in game overlay</span>
                    </label>
                    <div className="fieldInlineActions">
                      <button
                        className="btn small"
                        disabled={cheatBusy || toolsButtonUsesDefault}
                        onClick={() => setToolsButtonOverride(null)}
                      >
                        Use default
                      </button>
                      <span className="dim">
                        Default: {toolsButtonVisible ? "Shown" : "Hidden"}
                      </span>
                    </div>
                  </div>
                )}

                {cheatNumbers.map(field => (
                  <label className="field" key={String(field.key)}>
                    <div className="fieldLabel">{field.label}</div>
                    <input
                      className="input"
                      type="number"
                      min={field.min}
                      max={field.max}
                      step={field.step ?? 1}
                      value={(cheatDraft as any)[field.key]}
                      disabled={cheatBusy}
                      onChange={e =>
                        setCheatDraft(d => {
                          if (!d) return d;
                          const v = Number(e.target.value);
                          if (!Number.isFinite(v)) return d;
                          const min = typeof field.min === "number" ? field.min : -Infinity;
                          const max = typeof field.max === "number" ? field.max : Infinity;
                          return { ...d, [field.key]: Math.min(max, Math.max(min, v)) } as any;
                        })
                      }
                    />
                  </label>
                ))}

                {cheatToggles.map(field => (
                  <label className="check" key={String(field.key)}>
                    <input
                      type="checkbox"
                      checked={Boolean((cheatDraft as any)[field.key])}
                      disabled={cheatBusy}
                      onChange={e =>
                        setCheatDraft(d =>
                          d ? ({ ...d, [field.key]: e.target.checked } as any) : d
                        )
                      }
                    />
                    <span>{field.label}</span>
                  </label>
                ))}
              </div>
            </>
          )}

          {cheatAddonPatches.length > 0 && cheatGame && (
            <div className="detailGrid cheatAddonGrid">
              {cheatAddonPatches.map(patch => {
                const addAction = cheatModuleActionsById.get(patch.addAction) || null;
                const removeAction = cheatModuleActionsById.get(patch.removeAction) || null;
                if (!addAction || !removeAction) return null;
                const canRemove = Boolean(
                  cheatAddonStatus && cheatAddonStatus[patch.statusKey]
                );
                const addClass = [
                  "btn",
                  "small",
                  addAction.kind === "primary" ? "primary" : "",
                  addAction.kind === "danger" ? "danger" : ""
                ]
                  .filter(Boolean)
                  .join(" ");
                const removeClass = [
                  "btn",
                  "small",
                  removeAction.kind === "primary" ? "primary" : "",
                  removeAction.kind === "danger" ? "danger" : ""
                ]
                  .filter(Boolean)
                  .join(" ");
                return (
                  <div className="detailRow cheatPatchRow" key={`cheat-addon-${patch.id}`}>
                    <div className="detailValue">{patch.label}</div>
                    <div className="detailActions">
                      <button
                        className={addClass}
                        disabled={cheatBusy || cheatAddonBusy}
                        onClick={() =>
                          onCheatAddonAction(cheatGame.gamePath, addAction.id, addAction)
                        }
                      >
                        Patch
                      </button>
                      <button
                        className={[removeClass, "iconOnly"].filter(Boolean).join(" ")}
                        disabled={cheatBusy || cheatAddonBusy || !canRemove}
                        onClick={() =>
                          onCheatAddonAction(cheatGame.gamePath, removeAction.id, removeAction)
                        }
                        title={removeAction.label}
                        aria-label={removeAction.label}
                      >
                        <ActionIcon icon="x" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {showCheatFields && (
            <div className="modalActions">
              <button
                className="btn"
                disabled={cheatBusy}
                onClick={() => setCheatDraft({ ...cheatDefaults })}
              >
                Reset to defaults
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
