import React, { useEffect, useId, useRef, useState } from "react";
import { editorRows, knownVariable, lockedRule, lockingDeclarations, managerDeclarations, normalizeValues, readValues, variableOwner,
  type TranslatorEnvironmentDeclaration,
  type TranslatorEnvironmentRow as Row, type TranslatorEnvironmentStore, type TranslatorEnvironmentValues } from "../../../../modules/shared/runtime/translator-environment.mjs";
import { CommitTextInput } from "./CommitInput";
import { ErrorText } from "./ErrorText";
import { HelpTip } from "./HelpTip";
import { StatusBadge } from "./StatusBadge";
import { XIcon } from "../icons";

type Scope = "global" | "game";
type Save = (id: string, values: TranslatorEnvironmentValues | null) => Promise<unknown>;

const SOURCE_LABELS: Record<string, string> = { default: "Default", global: "From Runtimes" };

// The values stored at a scope for one translator, without names that its
// locking translators lock. A locked name is shown as set by MacLauncher and
// is dropped by the next save.
function ownValues(locks: readonly TranslatorEnvironmentDeclaration[], store: TranslatorEnvironmentStore | undefined, id: string) {
  return Object.fromEntries(Object.entries(readValues(store?.[id])).filter(([name]) => !lockedRule(locks, name))) as TranslatorEnvironmentValues;
}

