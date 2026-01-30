import React from "react";
import { XIcon } from "../../icons";

type AcknowledgmentsModalProps = {
  acknowledgments: Array<{ label: string; url: string }>;
  canOpenExternal: boolean;
  onOpenLink: (url: string) => void;
  onClose: () => void;
};

export function AcknowledgmentsModal({
  acknowledgments,
  canOpenExternal,
  onOpenLink,
  onClose
}: AcknowledgmentsModalProps) {
  return (
    <div className="modalBackdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modalHeader">
          <div>
            <div className="modalTitle">Acknowledgments</div>
            <div className="modalSubtitle">
              Thanks to the projects that make MacLauncher possible.
            </div>
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

        <div className="modalBody">
          {acknowledgments.length === 0 ? (
            <div className="empty">No acknowledgments listed yet.</div>
          ) : (
            <div className="ackTable">
              <div className="ackRow ackHeaderRow">
                <div className="ackCell">Project</div>
                <div className="ackCell ackUrl mono">URL</div>
                <div className="ackCell ackActionCell" aria-hidden="true">
                  <button
                    className="btn small ackActionSpacer"
                    disabled
                    tabIndex={-1}
                  >
                    Open
                  </button>
                </div>
              </div>
              {acknowledgments.map(item => (
                <div className="ackRow" key={`${item.label}-${item.url}`}>
                  <div className="ackCell ackTitle ellipsis">{item.label}</div>
                  <div className="ackCell ackUrl mono dim ellipsis">{item.url}</div>
                  <div className="ackCell ackActionCell">
                    <button
                      className="btn small"
                      disabled={!canOpenExternal}
                      onClick={() => onOpenLink(item.url)}
                    >
                      Open
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
