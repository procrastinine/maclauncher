import { useRef, useState } from "react";
import { runImportBatch, resolveImportFailure, type ImportBatch } from "../import-batch.mjs";
import type { ImportProgress as ImportJob } from "../types";
import { ImportProgress } from "./ImportProgress";
import { formatUserError } from "../ui-helpers";
import "./import-batch.css";

type Batch = ImportBatch & { id: number; resolving?: number };
type ImportApi = { addRecent(path: string): Promise<unknown>; openGameDialog(): Promise<string[]> };
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
  return { batches, addPaths, resolve, dismiss: (id: number) => setBatches(previous => previous.filter(batch => batch.id !== id)) };
}

type Props = ReturnType<typeof useImportBatches> & { jobs: ImportJob[]; onCancel(path: string): void };
export function ImportBatches({ batches, jobs, onCancel, resolve, dismiss }: Props) {
  const batchPaths = new Set(batches.map(batch => batch.currentPath));
  return <div className="importBatches">
    {batches.map(batch => <section className="importBatch" key={batch.id} aria-label="Import results">
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
        {batch.failures.length > 0 && <ul className="importBatchFailures">
          {batch.failures.map((failure, index) => <li key={`${index}:${failure.inputPath}`}>
            <div><strong>{itemName(failure.inputPath)}</strong><div className="dim">{formatUserError(failure.reason)}</div></div>
            <div className="importBatchActions">
              <button className="btn small" disabled={batch.resolving !== undefined} onClick={() => void resolve(batch, index, true)}>
                {batch.resolving === index ? "Adding…" : "Choose game file…"}</button>
              <button className="btn small" disabled={batch.resolving !== undefined} onClick={() => void resolve(batch, index, false)}>Retry</button>
            </div>
          </li>)}
        </ul>}
      </>}
    </section>)}
    <ImportProgress jobs={jobs.filter(job => !batchPaths.has(job.inputPath))} onCancel={onCancel} />
  </div>;
}
