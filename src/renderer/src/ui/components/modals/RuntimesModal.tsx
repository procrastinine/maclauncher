import React, { useEffect, useMemo } from "react";
import type { DownloadTask, RuntimeManagerState, RuntimeUiState } from "../../types";
import {
  formatDownloadPercent,
  formatRuntimeVersionTag,
  isRuntimeVersionInstalled,
  resolveRuntimeNotice,
  resolveRuntimeSection,
  resolveRuntimeSections,
  sortInstalled
} from "../../ui-helpers";
import { DownloadIcon, RefreshIcon, XIcon } from "../../icons";

const EMPTY_RUNTIME_UI: RuntimeUiState[string] = {
  remoteOpen: {},
  installVersion: {},
  installVariant: {},
  installedSort: {},
  error: null
};

type RuntimesModalProps = {
  runtimeManagers: RuntimeManagerState[];
  runtimeUi: RuntimeUiState;
  runtimeManagerId: string | null;
  runtimeSectionId: string | null;
  downloadTasks: DownloadTask[];
  downloadsOpen: boolean;
  setDownloadsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setRuntimeManagerId: React.Dispatch<React.SetStateAction<string | null>>;
  setRuntimeSectionId: React.Dispatch<React.SetStateAction<string | null>>;
  updateRuntimeUiSection: (
    managerId: string,
    sectionId: string,
    key: "remoteOpen" | "installVersion" | "installVariant" | "installedSort",
    value: any
  ) => void;
  onRuntimeRefresh: (
    managerId: string,
    sectionId: string,
    options?: { latestOnly?: boolean }
  ) => void;
  onRuntimeInstall: (
    managerId: string,
    sectionId: string,
    version: string,
    variant?: string
  ) => void;
  onRuntimeSetDefault: (
    managerId: string,
    sectionId: string,
    version: string | null,
    variant?: string
  ) => void;
  onRuntimeUninstall: (
    managerId: string,
    sectionId: string,
    install: Record<string, any>
  ) => void;
  onCancelDownload: (id: string) => void;
  onClose: () => void;
};

