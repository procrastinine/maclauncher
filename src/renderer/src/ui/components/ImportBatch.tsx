import { prioritizeDroppedPaths } from "../drop-path-utils.mjs";
import { closePopoversForDrop, dropGameTargets, graphicsDropTargets } from "../drop-game-targets.mjs";
const INTERNAL_GAME_DRAG_TYPE = "application/x-maclauncher-gamepath";
import React, { useEffect, useRef, useState } from "react";
import { runImportBatch, resolveImportFailure, type ImportBatch } from "../import-batch.mjs";
import type { ImportProgress as ImportJob, ModuleManifest } from "../types";
import { ImportProgress } from "./ImportProgress";
import { FolderIcon, XIcon } from "../icons";
import { formatUserError } from "../ui-helpers";
import { useNoticeTimeout } from "../use-notice-timeout";
import "./import-batch.css";

type Batch = ImportBatch & { id: number; resolving?: number };
type ImportApi = { addRecent(path: string): Promise<unknown>; openGameDialog(): Promise<string[]>; revealInFinder?(path: string): Promise<boolean> };
const itemName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() || path;

export function useImportBatches(api: ImportApi | undefined) {
  const [batches, setBatches] = useState<Batch[]>([]);
  const nextId = useRef(0);
  async function addPaths(paths: string[]) {
    if (!api || !paths.length) return;
    const id = ++nextId.current;
    setBatches(previous => [...previous, { id, total: paths.length, completed: 0, added: 0, currentPath: paths[0], failures: [] }]);
    await runImportBatch(paths, path => api.addRecent(path), progress => {
      setBatches(previous => previous.map(batch => batch.id === id ? { id, ...progress } : batch));
    });
  }
  // A failure is resolved by a chosen file (true), a retry (false) or the
  // games found inside its folder (their paths).
  async function resolve(batch: Batch, index: number, choose: boolean | string[]) {
    if (!api) return;
    setBatches(previous => previous.map(row => row.id === batch.id ? { ...row, resolving: index } : row));
    try {
      const paths = Array.isArray(choose) ? choose : choose ? await api.openGameDialog() : [batch.failures[index].inputPath];
      if (!paths.length) return;
      const result = await runImportBatch(paths, path => api.addRecent(path));
      setBatches(previous => previous.map(row => row.id === batch.id ? { ...row, ...resolveImportFailure(row, index, result) } : row));
    } catch (error: any) {
      setBatches(previous => previous.map(row => row.id === batch.id ? { ...row, failures: row.failures.map((failure, i) =>
        i === index ? { ...failure, reason: String(error?.message || error) } : failure) } : row));
    } finally {
      setBatches(previous => previous.map(row => row.id === batch.id ? { ...row, resolving: undefined } : row));
    }
  }
  // Removing a failure only takes it off the list; the file is not touched. A
  // batch whose last failure is removed has nothing left to report.
  const remove = (batch: Batch, index: number) => setBatches(previous => previous.flatMap(row => {
    if (row.id !== batch.id) return [row];
    const failures = row.failures.filter((_, i) => i !== index);
    return failures.length ? [{ ...row, failures }] : [];
  }));
  const reveal = (inputPath: string) => { void api?.revealInFinder?.(inputPath).catch(() => {}); };
  return { batches, addPaths, resolve, remove, reveal, dismiss: (id: number) => setBatches(previous => previous.filter(batch => batch.id !== id)) };
}

type Props = Omit<ReturnType<typeof useImportBatches>, "remove" | "reveal"> & Partial<Pick<ReturnType<typeof useImportBatches>, "remove" | "reveal">> &
  { jobs: ImportJob[]; onCancel(path: string): void };
// Running batches and fully added ones keep their own notices. Every failure of
// the finished batches is listed in one banner with a single Dismiss.
export function ImportBatches({ batches, jobs, onCancel, resolve, dismiss, remove = () => {}, reveal = () => {} }: Props) {
  const batchPaths = new Set(batches.map(batch => batch.currentPath));
  const failed = batches.filter(batch => !batch.currentPath && batch.failures.length);
  return <div className="importBatches">
    {batches.filter(batch => !failed.includes(batch)).map(batch =>
      <ImportBatchNotice key={batch.id} batch={batch} jobs={jobs} onCancel={onCancel} resolve={resolve} dismiss={dismiss} />)}
    {failed.length > 0 && <ImportFailures batches={failed} resolve={resolve} dismiss={dismiss} remove={remove} reveal={reveal} />}
    <ImportProgress jobs={jobs.filter(job => !batchPaths.has(job.inputPath))} onCancel={onCancel} />
  </div>;
}

