import React, { useEffect, useId, useRef, useState } from "react";
import { editorRows, knownVariable, lockedRule, normalizeValues, type TranslatorEnvironmentDeclaration,
  type TranslatorEnvironmentRow as Row, type TranslatorEnvironmentStore, type TranslatorEnvironmentValues } from "../../../../modules/shared/runtime/translator-environment.mjs";
import { CommitTextInput } from "./CommitInput";
import { ErrorText } from "./ErrorText";
import { HelpTip } from "./HelpTip";
import { StatusBadge } from "./StatusBadge";
import { XIcon } from "../icons";

type Scope = "global" | "game";

const SOURCE_LABELS: Record<string, string> = { default: "Default", global: "Global", earlier: "Earlier setting" };

// One translator's variables at one scope. Rows inherited from a lower layer
// can be changed or removed for this scope; Restore returns to the inherited
// value. Values are stored exactly as typed and apply on the next launch.
export function TranslatorEnvironmentEditor({ declaration, related = [], scope, global, earlier, game, detail, disabled = false, onSave }: {
  declaration: TranslatorEnvironmentDeclaration; related?: TranslatorEnvironmentDeclaration[]; scope: Scope;
  global?: TranslatorEnvironmentValues; earlier?: TranslatorEnvironmentValues; game?: TranslatorEnvironmentValues;
  detail?: string; disabled?: boolean;
  onSave: (values: TranslatorEnvironmentValues | null) => Promise<unknown>;
}) {
  const rows = editorRows(declaration, { scope, global, earlier, game });
  // A stored variable that a later version locks is shown as not applied and
  // is dropped by the next save.
  const own: TranslatorEnvironmentValues = Object.fromEntries(Object.entries((scope === "game" ? game : global) || {})
    .filter(([name]) => !lockedRule([declaration], name)));
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const nameInput = useRef<HTMLInputElement>(null);
  const listId = useId();
  const label = declaration.label;
  const present = new Set(rows.filter(row => row.state !== "removed").map(row => row.name));
  const suggestions = declaration.keys.filter(item => !present.has(item.key));
  const typed = name.trim();
  // A variable another chosen translator documents keeps its description and
  // launcher note here too.
  const known = (name: string) => knownVariable(declaration, name) || related.map(item => knownVariable(item, name)).find(Boolean) || null;
  const typedKnown = known(typed);
  const typedLocked = typed ? lockedRule([declaration], typed) : null;

  async function save(next: TranslatorEnvironmentValues) {
    setError(null);
    try {
      const values = normalizeValues(next, { declarations: [declaration] });
      await onSave(Object.keys(values).length ? values : null);
      return true;
    } catch (failure: any) {
      setError(String(failure?.message || failure));
      return false;
    }
  }
  function commitValue(row: Row, text: string) {
    const next = { ...own };
    if (row.inheritedValue !== undefined && text === row.inheritedValue) delete next[row.name];
    else next[row.name] = text;
    return save(next);
  }
  function remove(row: Row) {
    const next = { ...own };
    if (row.inheritedValue !== undefined) next[row.name] = null;
    else delete next[row.name];
    return save(next);
  }
  function restore(row: Row) {
    const next = { ...own };
    delete next[row.name];
    return save(next);
  }
  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (!typed) { nameInput.current?.focus(); return; }
    if (await save({ ...own, [typed]: value })) {
      setName(""); setValue("");
      nameInput.current?.focus();
    }
  }
  const resetLabel = scope === "game" ? `Use the global ${label} values` : `Restore the default ${label} values`;
  const busy = disabled;

  return <section className="translatorEnvironment" aria-label={`${label} environment`}>
    <div className="translatorEnvironmentHeader">
      <div className="translatorEnvironmentTitle">{label}
        {declaration.description && <HelpTip label={`About ${label} environment`}>
          <p>{declaration.description}</p>
          <p>Values are passed exactly as written, without shell expansion. Changes apply on the next launch.</p>
        </HelpTip>}
        {detail && <span className="dim translatorEnvironmentDetail">{detail}</span>}
      </div>
      <button type="button" className="btn small" disabled={busy || Object.keys(own).length === 0}
        title={resetLabel} aria-label={resetLabel} onClick={() => void save({})}>Reset</button>
    </div>
    {rows.length ? <div className="translatorEnvironmentRows" role="list" aria-label={`${label} variables`}>
      {rows.map(row => {
        const removed = row.state === "removed";
        const info = known(row.name);
        const launcher = !removed && !row.locked && info?.launcher;
        const tip = info?.description;
        return <div className={`translatorEnvironmentRow${removed ? " removed" : ""}`} role="listitem" key={row.name}>
          <span className="translatorEnvironmentName mono" title={tip || undefined}>{row.name}</span>
          <span className="translatorEnvironmentEquals" aria-hidden="true">=</span>
          {removed
            ? <span className="translatorEnvironmentRemovedValue mono">{row.inheritedValue}</span>
            : <CommitTextInput className="input mono translatorEnvironmentValue" aria-label={`${row.name} value`} spellCheck={false}
              value={row.value ?? ""} disabled={busy} onCommit={text => commitValue(row, text)} />}
          <span className="translatorEnvironmentState">
            {row.state === "inherited" && <StatusBadge title={row.inheritedSource === "earlier"
              ? "From the Environment variables setting of an earlier MacLauncher version." : undefined}>
              {SOURCE_LABELS[row.inheritedSource || ""] || "Inherited"}</StatusBadge>}
            {row.state === "changed" && <StatusBadge>Changed</StatusBadge>}
            {row.state === "added" && scope === "game" && <StatusBadge>This game</StatusBadge>}
            {removed && <StatusBadge>Removed</StatusBadge>}
            {launcher && <StatusBadge tone="warning" title={launcher}>Replaces launcher value</StatusBadge>}
            {row.locked && !removed && <StatusBadge tone="danger" title={`${row.name} is set by MacLauncher. ${row.locked.reason}`}>Not applied</StatusBadge>}
          </span>
          <span className="translatorEnvironmentActions">
            {(row.state === "changed" || removed)
              ? <button type="button" className="btn small" disabled={busy} aria-label={`Restore ${row.name}`}
                title={`Restore the ${SOURCE_LABELS[row.inheritedSource || ""]?.toLowerCase() || "inherited"} value`}
                onClick={() => void restore(row)}>Restore</button>
              : <button type="button" className="btn small iconOnly" disabled={busy} aria-label={`Remove ${row.name}`}
                title={row.state === "inherited" ? `Remove ${row.name} for ${scope === "game" ? "this game" : "all games"}` : `Remove ${row.name}`}
                onClick={() => void remove(row)}><XIcon /></button>}
          </span>
        </div>;
      })}
    </div> : <div className="dim translatorEnvironmentEmpty">No variables.</div>}
    <form className="translatorEnvironmentAdd" onSubmit={add} aria-label={`Add a ${label} variable`}>
      <input ref={nameInput} className="input mono translatorEnvironmentNameInput" aria-label={`New ${label} variable name`}
        placeholder="NAME" list={listId} spellCheck={false} autoCapitalize="off" autoCorrect="off" disabled={busy}
        aria-invalid={Boolean(typedLocked) || undefined}
        value={name} onChange={event => { setName(event.currentTarget.value); setError(null); }}
        onKeyDown={event => { if (event.key === "Escape" && (name || value)) { event.preventDefault(); event.stopPropagation(); setName(""); setValue(""); } }} />
      <span className="translatorEnvironmentEquals" aria-hidden="true">=</span>
      <input className="input mono translatorEnvironmentValue" aria-label={`New ${label} variable value`} placeholder="value"
        spellCheck={false} autoCapitalize="off" autoCorrect="off" disabled={busy} value={value}
        onChange={event => { setValue(event.currentTarget.value); setError(null); }}
        onKeyDown={event => { if (event.key === "Escape" && (name || value)) { event.preventDefault(); event.stopPropagation(); setName(""); setValue(""); nameInput.current?.focus(); } }} />
      <button type="submit" className="btn small" disabled={busy || !typed || Boolean(typedLocked)}>Add</button>
      <datalist id={listId}>{suggestions.map(item => <option key={item.key} value={item.key}>{item.description}</option>)}</datalist>
    </form>
    {typedLocked ? <div className="dim translatorEnvironmentHint">{typed} is set by MacLauncher. {typedLocked.reason}</div>
      : typedKnown ? <div className="dim translatorEnvironmentHint">{typedKnown.description}{typedKnown.launcher ? " " + typedKnown.launcher : ""}</div> : null}
    <ErrorText error={error} inline />
  </section>;
}