export function RuntimesModal({
  runtimeManagers,
  runtimeUi,
  runtimeManagerId,
  runtimeSectionId,
  downloadTasks,
  downloadsOpen,
  setDownloadsOpen,
  setRuntimeManagerId,
  setRuntimeSectionId,
  updateRuntimeUiSection,
  onRuntimeRefresh,
  onRuntimeInstall,
  onRuntimeSetDefault,
  onRuntimeUninstall,
  onCancelDownload,
  onClose
}: RuntimesModalProps) {
  const runtimeManagersById = useMemo(() => {
    const map = new Map<string, RuntimeManagerState>();
    for (const manager of runtimeManagers) {
      map.set(manager.id, manager);
    }
    return map;
  }, [runtimeManagers]);
  const activeRuntimeManager =
    (runtimeManagerId ? runtimeManagersById.get(runtimeManagerId) : null) ||
    runtimeManagers[0] ||
    null;
  const activeRuntimeSections = resolveRuntimeSections(activeRuntimeManager);
  const activeRuntimeSection =
    resolveRuntimeSection(activeRuntimeManager, runtimeSectionId) ||
    activeRuntimeSections[0] ||
    null;
  const runtimeNotice = resolveRuntimeNotice(activeRuntimeSection);
  const activeRuntimeSectionId = activeRuntimeSection?.id || null;
  const activeRuntimeUi = activeRuntimeManager
    ? runtimeUi[activeRuntimeManager.id] || EMPTY_RUNTIME_UI
    : EMPTY_RUNTIME_UI;

  useEffect(() => {
    if (!activeRuntimeManager) return;
    if (!activeRuntimeSectionId) return;
    if (runtimeSectionId === activeRuntimeSectionId) return;
    setRuntimeSectionId(activeRuntimeSectionId);
  }, [activeRuntimeManager, activeRuntimeSectionId, runtimeSectionId, setRuntimeSectionId]);

  const activeRuntimeRemoteOpen =
    activeRuntimeManager && activeRuntimeSectionId
      ? Boolean(activeRuntimeUi.remoteOpen[activeRuntimeSectionId])
      : false;
  const activeRuntimeInstallVersion =
    activeRuntimeManager && activeRuntimeSectionId
      ? activeRuntimeUi.installVersion[activeRuntimeSectionId] || ""
      : "";
  const activeRuntimeInstallVariant =
    activeRuntimeManager && activeRuntimeSectionId
      ? activeRuntimeUi.installVariant[activeRuntimeSectionId] || ""
      : "";
  const activeRuntimeInstalledSort =
    activeRuntimeManager && activeRuntimeSectionId
      ? activeRuntimeUi.installedSort[activeRuntimeSectionId] || "default"
      : "default";
  const activeRuntimeSupportsLatestOnly = Boolean(
    activeRuntimeSection?.catalog?.supportsLatestOnly
  );
  const activeRuntimeRefreshLabel =
    activeRuntimeSection?.catalog?.status === "loading"
      ? activeRuntimeSupportsLatestOnly
        ? "Refreshing latest version"
        : "Refreshing remote versions"
      : activeRuntimeSupportsLatestOnly
        ? "Refresh latest version"
        : "Refresh remote versions";
  const activeRuntimeRefreshAllLabel =
    activeRuntimeSection?.catalog?.status === "loading"
      ? "Refreshing all remote versions"
      : "Load all remote versions";
  const activeRuntimeInstalled = Array.isArray(activeRuntimeSection?.installed)
    ? activeRuntimeSection.installed
    : [];
  const activeRuntimeVariants = Array.isArray(activeRuntimeSection?.variants)
    ? activeRuntimeSection.variants
    : [];
  const activeRuntimeHasVariants = activeRuntimeVariants.length > 0;
  const activeRuntimeHasMultipleVariants = activeRuntimeVariants.length > 1;
  const activeRuntimeResolvedInstallVariant = activeRuntimeHasVariants
    ? activeRuntimeInstallVariant ||
      activeRuntimeSection?.defaultVariant ||
      activeRuntimeVariants[0]?.id ||
      ""
    : "";
  const activeRuntimeInstalledSorted = sortInstalled(
    activeRuntimeInstalled,
    activeRuntimeInstalledSort,
    activeRuntimeSection?.defaultVersion || null,
    activeRuntimeHasVariants ? activeRuntimeSection?.defaultVariant || null : null
  );
  const activeRuntimeSelectedInstalled = isRuntimeVersionInstalled(
    activeRuntimeInstalled,
    activeRuntimeInstallVersion,
    activeRuntimeResolvedInstallVariant,
    activeRuntimeHasVariants
  );
  const activeRuntimeDownloads = useMemo(() => {
    if (!activeRuntimeManager?.id || !activeRuntimeSectionId) return [];
    return downloadTasks.filter(
      task =>
        task.managerId === activeRuntimeManager.id &&
        task.sectionId === activeRuntimeSectionId
    );
  }, [downloadTasks, activeRuntimeManager?.id, activeRuntimeSectionId]);
  const activeRuntimeSelectedDownloading = activeRuntimeDownloads.some(task => {
    if (!activeRuntimeInstallVersion) return false;
    if (task.version !== activeRuntimeInstallVersion) return false;
    if (!activeRuntimeHasVariants) return true;
    return task.variant === activeRuntimeResolvedInstallVariant;
  });
  const activeRuntimeDownloadSummary = useMemo(() => {
    if (activeRuntimeDownloads.length === 0) return null;
    if (activeRuntimeDownloads.length > 1) {
      return `Downloading ${activeRuntimeDownloads.length} items`;
    }
    const task = activeRuntimeDownloads[0];
    const percent = formatDownloadPercent(task);
    const label = task.detail || (task.version ? `v${task.version}` : task.label);
    return percent !== null ? `Downloading ${label} · ${percent}%` : `Downloading ${label}`;
  }, [activeRuntimeDownloads]);
  const activeRuntimeDefaultVariantLabel = activeRuntimeHasMultipleVariants
    ? activeRuntimeVariants.find(
        (variant: any) => variant.id === activeRuntimeSection?.defaultVariant
      )?.label || activeRuntimeSection?.defaultVariant || ""
    : "";
  const activeRuntimeSubtitleParts = [] as string[];
  if (activeRuntimeSections.length > 1 && activeRuntimeSection?.label) {
    activeRuntimeSubtitleParts.push(activeRuntimeSection.label);
  }
  if (activeRuntimeSection?.defaultVersion) {
    activeRuntimeSubtitleParts.push(
      `Default ${formatRuntimeVersionTag(
        activeRuntimeSection.defaultVersion,
        activeRuntimeSection
      )}`
    );
  } else {
    activeRuntimeSubtitleParts.push("Default version not set");
  }
  if (activeRuntimeDefaultVariantLabel) {
    activeRuntimeSubtitleParts.push(activeRuntimeDefaultVariantLabel);
  }
  activeRuntimeSubtitleParts.push(`${activeRuntimeInstalled.length} installed`);
  const activeRuntimeSubtitle = activeRuntimeSubtitleParts.join(" · ");

  return (
    <div className="modalBackdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modalHeader runtimeModalHeader">
          <div className="runtimeHeaderTop">
            <div className="modalTitle">Runtimes</div>
            <div className="runtimeHeaderActions">
              <div className="runtimeDownloadMenu">
                <button
                  className="btn iconOnly runtimeDownloadToggle"
                  onClick={() => setDownloadsOpen(open => !open)}
                  title="Downloads"
                  aria-label="Downloads"
                >
                  <DownloadIcon />
                  {downloadTasks.length > 0 && (
                    <span className="runtimeDownloadBadge">
                      {downloadTasks.length}
                    </span>
                  )}
                </button>
                {downloadsOpen && (
                  <div className="runtimeDownloadDropdown" role="menu">
                    {downloadTasks.length === 0 ? (
                      <div className="runtimeDownloadEmpty">
                        No active downloads.
                      </div>
                    ) : (
                      downloadTasks.map(task => {
                        const percent = formatDownloadPercent(task);
                        const label =
                          task.detail || (task.version ? `v${task.version}` : task.label);
                        return (
                          <div key={task.id} className="runtimeDownloadItem">
                            <div className="runtimeDownloadMeta">
                              <div className="runtimeDownloadLabel">{task.label}</div>
                              <div className="runtimeDownloadDetail">{label}</div>
                            </div>
                            <div className="runtimeDownloadRow">
                              <div
                                className={[
                                  "runtimeDownloadBar",
                                  percent == null ? "indeterminate" : ""
                                ]
                                  .filter(Boolean)
                                  .join(" ")}
                              >
                                <div
                                  className="runtimeDownloadBarFill"
                                  style={
                                    percent == null
                                      ? { width: "40%" }
                                      : { width: `${percent}%` }
                                  }
                                />
                              </div>
                              {percent != null && (
                                <div className="runtimeDownloadPercent">{percent}%</div>
                              )}
                              <button
                                className="btn iconOnly danger"
                                title="Cancel download"
                                aria-label="Cancel download"
                                onClick={() => onCancelDownload(task.id)}
                              >
                                <XIcon size="0.9em" />
                              </button>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
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
          {runtimeManagers.length > 1 && (
            <div className="runtimeTabs" role="tablist" aria-label="Runtime manager tabs">
              {runtimeManagers.map(manager => {
                const active = activeRuntimeManager?.id === manager.id;
                return (
                  <div
                    key={manager.id}
                    id={`runtime-manager-tab-${manager.id}`}
                    role="tab"
                    aria-selected={active}
                    aria-controls={`runtime-panel-${manager.id}`}
                    tabIndex={active ? 0 : -1}
                    className={["runtimeTab", active ? "active" : ""]
                      .filter(Boolean)
                      .join(" ")}
                    onClick={() => {
                      setRuntimeManagerId(manager.id);
                      const nextSection = resolveRuntimeSection(manager, null)?.id || null;
                      setRuntimeSectionId(nextSection);
                    }}
                    onKeyDown={e => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setRuntimeManagerId(manager.id);
                        const nextSection = resolveRuntimeSection(manager, null)?.id || null;
                        setRuntimeSectionId(nextSection);
                      }
                    }}
                  >
                    <span>{manager.label || manager.id}</span>
                  </div>
                );
              })}
            </div>
          )}
          {activeRuntimeSections.length > 1 && (
            <div className="runtimeTabs" role="tablist" aria-label="Runtime line tabs">
              {activeRuntimeSections.map(section => {
                const active = activeRuntimeSection?.id === section.id;
                return (
                  <div
                    key={section.id}
                    id={`runtime-section-tab-${section.id}`}
                    role="tab"
                    aria-selected={active}
                    aria-controls={`runtime-panel-${activeRuntimeManager?.id}-${section.id}`}
                    tabIndex={active ? 0 : -1}
                    className={["runtimeTab", active ? "active" : ""]
                      .filter(Boolean)
                      .join(" ")}
                    onClick={() => setRuntimeSectionId(section.id)}
                    onKeyDown={e => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setRuntimeSectionId(section.id);
                      }
                    }}
                  >
                    <span>{section.label || section.id}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="modalBody runtimeModalBody">
          {activeRuntimeManager && activeRuntimeSection ? (
            <div
              className="runtimeTabPanel"
              role="tabpanel"
              id={`runtime-panel-${activeRuntimeManager.id}-${activeRuntimeSection.id}`}
              aria-labelledby={`runtime-manager-tab-${activeRuntimeManager.id}`}
            >
              <div className="runtimePanel">
                <div className="runtimePanelHeader">
                  <div>
                    <div className="runtimePanelTitle">
                      {activeRuntimeManager.label || activeRuntimeManager.id}
                    </div>
                    <div className="runtimePanelSubtitle">{activeRuntimeSubtitle}</div>
                  </div>
                  <div className="runtimePanelHeaderActions">
                    {activeRuntimeDownloadSummary && (
                      <div className="chip">{activeRuntimeDownloadSummary}</div>
                    )}
                  </div>
                </div>

                {activeRuntimeUi.error && (
                  <div className="error runtimeError">Error: {activeRuntimeUi.error}</div>
                )}

                {runtimeNotice && (
                  <div className="runtimeNotice">
                    <div className="runtimeNoticeTitle">{runtimeNotice.title}</div>
                    {runtimeNotice.lines.map((line, index) => (
                      <div
                        key={`${runtimeNotice.title}-${index}`}
                        className={[
                          "runtimeNoticeLine",
                          line.mono ? "mono" : ""
                        ]
                          .filter(Boolean)
                          .join(" ")}
                      >
                        {line.text}
                      </div>
                    ))}
                  </div>
                )}

                <div className="runtimeSectionCard">
                  <div className="runtimeSectionHeader">
                    <div>
                      <div className="runtimeSectionTitle">Remote versions</div>
                      <div className="runtimeSectionHint">
                        {activeRuntimeSection.catalog?.source ? (
                          <>
                            Source:{" "}
                            <span className="mono">
                              {activeRuntimeSection.catalog.source}
                            </span>
                            . Installing may require network access.
                          </>
                        ) : (
                          "Installing may require network access."
                        )}
                      </div>
                    </div>
                    <div className="runtimePanelHeaderActions">
                      <button
                        className="btn iconOnly"
                        disabled={activeRuntimeSection.catalog?.status === "loading"}
                        onClick={() => {
                          updateRuntimeUiSection(
                            activeRuntimeManager.id,
                            activeRuntimeSection.id,
                            "remoteOpen",
                            true
                          );
                          onRuntimeRefresh(
                            activeRuntimeManager.id,
                            activeRuntimeSection.id,
                            activeRuntimeSupportsLatestOnly ? { latestOnly: true } : {}
                          );
                        }}
                        title={activeRuntimeRefreshLabel}
                        aria-label={activeRuntimeRefreshLabel}
                      >
                        <RefreshIcon />
                      </button>
                      {activeRuntimeSupportsLatestOnly && (
                        <button
                          className="btn"
                          disabled={activeRuntimeSection.catalog?.status === "loading"}
                          onClick={() => {
                            updateRuntimeUiSection(
                              activeRuntimeManager.id,
                              activeRuntimeSection.id,
                              "remoteOpen",
                              true
                            );
                            onRuntimeRefresh(
                              activeRuntimeManager.id,
                              activeRuntimeSection.id,
                              { latestOnly: false }
                            );
                          }}
                          title={activeRuntimeRefreshAllLabel}
                          aria-label={activeRuntimeRefreshAllLabel}
                        >
                          All versions...
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="runtimeSectionBody">
                    <div className="runtimeMeta">
                      {activeRuntimeSection.catalog?.status === "loading" ? (
                        <span className="dim">Fetching remote versions</span>
                      ) : activeRuntimeSection.catalog?.latestAvailableVersion ? (
                        <span className="dim">
                          Latest remote{" "}
                          {formatRuntimeVersionTag(
                            activeRuntimeSection.catalog.latestAvailableVersion,
                            activeRuntimeSection
                          )}
                        </span>
                      ) : (
                        <span className="dim">Remote versions not loaded</span>
                      )}
                      {activeRuntimeSection.catalog?.latestInstalledVersion && (
                        <span className="dim">
                          Latest installed{" "}
                          {formatRuntimeVersionTag(
                            activeRuntimeSection.catalog.latestInstalledVersion,
                            activeRuntimeSection
                          )}
                        </span>
                      )}
                    </div>

                    {activeRuntimeSection.catalog?.status === "error" &&
                      activeRuntimeSection.catalog?.error && (
                        <div className="dim">
                          Remote fetch failed: {activeRuntimeSection.catalog.error}
                        </div>
                      )}

                    {activeRuntimeRemoteOpen && (
                      <div className="runtimeRemote">
                        <div className="runtimeRemoteField">
                          <div className="fieldLabel">Version</div>
                          <select
                            className="input"
                            value={activeRuntimeInstallVersion}
                            disabled={
                              !activeRuntimeSection.catalog?.versions ||
                              activeRuntimeSection.catalog.versions.length === 0
                            }
                            onChange={e =>
                              updateRuntimeUiSection(
                                activeRuntimeManager.id,
                                activeRuntimeSection.id,
                                "installVersion",
                                e.target.value
                              )
                            }
                          >
                            {activeRuntimeSection.catalog?.versions &&
                            activeRuntimeSection.catalog.versions.length > 0 ? (
                              activeRuntimeSection.catalog.versions.map((v: string) => {
                                const installed = isRuntimeVersionInstalled(
                                  activeRuntimeInstalled,
                                  v,
                                  activeRuntimeResolvedInstallVariant,
                                  activeRuntimeHasVariants
                                );
                                return (
                                  <option key={v} value={v}>
                                    {formatRuntimeVersionTag(v, activeRuntimeSection)}
                                    {installed ? " [Installed]" : ""}
                                  </option>
                                );
                              })
                            ) : (
                              <option value="">No remote versions loaded</option>
                            )}
                          </select>
                        </div>
                        {activeRuntimeHasMultipleVariants && (
                          <div className="runtimeRemoteField">
                            <div className="fieldLabel">Variant</div>
                            <select
                              className="input"
                              value={activeRuntimeInstallVariant}
                              onChange={e =>
                                updateRuntimeUiSection(
                                  activeRuntimeManager.id,
                                  activeRuntimeSection.id,
                                  "installVariant",
                                  e.target.value
                                )
                              }
                            >
                              {activeRuntimeVariants.map((variant: any) => (
                                <option key={variant.id} value={variant.id}>
                                  {variant.label || variant.id}
                                </option>
                              ))}
                            </select>
                          </div>
                        )}
                        <button
                          className="btn primary"
                          disabled={
                            !activeRuntimeInstallVersion ||
                            activeRuntimeSelectedInstalled ||
                            activeRuntimeSelectedDownloading
                          }
                          onClick={() => {
                            onRuntimeInstall(
                              activeRuntimeManager.id,
                              activeRuntimeSection.id,
                              activeRuntimeInstallVersion,
                              activeRuntimeResolvedInstallVariant || undefined
                            );
                          }}
                        >
                          Install
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                <div className="saveSection runtimeSection">
                  <div className="saveSectionTitle runtimeInstalledHeader">
                    <span>Installed versions</span>
                    <span className="runtimeInstalledHeaderRight">
                      <select
                        className="input inputSmall"
                        value={activeRuntimeInstalledSort}
                        onChange={e =>
                          updateRuntimeUiSection(
                            activeRuntimeManager.id,
                            activeRuntimeSection.id,
                            "installedSort",
                            e.target.value
                          )
                        }
                      >
                        <option value="default">Default first</option>
                        <option value="newest">Newest first</option>
                        <option value="oldest">Oldest first</option>
                        <option value="path">Path</option>
                      </select>
                    </span>
                  </div>
                  {activeRuntimeInstalledSorted.length === 0 ? (
                    <div className="empty">No runtime versions installed yet.</div>
                  ) : (
                    <div className="saveList">
                      {activeRuntimeInstalledSorted.map(inst => {
                        const isDefault =
                          inst.version === activeRuntimeSection.defaultVersion &&
                          (activeRuntimeSection.defaultVariant
                            ? inst.variant === activeRuntimeSection.defaultVariant
                            : true);
                        const variantLabel = activeRuntimeHasMultipleVariants
                          ? activeRuntimeVariants.find(
                              (variant: any) => variant.id === inst.variant
                            )?.label || inst.variant
                          : "";
                        return (
                          <div
                            className="saveRow"
                            key={`${inst.version}-${inst.platformKey}-${inst.variant}`}
                          >
                            <div className="saveRowMain">
                              <div className="saveName">
                                {formatRuntimeVersionTag(inst.version, activeRuntimeSection)}
                                {isDefault && (
                                  <span className="badge badgeAccent">Default</span>
                                )}
                                {activeRuntimeHasMultipleVariants && inst.variant && (
                                  <span className="badge">{variantLabel}</span>
                                )}
                                {inst.platformKey && (
                                  <span className="dim">· {inst.platformKey}</span>
                                )}
                              </div>
                              <div className="dim mono ellipsis runtimePath">
                                {inst.installDir}
                              </div>
                            </div>
                            <div className="saveRowActions">
                              {!isDefault && (
                                <>
                                  <button
                                    className="link"
                                    onClick={() =>
                                      onRuntimeSetDefault(
                                        activeRuntimeManager.id,
                                        activeRuntimeSection.id,
                                        inst.version,
                                        inst.variant
                                      )
                                    }
                                  >
                                    Set default
                                  </button>
                                </>
                              )}
                              <button
                                className="btn iconOnly danger"
                                title="Uninstall"
                                aria-label="Uninstall"
                                onClick={() =>
                                  onRuntimeUninstall(
                                    activeRuntimeManager.id,
                                    activeRuntimeSection.id,
                                    inst
                                  )
                                }
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
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="empty">No runtime managers available.</div>
          )}
        </div>
      </div>
    </div>
  );
}
