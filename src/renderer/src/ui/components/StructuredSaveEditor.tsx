import React, { useEffect, useMemo, useState } from "react";
import type { SaveActionRunner, StructuredSaveInspection } from "../types";
import { draftChanges, structuredFields, valueDraft } from "./save-tools-model";
import type { SaveDraft, SaveField, SaveView, ScalarType } from "./save-tools-model";
import { formatUserError } from "../ui-helpers";

type Props = {
  fileName: string; actions: { inspectAction: string; editAction: string };
  runAction: SaveActionRunner; busy: boolean; onClose: () => void;
};
const PAGE_SIZE = 50;
const VIEWS: Array<{ id: SaveView; label: string }> = [
  { id: "switches", label: "Switches" }, { id: "variables", label: "Variables" },
  { id: "party", label: "Gold & inventory" }, { id: "actors", label: "Actors" }
];

function ValueInput({ field, draft, disabled, onChange }: {
  field: SaveField; draft: SaveDraft; disabled: boolean; onChange: (next: SaveDraft) => void;
}) {
  if (!field.editable) return <span className="dim" title={field.reason}>{field.reason || "Read-only"}</span>;
  const id = `save-value-${field.key}`;
  return <div className="structuredValue">
    {field.kind === "variable" && <select value={draft.type} disabled={disabled} aria-label={`${field.label} type`}
      onChange={event => {
        const type = event.target.value as ScalarType;
        onChange({ type, text: type === "boolean" ? "false" : type === "number" ? "0" : "" });
      }}>
      <option value="number">Number</option><option value="string">Text</option>
      <option value="boolean">Boolean</option><option value="null">Null</option>
    </select>}
    {draft.type === "boolean" ? <label className="structuredCheckbox" htmlFor={id}>
      <input id={id} type="checkbox" disabled={disabled} checked={draft.text === "true"}
        onChange={event => onChange({ type: "boolean", text: String(event.target.checked) })} />
      {draft.text === "true" ? "True" : "False"}
    </label> : draft.type === "null" ? <span className="dim">null</span> :
      <input id={id} type="text" inputMode={draft.type === "number" ? "decimal" : "text"} value={draft.text}
        disabled={disabled} aria-label={field.label} spellCheck={false}
        onChange={event => onChange({ ...draft, text: event.target.value })} />}
  </div>;
}

export function StructuredSaveEditor({ fileName, actions, runAction, busy, onClose }: Props) {
  const [inspection, setInspection] = useState<StructuredSaveInspection | null>(null);
  const [drafts, setDrafts] = useState<Record<string, SaveDraft>>({});
  const [view, setView] = useState<SaveView>("switches");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(null);
    setDrafts({});
    runAction(actions.inspectAction, { fileName }).then(result => { if (current) setInspection(result); })
      .catch(err => { if (current) setError(String(err?.message || err)); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [fileName, actions.inspectAction, runAction]);
  const groups = useMemo(() => inspection ? structuredFields(inspection) : null, [inspection]);
  const allFields = useMemo(() => groups ? Object.values(groups).flat() : [], [groups]);
  const visible = useMemo(() => (groups?.[view] || []).filter(field => !query.trim() ||
    `${field.label} ${field.detail}`.toLowerCase().includes(query.trim().toLowerCase())), [groups, view, query]);
  const pages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  const disabled = busy || loading;
  async function reload() {
    setLoading(true); setError(null); setStatus("");
    try { setInspection(await runAction(actions.inspectAction, { fileName })); setDrafts({}); }
    catch (err: any) { setError(String(err?.message || err)); }
    finally { setLoading(false); }
  }
  async function save() {
    if (!inspection) return;
    setError(null); setStatus("");
    try {
      const changes = draftChanges(allFields, drafts);
      if (!changes.length) { setDrafts({}); setStatus("No changes to save."); return; }
      setLoading(true);
      const result: StructuredSaveInspection = await runAction(actions.editAction,
        { fileName, expectedHash: inspection.sourceHash, changes });
      setInspection(result); setDrafts({});
      setStatus(`Saved ${result.changed || changes.length} ${changes.length === 1 ? "change" : "changes"}.`);
    } catch (err: any) { setError(String(err?.message || err)); }
    finally { setLoading(false); }
  }
  return <section className="structuredEditor" aria-label={`Edit values in ${fileName}`} onKeyDown={event => {
    if (event.metaKey && event.key.toLowerCase() === "s") {
      event.preventDefault(); if (!disabled && inspection && Object.keys(drafts).length) void save();
    }
  }}>
    <div className="editorHeader"><div className="editorTitle">Values: {fileName}</div><div className="editorActions">
      <button className="btn" disabled={disabled} onClick={reload}>Reload save</button>
      <button className="btn primary" disabled={disabled || !inspection || !Object.keys(drafts).length} onClick={save}>Save changes</button>
      <button className="btn" disabled={disabled} onClick={onClose}>Close editor</button>
    </div></div>
    {error && <div className="error" role="alert">{formatUserError(error)}</div>}
    {status && <div className="dim" role="status">{status}</div>}
    {loading && !inspection && <div className="dim" role="status">Reading save…</div>}
    {groups && <>
      <div className="structuredToolbar">
        <label>View <select value={view} disabled={disabled} onChange={event => { setView(event.target.value as SaveView); setPage(0); }}>
          {VIEWS.map(item => <option key={item.id} value={item.id}>{item.label} ({groups[item.id].length})</option>)}
        </select></label>
        <input type="search" placeholder="Find a name or ID" aria-label="Find save value" value={query}
          disabled={disabled} onChange={event => { setQuery(event.target.value); setPage(0); }} />
        <span className="dim">{Object.keys(drafts).length} pending</span>
      </div>
      <div className="structuredRows">
        {visible.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map(field => <div className="structuredRow" key={field.key}>
          <div className="structuredLabel"><label htmlFor={`save-value-${field.key}`}>{field.label}</label><span className="dim">{field.detail}</span></div>
          <ValueInput field={field} draft={drafts[field.key] || valueDraft(field.value)} disabled={disabled}
            onChange={next => { setStatus(""); setDrafts(previous => {
              const updated = { ...previous };
              const original = valueDraft(field.value);
              if (next.type === original.type && next.text === original.text) delete updated[field.key];
              else updated[field.key] = next;
              return updated;
            }); }} />
        </div>)}
        {!visible.length && <div className="empty">No values in this view.</div>}
      </div>
      {pages > 1 && <div className="structuredPagination">
        <button className="btn" disabled={disabled || currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</button>
        <span className="dim">Page {currentPage + 1} of {pages}</span>
        <button className="btn" disabled={disabled || currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>Next</button>
      </div>}
      {inspection?.warnings.length ? <details className="saveNotes"><summary>Save notes ({inspection.warnings.length})</summary>
        <ul>{inspection.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details> : null}
    </>}
  </section>;
}