// Every translator a scope edits, under one Environment heading.
export function TranslatorEnvironmentList({ declarations, scope, globalStore, gameStore, earlier, details, disabled, intro, onSave }: {
  declarations: TranslatorEnvironmentDeclaration[]; scope: Scope;
  globalStore?: TranslatorEnvironmentStore; gameStore?: TranslatorEnvironmentStore;
  earlier?: TranslatorEnvironmentStore; details?: Record<string, string>;
  disabled?: boolean; intro?: React.ReactNode;
  onSave: (id: string, values: TranslatorEnvironmentValues | null) => Promise<unknown>;
}) {
  if (!declarations.length) return null;
  return <div className="translatorEnvironmentList">
    {intro && <p className="dim translatorEnvironmentIntro">{intro}</p>}
    {declarations.map(declaration => <TranslatorEnvironmentEditor key={declaration.id} declaration={declaration} related={declarations} scope={scope}
      global={globalStore?.[declaration.id]} game={gameStore?.[declaration.id]} earlier={earlier?.[declaration.id]}
      detail={details?.[declaration.id]} disabled={disabled} onSave={values => onSave(declaration.id, values)} />)}
  </div>;
}

// The Runtimes window's global editor for the translators a runtime manager runs.
export function RuntimeTranslatorEnvironments({ managerId, declarations, store, onSave }: {
  managerId: string; declarations?: TranslatorEnvironmentDeclaration[]; store?: TranslatorEnvironmentStore;
  onSave: (id: string, values: TranslatorEnvironmentValues | null) => Promise<unknown>;
}) {
  const own = (declarations || []).filter(item => item.managerIds.includes(managerId));
  if (!own.length) return null;
  return <section className="runtimeSectionCard" aria-label="Environment variables">
    <div className="runtimeSectionHeader"><div>
      <div className="runtimeSectionTitle">Environment variables<HelpTip label="About runtime environment variables">
        <p>Variables passed to every game that uses {own.length === 1 ? "this translator" : "these translators"}. A game's Runtime Settings can change, add or remove them for that game.</p>
        <p>Values are passed exactly as written, without shell expansion. Changes apply on the next launch.</p>
      </HelpTip></div>
    </div></div>
    <TranslatorEnvironmentList declarations={own} scope="global" globalStore={store} onSave={onSave} />
  </section>;
}

