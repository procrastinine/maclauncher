import type { ImportProgress as ImportJob } from "../types";

const phaseLabel = (phase: string) => phase === "queued" ? "Queued" : phase === "extracting" ? "Unpacking…" :
  phase === "verifying" ? "Checking…" : "Adding…";

export function ImportProgress({ jobs, onCancel }: { jobs: ImportJob[]; onCancel: (path: string) => void }) {
  if (!jobs.length) return null;
  return <div className="importProgressList" aria-label="Adding games">
    {jobs.map(job => <div className="importProgressRow" key={job.inputPath}>
      <span className="importProgressName" title={job.inputPath}>{job.inputPath.split(/[\\/]/).pop()}</span>
      <span className="dim">{phaseLabel(job.phase)}</span>
      <progress aria-label={`Adding ${job.inputPath.split(/[\\/]/).pop()}`} max={job.total && job.total > 0 ? job.total : 1}
        value={job.total && job.total > 0 ? Math.min(job.completed || 0, job.total) : undefined} />
      <button className="btn small" onClick={() => onCancel(job.inputPath)}>Cancel</button>
    </div>)}
  </div>;
}