// A damaged or incomplete game cannot be fixed by choosing another file or
// trying again, so its row offers Show in Finder and Remove only. A folder
// whose subfolders hold games lists each one with Add, and Add all when they
// are separate games; trying the folder again would find the same.
type FailureProps = Pick<Props, "resolve" | "dismiss"> & Pick<ReturnType<typeof useImportBatches>, "remove" | "reveal"> & { batches: Batch[] };
function ImportFailures({ batches, resolve, dismiss, remove, reveal }: FailureProps) {
  const busy = batches.some(batch => batch.resolving !== undefined);
  const added = batches.reduce((sum, batch) => sum + batch.added, 0), total = batches.reduce((sum, batch) => sum + batch.total, 0);
  return <section className="importBatch" aria-label="Import results">
    <div className="importBatchHeading">
      <strong role="status">Added {added} of {total}</strong>
      <button className="btn small" disabled={busy} onClick={() => batches.forEach(batch => dismiss(batch.id))}>Dismiss</button>
    </div>
    <ul className="importBatchFailures">
      {batches.flatMap(batch => batch.failures.map((failure, index) => {
        const found = failure.nestedGames || [], separate = new Set(found.map(game => game.gamePath)).size === found.length;
        return <li key={`${batch.id}:${index}:${failure.inputPath}`}>
        <div><strong>{itemName(failure.inputPath)}</strong><div className="dim">{formatUserError(failure.reason)}</div>
          {found.length > 0 && <ul className="importBatchFound" aria-label={`Games found in ${itemName(failure.inputPath)}`}>
            {found.map(game => <li key={game.inputPath}>
              <span><strong>{game.name}</strong> <span className="dim">{game.relativePath}{game.label ? ` · ${game.label}` : ""}</span></span>
              <button className="btn small" disabled={busy} aria-label={`Add ${game.relativePath}`}
                onClick={() => void resolve(batch, index, [game.inputPath])}>Add</button>
            </li>)}
          </ul>}
        </div>
        <div className="importBatchActions">
          {failure.code === "DETECTION_INVALID_INPUT" ? <>
            <button className="btn small iconOnly" title="Show in Finder" aria-label={`Show ${itemName(failure.inputPath)} in Finder`}
              onClick={() => reveal(failure.inputPath)}><FolderIcon /></button>
          </> : <>
            {found.length > 1 && separate && <button className="btn small" disabled={busy}
              onClick={() => void resolve(batch, index, found.map(game => game.inputPath))}>Add all</button>}
            <button className="btn small" disabled={busy} onClick={() => void resolve(batch, index, true)}>
              {batch.resolving === index ? "Adding…" : "Choose game file…"}</button>
            {!found.length && <button className="btn small" disabled={busy} onClick={() => void resolve(batch, index, false)}>Retry</button>}
          </>}
          <button className="btn small iconOnly" disabled={busy} title="Remove from this list" aria-label={`Remove ${itemName(failure.inputPath)} from this list`}
            onClick={() => remove(batch, index)}><XIcon /></button>
        </div>
      </li>;
      }))}
    </ul>
  </section>;
}

// A finished batch with every item added closes on its own; running batches and
// unresolved failures stay until handled. ImportFailures lists the failures.
type NoticeProps = Pick<Props, "jobs" | "onCancel" | "dismiss"> & Partial<Pick<Props, "resolve">> & { batch: Batch };
export function ImportBatchNotice({ batch, jobs, onCancel, dismiss }: NoticeProps) {
  const hold = useNoticeTimeout(!batch.currentPath && !batch.failures.length, () => dismiss(batch.id));
  return <section className="importBatch" aria-label="Import results" {...hold}>
    {batch.currentPath ? <>
      <div className="importBatchHeading" role="status">
        <strong>Adding {batch.completed + 1} of {batch.total}</strong>
        <span className="importBatchName">{itemName(batch.currentPath)}</span>
        <progress aria-label="Batch progress" max={batch.total} value={batch.completed} />
      </div>
      <ImportProgress jobs={jobs.filter(job => job.inputPath === batch.currentPath)} onCancel={onCancel} />
    </> : <>
      <div className="importBatchHeading">
        <strong role="status">Added {batch.added} of {batch.total}</strong>
        <button className="btn small" disabled={batch.resolving !== undefined} onClick={() => dismiss(batch.id)}>Dismiss</button>
      </div>
    </>}
  </section>;
}

type DropGameHintProps = {
  className?: string;
  title: string;
  action?: React.ReactNode;
  modules: ModuleManifest[];
};

export function DropGameHint({ className, title, action, modules }: DropGameHintProps) {
  return (
    <div className={["dropHint", className || ""].filter(Boolean).join(" ")}>
      <div className="dropHintTitle">{title}</div>
      {[{ label: "Games", targets: dropGameTargets(modules) }, { label: "Shaders and models", targets: graphicsDropTargets }].map(group => (
        <div className="dropHintGroup" key={group.label}>
          <div className="dropHintSubtitle">{group.label}</div>
          <div className="dropHintFormats" aria-label={`Supported ${group.label.toLowerCase()} inputs`}>
            {group.targets.map(target => (
              <span key={target.label} className={["badge", "dropHintFormat", target.mono ? "mono" : ""].filter(Boolean).join(" ")}>
                {target.label}
              </span>
            ))}
          </div>
        </div>
      ))}
      {action ? <div className="dropHintAction">{action}</div> : null}
    </div>
  );
}