// A game's Runtime Settings section for the translators its settings choose.
// `result` is an already loaded environment action result; `load` requests it
// again whenever `loadKey` changes.
export function GameTranslatorEnvironment({ declarations, globalStore, gameStore, result, load, loadKey, disabled, onSave }: {
  declarations?: TranslatorEnvironmentDeclaration[]; globalStore?: TranslatorEnvironmentStore; gameStore?: TranslatorEnvironmentStore;
  result?: Record<string, any>; load?: () => Promise<unknown>; loadKey: string; disabled?: boolean;
  onSave: (id: string, values: TranslatorEnvironmentValues | null) => Promise<unknown>;
}) {
  const [loaded, setLoaded] = useState<Record<string, any> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const requested = Boolean(load);
  useEffect(() => {
    if (!requested) return;
    let active = true;
    setError(null);
    Promise.resolve().then(() => loadRef.current?.()).then(value => { if (active) setLoaded(value && typeof value === "object" ? value as Record<string, any> : {}); },
      failure => { if (active) setError(String(failure?.message || failure)); });
    return () => { active = false; };
  }, [requested, loadKey]);
  const source = requested ? loaded : result;
  const ids: unknown[] = Array.isArray(source?.translatorEnvironments) ? source.translatorEnvironments : [];
  const byId = new Map((declarations || []).map(item => [item.id, item]));
  const chosen = [...new Set(ids)].map(id => byId.get(String(id))).filter((item): item is TranslatorEnvironmentDeclaration => Boolean(item));
  const earlier = source?.earlierEnvironment && typeof source.earlierEnvironment === "object" ? source.earlierEnvironment : undefined;
  return <section className="settingsStack translatorEnvironmentSection" aria-label="Environment variables">
    <div className="settingsLabel" role="heading" aria-level={3}>Environment variables</div>
    <ErrorText error={error} inline />
    {!source && !error && <div className="dim">Loading translators…</div>}
    {source && !chosen.length && <div className="dim">No translator environment applies with these settings.</div>}
    <TranslatorEnvironmentList declarations={chosen} scope="game" globalStore={globalStore} gameStore={gameStore} earlier={earlier}
      disabled={disabled} intro="Values for this game replace the global values from Runtimes and apply on the next launch." onSave={onSave} />
  </section>;
}
