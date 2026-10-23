import { RefreshIcon } from "../icons";
import React, { useEffect, useState } from "react";
import type { SaveActionRunner, SaveSnapshot, SaveSnapshotPreview } from "../types";
import { formatBytes, formatUserError, formatWhenMs } from "../ui-helpers";
import { HelpTip } from "./HelpTip";

type Props = { runAction: SaveActionRunner; busy: boolean; revision: number; onRestored: () => void };
function reasonLabel(reason: string) {
  return ({ manual: "Manual", "structured-edit": "Before editing values", "before-json-edit": "Before editing JSON",
    "before-import": "Before import", "before-restore": "Before restore" } as Record<string, string>)[reason] || reason.replace(/-/g, " ");
}
export function SaveSnapshotPanel({ runAction, busy, revision, onRestored }: Props) {
  const [snapshots, setSnapshots] = useState<SaveSnapshot[]>([]);
  const [preview, setPreview] = useState<SaveSnapshotPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let current = true;
    setLoading(true);
    setPreview(null);
    setError(null);
    runAction("listSaveSnapshots").then(result => { if (current) setSnapshots(result); })
      .catch(err => { if (current) setError(String(err?.message || err)); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [runAction, revision]);
  const disabled = busy || loading;
  async function create() {
    setLoading(true); setError(null); setStatus(""); setPreview(null);
    try { await runAction("createSaveSnapshot", { reason: "manual" }); setStatus("Snapshot created."); }
    catch (err: any) { setError(String(err?.message || err)); }
    finally { setLoading(false); }
  }
  async function review(snapshotId: string) {
    setLoading(true); setError(null); setStatus(""); setPreview(null);
    try { setPreview(await runAction("previewSaveSnapshot", { snapshotId })); }
    catch (err: any) { setError(String(err?.message || err)); }
    finally { setLoading(false); }
  }
  async function restore() {
    if (!preview) return;
    setLoading(true); setError(null); setStatus("");
    try {
      await runAction("restoreSaveSnapshot", { snapshotId: preview.snapshotId, expectedStateHash: preview.expectedStateHash });
      setPreview(null); setStatus("Snapshot restored. A recovery snapshot was created first."); onRestored();
    } catch (err: any) { setPreview(null); setError(String(err?.message || err)); }
    finally { setLoading(false); }
  }
  return <section className="saveSnapshots" aria-label="Save snapshots">
    <div className="saveSnapshotToolbar">
      <button className="btn primary" disabled={disabled} onClick={create}>Create snapshot</button>
      <HelpTip label="About save snapshots">Snapshots keep copies of this game's saves. Restore reviews the files first.</HelpTip>
      <button className="btn iconOnly" title="Reload snapshots" aria-label="Reload snapshots" disabled={disabled} onClick={async () => {
        setLoading(true); setError(null); setPreview(null);
        try { setSnapshots(await runAction("listSaveSnapshots")); }
        catch (err: any) { setError(String(err?.message || err)); }
        finally { setLoading(false); }
      }}><RefreshIcon /></button></div>
    {error && <div className="error" role="alert">{formatUserError(error)}</div>}
    {status && <div className="dim" role="status">{status}</div>}
    {loading && !snapshots.length && <div className="dim" role="status">Reading snapshots…</div>}
    {!loading && !snapshots.length && <div className="empty">No snapshots yet.</div>}
    <div className="saveList">{snapshots.map(snapshot => <div className="saveRow" key={snapshot.id}>
      <div className="saveRowMain"><div className="saveName">{formatWhenMs(snapshot.createdAt)}</div>
        <div className="dim saveMeta">{reasonLabel(snapshot.reason)} · {snapshot.files.length} files · {formatBytes(snapshot.totalBytes)}</div></div>
      <button className="btn" disabled={disabled} onClick={() => review(snapshot.id)}>Review restore</button>
    </div>)}</div>
    {preview && <section className="saveRestorePreview" aria-label="Restore preview">
      <div className="saveSectionTitle">Restore {formatWhenMs(preview.createdAt)}</div>
      {preview.changes.length ? <>
        <ul>{preview.changes.map(change => <li key={change.name}><span>{change.operation === "replace" ? "Replace" : "Create"}</span>{" "}
          <span className="mono">{change.name}</span> <span className="dim">· {formatBytes(change.size)}</span></li>)}</ul>
        <p className="dim">Current saves will be backed up before restoring{preview.keptFiles.length ? `; ${preview.keptFiles.length} additional files will be kept` : ""}.</p>
      </> : <p className="dim">These files already match the snapshot.</p>}
      {preview.keptFiles.length > 0 && <details className="saveNotes"><summary>Additional files kept ({preview.keptFiles.length})</summary>
        <ul>{preview.keptFiles.map(name => <li className="mono" key={name}>{name}</li>)}</ul></details>}
      <div className="modalActions"><button className="btn primary" disabled={disabled || !preview.changes.length} onClick={restore}>Restore these files</button>
        <button className="btn" disabled={disabled} onClick={() => setPreview(null)}>Cancel</button></div>
    </section>}
  </section>;
}