export function useLauncherDrop(api: NonNullable<Window["MacLauncher"]>["launcher"] | undefined, importBatches: ReturnType<typeof useImportBatches>, setError: (value: string | null) => void) {
  const [addDropActive, setAddDropActive] = useState(false);
  const addDropDepth = useRef(0);
  // A drag that ends outside the window or is cancelled can leave the enter and
  // leave counts unbalanced. The overlay closes on any sign that no drag is over
  // the window: no dragover for a second (a drag repeats it at least every
  // 550 ms), a drop or drag end anywhere, focus loss, pointer movement or Escape.
  useEffect(() => {
    if (!addDropActive) return;
    let last = performance.now();
    const clear = () => { addDropDepth.current = 0; setAddDropActive(false); };
    const seen = () => { last = performance.now(); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") clear(); };
    const timer = window.setInterval(() => { if (performance.now() - last > 1000) clear(); }, 250);
    const capture: Array<[string, EventListener]> = [["dragenter", seen], ["dragover", seen], ["drop", clear], ["dragend", clear], ["pointermove", clear], ["keydown", key as EventListener]];
    for (const [type, listener] of capture) window.addEventListener(type, listener, true);
    window.addEventListener("blur", clear);
    return () => {
      window.clearInterval(timer);
      for (const [type, listener] of capture) window.removeEventListener(type, listener, true);
      window.removeEventListener("blur", clear);
    };
  }, [addDropActive]);
  function isInternalGameDrag(ev: React.DragEvent) {
    return Array.from(ev.dataTransfer.types || []).includes(INTERNAL_GAME_DRAG_TYPE);
  }

  // The add overlay is for files dragged in from outside the launcher. Drags
  // that start inside it (reordering, sliders) carry no files.
  function isExternalFileDrag(ev: React.DragEvent) {
    return !isInternalGameDrag(ev) && Array.from(ev.dataTransfer.types || []).includes("Files");
  }

  function onAppDragEnter(ev: React.DragEvent) {
    if (!isExternalFileDrag(ev)) return;
    closePopoversForDrop();
    addDropDepth.current += 1;
    setAddDropActive(true);
  }

  function onAppDragLeave(ev: React.DragEvent) {
    if (!isExternalFileDrag(ev)) return;
    addDropDepth.current = Math.max(0, addDropDepth.current - 1);
    if (addDropDepth.current === 0) setAddDropActive(false);
  }

  function onAppDragOver(ev: React.DragEvent) {
    if (!isExternalFileDrag(ev)) return;
    ev.preventDefault();
  }

  async function onDropAdd(ev: React.DragEvent) {
    const handled=ev.defaultPrevented;
    ev.preventDefault();
    if (!isExternalFileDrag(ev)) return;
    if (!api) return;
    const launcherApi = api;
    addDropDepth.current = 0;
    setAddDropActive(false);
    if(handled)return;
    setError(null);
    try {
      const paths = new Set<string>();

      async function addFilePath(f: any) {
        if (!f) return;
        if (typeof f?.path === "string" && f.path) {
          paths.add(f.path);
          return;
        }
        if (typeof launcherApi.getPathForFile === "function") {
          const maybe = launcherApi.getPathForFile(f);
          const p = await Promise.resolve(maybe as any);
          if (typeof p === "string" && p) paths.add(p);
        }
      }

      const files = Array.from(ev.dataTransfer.files || []);
      for (const f of files as any[]) {
        await addFilePath(f);
      }

      const items = Array.from(ev.dataTransfer.items || []);
      for (const item of items) {
        if (item.kind !== "file") continue;
        const file = item.getAsFile() as any;
        await addFilePath(file);
      }

      function addFileUrl(url: string) {
        try {
          const u = new URL(url);
          if (u.protocol !== "file:") return;
          let p = decodeURIComponent(u.pathname);
          p = p.replace(/^\/([a-zA-Z]:\/)/, "$1");
          if (p) paths.add(p);
        } catch {}
      }

      function addPlainPath(raw: string) {
        let p = String(raw || "").trim();
        if (!p) return;
        p = p.replace(/^["']+|["']+$/g, "").trim();
        if (!p) return;
        if (p.startsWith("file:")) {
          addFileUrl(p);
          return;
        }
        if (p.includes("%")) {
          try {
            p = decodeURIComponent(p);
          } catch {}
        }
        if (p.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(p)) {
          paths.add(p);
        }
      }

      const uriList = ev.dataTransfer.getData("text/uri-list");
      if (uriList) {
        for (const line of uriList.split(/\r?\n/g)) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) continue;
          if (trimmed.startsWith("file:")) addFileUrl(trimmed);
          else addPlainPath(trimmed);
        }
      }

      const text = ev.dataTransfer.getData("text/plain");
      if (text) {
        for (const line of text.split(/\r?\n/g)) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          addPlainPath(trimmed);
        }
      }

      const candidates = prioritizeDroppedPaths(paths);
      if (candidates.length === 0) {
        throw new Error("Could not read dropped file paths. Drag files from Finder again or use an import chooser.");
      }

      await importBatches.addPaths(candidates);
    } catch (e: any) {
      if (/Import cancelled\./.test(String(e?.message || e))) return;
      setError(String(e?.message || e));
    }
  }

  return {addDropActive, onAppDragEnter, onAppDragLeave, onAppDragOver, onDropAdd};
}
