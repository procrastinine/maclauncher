import { useRef, useState } from "react";
import { runImportBatch, resolveImportFailure, type ImportBatch } from "../import-batch.mjs";
import type { ImportProgress as ImportJob } from "../types";
import { ImportProgress } from "./ImportProgress";
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
  async function resolve(batch: Batch, index: number, choose: boolean) {
    if (!api) return;
    setBatches(previous => previous.map(row => row.id === batch.id ? { ...row, resolving: index } : row));
    try {
      const paths = choose ? await api.openGameDialog() : [batch.failures[index].inputPath];
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
// trying again, so its row offers Show in Finder and Remove only.
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
      {batches.flatMap(batch => batch.failures.map((failure, index) => <li key={`${batch.id}:${index}:${failure.inputPath}`}>
        <div><strong>{itemName(failure.inputPath)}</strong><div className="dim">{formatUserError(failure.reason)}</div></div>
        <div className="importBatchActions">
          {failure.code === "DETECTION_INVALID_INPUT" ? <>
            <button className="btn small" onClick={() => reveal(failure.inputPath)}>Show in Finder</button>
          </> : <>
            <button className="btn small" disabled={busy} onClick={() => void resolve(batch, index, true)}>
              {batch.resolving === index ? "Adding…" : "Choose game file…"}</button>
            <button className="btn small" disabled={busy} onClick={() => void resolve(batch, index, false)}>Retry</button>
          </>}
          <button className="btn small" disabled={busy} aria-label={`Remove ${itemName(failure.inputPath)} from this list`}
            onClick={() => remove(batch, index)}>Remove</button>
        </div>
      </li>))}
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