// Every variable of one scope in one table. Rows are grouped by the
// translator that stores them, in the order of `declarations`; the first is
// the runtime's own translator. A new name goes to its owner (variableOwner):
// the group that already lists it, then the translator that suggests it, and
// otherwise the runtime's own group, which applies to every game the runtime
// launches. Values are stored exactly as typed and apply on the next launch.
export function TranslatorEnvironmentTable({ declarations, scope, globalStore, gameStore, disabled = false, onSave }: {
  declarations: TranslatorEnvironmentDeclaration[]; scope: Scope;
  globalStore?: TranslatorEnvironmentStore; gameStore?: TranslatorEnvironmentStore;
  disabled?: boolean; onSave: Save;
}) {
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const nameInput = useRef<HTMLInputElement>(null);
  const listId = useId();
  const store = scope === "game" ? gameStore : globalStore;
  const groups = declarations.map(declaration => ({ declaration,
    rows: editorRows(declaration, { scope, global: globalStore?.[declaration.id], game: gameStore?.[declaration.id] }) }));
  const present = new Set(groups.flatMap(group => group.rows.filter(row => row.state !== "removed").map(row => row.name)));
  const suggestions = declarations.flatMap(declaration => declaration.keys).filter((item, index, all) =>
    !present.has(item.key) && all.findIndex(other => other.key === item.key) === index);
  const typed = name.trim();
  const known = (variable: string, preferred?: TranslatorEnvironmentDeclaration) =>
    (preferred && knownVariable(preferred, variable)) || declarations.map(item => knownVariable(item, variable)).find(Boolean) || null;
  const ownerOf = (variable: string) => variableOwner(declarations, variable, { scope, global: globalStore, game: gameStore });
  const locks = (declaration: TranslatorEnvironmentDeclaration) => lockingDeclarations(declarations, declaration, { scope });
  const typedLocked = typed ? lockedRule(locks(ownerOf(typed) || declarations[0]), typed) : null;
  const typedKnown = typed ? known(typed) : null;
  const typedOwner = typed && declarations.length > 1 ? ownerOf(typed) : null;
  const stored = declarations.filter(declaration => Object.keys(readValues(store?.[declaration.id])).length);

  async function save(declaration: TranslatorEnvironmentDeclaration, next: TranslatorEnvironmentValues) {
    setError(null);
    try {
      const values = normalizeValues(next, { declarations: locks(declaration) });
      await onSave(declaration.id, Object.keys(values).length ? values : null);
      return true;
    } catch (failure: any) {
      setError(String(failure?.message || failure));
      return false;
    }
  }
  const own = (declaration: TranslatorEnvironmentDeclaration) => ({ ...ownValues(locks(declaration), store, declaration.id) });
  function commitValue(declaration: TranslatorEnvironmentDeclaration, row: Row, text: string) {
    const next = own(declaration);
    if (row.inheritedValue !== undefined && text === row.inheritedValue) delete next[row.name];
    else next[row.name] = text;
    return save(declaration, next);
  }
  function remove(declaration: TranslatorEnvironmentDeclaration, row: Row) {
    const next = own(declaration);
    if (row.inheritedValue !== undefined) next[row.name] = null;
    else delete next[row.name];
    return save(declaration, next);
  }
  function restore(declaration: TranslatorEnvironmentDeclaration, row: Row) {
    const next = own(declaration);
    delete next[row.name];
    return save(declaration, next);
  }
  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (!typed) { nameInput.current?.focus(); return; }
    const owner = ownerOf(typed);
    if (owner && await save(owner, { ...own(owner), [typed]: value })) {
      setName(""); setValue("");
      nameInput.current?.focus();
    }
  }
  async function reset() {
    setError(null);
    try { for (const declaration of stored) await onSave(declaration.id, null); }
    catch (failure: any) { setError(String(failure?.message || failure)); }
  }
  const resetLabel = scope === "game" ? "Use the values from Runtimes for this game" : "Remove every value set here";
  const clearAdd = (event: React.KeyboardEvent, focus = false) => {
    if (event.key !== "Escape" || !(name || value)) return;
    event.preventDefault(); event.stopPropagation(); setName(""); setValue("");
    if (focus) nameInput.current?.focus();
  };
  const visible = groups.filter(group => group.rows.length);

  return <div className="translatorEnvironmentTable">
    {visible.length ? <div className="translatorEnvironmentRows" role="list" aria-label="Environment variables">
      {visible.map(({ declaration, rows }) => <React.Fragment key={declaration.id}>
        {declarations.length > 1 && <div className="translatorEnvironmentGroup" role="presentation" title={declaration.description || undefined}>{declaration.label}</div>}
        {rows.map(row => {
          const removed = row.state === "removed";
          const info = known(row.name, declaration);
          const locked = lockedRule(locks(declaration), row.name);
          const launcher = !removed && !locked && info?.launcher;
          return <div className={`translatorEnvironmentRow${removed ? " removed" : ""}`} role="listitem" key={`${declaration.id}:${row.name}`}>
            <span className="translatorEnvironmentName mono" title={info?.description || undefined}>{row.name}</span>
            <span className="translatorEnvironmentEquals" aria-hidden="true">=</span>
            {removed
              ? <span className="translatorEnvironmentRemovedValue mono">{row.inheritedValue}</span>
              : <CommitTextInput className="input mono translatorEnvironmentValue" aria-label={`${row.name} value`} spellCheck={false}
                value={row.value ?? ""} disabled={disabled} onCommit={text => commitValue(declaration, row, text)} />}
            <span className="translatorEnvironmentState">
              {row.state === "inherited" && <StatusBadge>{SOURCE_LABELS[row.inheritedSource || ""] || "Inherited"}</StatusBadge>}
              {row.state === "changed" && <StatusBadge>Changed</StatusBadge>}
              {row.state === "added" && scope === "game" && <StatusBadge>This game</StatusBadge>}
              {removed && <StatusBadge>Removed</StatusBadge>}
              {launcher && <StatusBadge tone="warning" title={`${launcher} This value replaces it.`}>Set by MacLauncher</StatusBadge>}
              {locked && !removed && <StatusBadge tone="danger"
                title={`${row.name} is set by MacLauncher, so this value is not used. ${locked.reason}`}>Set by MacLauncher</StatusBadge>}
            </span>
            <span className="translatorEnvironmentActions">
              {(row.state === "changed" || removed)
                ? <button type="button" className="btn small" disabled={disabled} aria-label={`Restore ${row.name}`}
                  title={`Restore the ${row.inheritedSource === "global" ? "value from Runtimes" : "default value"}`}
                  onClick={() => void restore(declaration, row)}>Restore</button>
                : <button type="button" className="btn small iconOnly" disabled={disabled} aria-label={`Remove ${row.name}`}
                  title={row.state === "inherited" ? `Remove ${row.name} for ${scope === "game" ? "this game" : "all games"}` : `Remove ${row.name}`}
                  onClick={() => void remove(declaration, row)}><XIcon /></button>}
            </span>
          </div>;
        })}
      </React.Fragment>)}
    </div> : <div className="dim translatorEnvironmentEmpty">No variables.</div>}
    <form className="translatorEnvironmentAdd" onSubmit={add} aria-label="Add a variable">
      <input ref={nameInput} className="input mono translatorEnvironmentNameInput" aria-label="New variable name"
        placeholder="NAME" list={listId} spellCheck={false} autoCapitalize="off" autoCorrect="off" disabled={disabled}
        aria-invalid={Boolean(typedLocked) || undefined}
        value={name} onChange={event => { setName(event.currentTarget.value); setError(null); }} onKeyDown={event => clearAdd(event)} />
      <span className="translatorEnvironmentEquals" aria-hidden="true">=</span>
      <input className="input mono translatorEnvironmentValue" aria-label="New variable value" placeholder="value"
        spellCheck={false} autoCapitalize="off" autoCorrect="off" disabled={disabled} value={value}
        onChange={event => { setValue(event.currentTarget.value); setError(null); }} onKeyDown={event => clearAdd(event, true)} />
      <button type="submit" className="btn small" disabled={disabled || !typed || Boolean(typedLocked)}>Add</button>
      <datalist id={listId}>{suggestions.map(item => <option key={item.key} value={item.key}>{item.description}</option>)}</datalist>
    </form>
    {typedLocked ? <div className="dim translatorEnvironmentHint">{typed} is set by MacLauncher. {typedLocked.reason}</div>
      : typed ? <div className="dim translatorEnvironmentHint">
        {[typedKnown?.description, typedKnown?.launcher, typedOwner ? `Applies with ${typedOwner.label}.` : null].filter(Boolean).join(" ")}
      </div> : null}
    <div className="translatorEnvironmentFooter">
      <ErrorText error={error} inline />
      <button type="button" className="btn small" disabled={disabled || !stored.length} title={resetLabel} aria-label={resetLabel}
        onClick={() => void reset()}>Reset</button>
    </div>
  </div>;
}

const countValues = (declarations: TranslatorEnvironmentDeclaration[], store?: TranslatorEnvironmentStore) =>
  declarations.reduce((count, declaration) => count + Object.values(readValues(store?.[declaration.id])).filter(value => value !== null).length, 0);

// The Runtimes window's global values for the translators a runtime manager
// provides, collapsed under a summary with the number of values.
export function RuntimeTranslatorEnvironments({ managerId, declarations, store, onSave }: {
  managerId: string; declarations?: TranslatorEnvironmentDeclaration[]; store?: TranslatorEnvironmentStore; onSave: Save;
}) {
  const own = managerDeclarations(declarations, managerId);
  if (!own.length) return null;
  const count = countValues(own, store);
  return <details className="runtimeEnvironment" aria-label="Environment variables">
    <summary>Environment variables{count > 0 && <span className="runtimeEnvironmentCount"> ({count})</span>}</summary>
    <div className="runtimeEnvironmentBody">
      <div className="dim translatorEnvironmentIntro">Passed to every game that uses {own.length === 1 ? own[0].label : "these translators"}. A game's Runtime Settings can change, add or remove them.
        <HelpTip label="About environment variables"><p>Values are passed exactly as written, without shell expansion. Changes apply on the next launch.</p></HelpTip></div>
      <TranslatorEnvironmentTable declarations={own} scope="global" globalStore={store} onSave={onSave} />
    </div>
  </details>;
}

// A game's Runtime Settings section for the translators its settings choose.
// `result` is an already loaded environment action result; `load` requests it
// again whenever `loadKey` changes.
export function GameTranslatorEnvironment({ declarations, globalStore, gameStore, result, load, loadKey, disabled, onSave }: {
  declarations?: TranslatorEnvironmentDeclaration[]; globalStore?: TranslatorEnvironmentStore; gameStore?: TranslatorEnvironmentStore;
  result?: Record<string, any>; load?: () => Promise<unknown>; loadKey: string; disabled?: boolean; onSave: Save;
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
  return <section className="settingsStack translatorEnvironmentSection" aria-label="Environment variables">
    <div className="settingsLabel" role="heading" aria-level={3}>Environment variables
      <HelpTip label="About environment variables"><p>Values here replace the values from Runtimes for this game. Values are passed exactly as written, without shell expansion, and apply on the next launch.</p></HelpTip></div>
    <ErrorText error={error} inline />
    {!source && !error && <div className="dim">Loading translators…</div>}
    {source && !chosen.length && <div className="dim">No translator environment applies with these settings.</div>}
    {chosen.length > 0 && <TranslatorEnvironmentTable declarations={chosen} scope="game" globalStore={globalStore} gameStore={gameStore}
      disabled={disabled} onSave={onSave} />}
  </section>;
}
