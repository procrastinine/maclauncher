import React, {useEffect, useMemo, useRef, useState} from "react";
import {HelpTip} from "./HelpTip";

// A status, such as missing inputs, is a muted note beside the name, never part of it.
export type ImplementationOption = {value: string; label: string; disabled?: boolean; title?: string; keywords?: string; group?: string; action?: boolean;detail?:string;help?:string;more?:boolean;status?:string};
type Props = {id: string; value: string; options: ImplementationOption[]; label: string;
  onChange: (event: {target: {value: string}}) => void; searchable?: boolean; searchLabel?: string; emptyLabel?: string};
const normalized = (value: string) => value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase();
const searchText = new WeakMap<ImplementationOption, {source: string; normalized: string}>();
const isAction = (option: ImplementationOption) => option.action || ["off", "__manage", "__import"].includes(option.value);
export function matchingImplementations(options: ImplementationOption[], query: string) {
  const terms = normalized(query).trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return options;
  return options.filter(option => {
    const source = `${option.label} ${option.status || ""} ${option.detail || ""} ${option.group || ""} ${option.keywords || ""}`;
    let cached = searchText.get(option);
    if (cached?.source !== source) {cached = {source, normalized: normalized(source)};searchText.set(option, cached);}
    return terms.every(term => cached.normalized.includes(term));
  });
}

// Small method sets retain the native macOS select. Large libraries use the
// same options and callbacks in a searchable, keyboard-operated top-layer menu
// whose closed trigger shows only the selected label. Options marked more stay
// behind a More control until it is chosen or a search is entered; the
// selected option is always listed.
export function ImplementationPicker({id, value, options, label, onChange, searchable = options.length > 16, searchLabel = "Search filters", emptyLabel = "No matching filters"}: Props) {
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null);
  const pointerWasOpen = useRef(false);
  const [open, setOpen] = useState(false), [query, setQuery] = useState(""), [active, setActive] = useState(value), [expanded, setExpanded] = useState(false);
  const selected = options.find(option => option.value === value), actions = options.filter(isAction);
  // As in the native select, each group is listed once, at its first position.
  const grouped = useMemo(() => Array.from(new Set(options.map(option => option.group || ""))).flatMap(group => options.filter(option => (option.group || "") === group)), [options]);
  const matches = useMemo(() => open ? matchingImplementations(grouped.filter(option => !isAction(option)), query) : [], [open, grouped, query]);
  const choices = useMemo(() => expanded || query.trim() ? matches : matches.filter(option => !option.more || option.value === value), [expanded, matches, query, value]);
  const hidden = matches.length - choices.length;
  const listId = `${id}-list`, panelId = `${id}-menu`;
  function position() {
    if (!panel.current?.matches(":popover-open") || !trigger.current) return;
    const anchor = trigger.current.getBoundingClientRect(), popup = panel.current;
    if (anchor.bottom < 0 || anchor.top > innerHeight) {popup.hidePopover();return;}
    popup.style.width = `${Math.min(Math.max(anchor.width, 320), innerWidth - 16)}px`;
    const below = innerHeight - anchor.bottom - 12, above = anchor.top - 12, down = below >= Math.min(300, above);
    popup.style.maxHeight = `${Math.min(430, Math.max(140, down ? below : above))}px`;
    const bounds = popup.getBoundingClientRect();
    popup.style.left = `${Math.max(8, Math.min(anchor.left, innerWidth - bounds.width - 8))}px`;
    popup.style.top = `${down ? anchor.bottom + 4 : Math.max(8, anchor.top - bounds.height - 4)}px`;
  }
  function close(restoreFocus = false) {setOpen(false);panel.current?.hidePopover();if (restoreFocus) trigger.current?.focus();}
  function show(initial = "") {
    const popup = panel.current;if (!popup) return;
    setOpen(true);setExpanded(false);setQuery(initial);setActive(initial ? matchingImplementations(grouped.filter(option => !isAction(option)), initial).find(option => !option.disabled)?.value || "" : value);
    popup.style.visibility = "hidden";popup.showPopover();position();popup.style.visibility = "";
    search.current?.focus();
  }
  function choose(option: ImplementationOption) {if (!option.disabled) {close(true);if (option.value !== value) onChange({target: {value: option.value}});}}
  function move(direction: number, edge?: "first" | "last") {
    const enabled = choices.filter(option => !option.disabled);if (!enabled.length) return;
    setActive(current => {
      const index = enabled.findIndex(option => option.value === current);
      return enabled[edge === "first" ? 0 : edge === "last" ? enabled.length - 1 : index < 0 ? direction > 0 ? 0 : enabled.length - 1 : (index + direction + enabled.length) % enabled.length].value;
    });
  }
  useEffect(() => {
    if (!open) return;
    position();
    window.addEventListener("resize", position);document.addEventListener("scroll", position, true);
    return () => {window.removeEventListener("resize", position);document.removeEventListener("scroll", position, true);};
  }, [open, choices.length]);
  useEffect(() => {
    if (open) panel.current?.querySelector<HTMLElement>(`[data-picker-value="${CSS.escape(active)}"]`)?.scrollIntoView({block: "nearest"});
  }, [active, open]);
  const optionElement = (option: ImplementationOption) => <option key={option.value} value={option.value} disabled={option.disabled} title={option.title}>{option.label}{option.status?` · ${option.status}`:''}{option.detail?` · ${option.detail}`:''}</option>;
  if (!searchable) return <select id={id} className="input" value={value} onChange={onChange} aria-label={label} title={selected?.title}>
    {actions.filter(option => option.value === "off").map(optionElement)}
    {Array.from(new Set(options.filter(option => !isAction(option)).map(option => option.group || ""))).map(group => group
      ? <optgroup key={group} label={group}>{options.filter(option => !isAction(option) && option.group === group).map(optionElement)}</optgroup>
      : options.filter(option => !isAction(option) && !option.group).map(optionElement))}
    {actions.filter(option => option.value !== "off").map(optionElement)}
  </select>;
  return <>
    <button ref={trigger} id={id} type="button" className="input implementationTrigger" role="combobox" aria-haspopup="dialog"
      aria-label={label} aria-controls={panelId} aria-expanded={open} title={selected?.title}
      popoverTarget={panelId}
      onPointerDown={() => {pointerWasOpen.current = Boolean(panel.current?.matches(":popover-open"));}}
      onPointerCancel={() => {pointerWasOpen.current = false;}}
      onMouseDown={event => {if (open) event.preventDefault();}}
      onClick={event => {event.preventDefault();const wasOpen = pointerWasOpen.current;pointerWasOpen.current = false;
        if (wasOpen || panel.current?.matches(":popover-open")) close();else show();}} onKeyDown={event => {
        if (["ArrowDown", "ArrowUp"].includes(event.key)) {event.preventDefault();show();}
        else if (event.key.length === 1 && event.key !== " " && !event.metaKey && !event.ctrlKey && !event.altKey) {event.preventDefault();show(event.key);}
      }}><span>{selected?.label || value || "Choose…"}</span>{selected?.status && <small className="implementationTriggerStatus">{selected.status}</small>}</button>
    <div ref={panel} id={panelId} popover="auto" role="dialog" aria-label={`Choose ${label.toLocaleLowerCase()}`} className="implementationMenu"
      onToggle={event => setOpen(event.newState === "open")}
      onBlur={event => {if (event.relatedTarget !== trigger.current && !event.currentTarget.contains(event.relatedTarget)) close();}}
      onKeyDown={event => {
        if (event.key === "Escape") {event.preventDefault();event.stopPropagation();close(true);}
      }}>
      <div className="implementationSearch"><input ref={search} className="input" type="search" placeholder={searchLabel} aria-label={searchLabel}
        value={query} role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls={listId}
        aria-activedescendant={choices.some(option => option.value === active) ? `${listId}-${encodeURIComponent(active)}` : undefined}
        onChange={event => {const next = event.target.value;setQuery(next);setActive(matchingImplementations(grouped.filter(option => !isAction(option)), next).find(option => !option.disabled)?.value || "");}}
        onKeyDown={event => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {event.preventDefault();move(event.key === "ArrowDown" ? 1 : -1);}
          else if ((event.key === "Home" || event.key === "End") && event.altKey) {event.preventDefault();move(0, event.key === "Home" ? "first" : "last");}
          else if (event.key === "Enter") {event.preventDefault();const option = choices.find(option => option.value === active && !option.disabled);if (option) choose(option);}
        }} />
        {selected && selected.value !== "off" && <span className="implementationCurrent" title={selected.label}>{selected.label}</span>}
      </div>
      <div id={listId} role="listbox" aria-label={label} className="implementationChoices">
        {choices.map((option,index) => <React.Fragment key={option.value}>
          {option.group && option.group !== choices[index - 1]?.group && <div className="implementationGroup" role="presentation">{option.group}</div>}
          <div className="implementationChoiceRow"><button type="button" id={`${listId}-${encodeURIComponent(option.value)}`} role="option"
          data-picker-value={option.value} aria-selected={option.value === value} aria-disabled={option.disabled || undefined}
          className={`implementationChoice${option.value === active ? " active" : ""}`} title={option.title} tabIndex={-1} disabled={option.disabled}
          onPointerMove={() => !option.disabled && setActive(option.value)} onMouseDown={event => event.preventDefault()} onClick={() => choose(option)}>
          <span className="implementationOptionText"><span>{option.label}</span>{option.status&&<small>{option.status}</small>}{option.detail&&<small>{option.detail}</small>}</span><span aria-hidden="true">{option.value === value ? "✓" : ""}</span></button>
          {option.help&&<HelpTip label={`About ${option.label}`}>{option.help}</HelpTip>}</div></React.Fragment>)}
        {!choices.length && !hidden && <div className="implementationEmpty" role="status">{emptyLabel}</div>}
      </div>
      {hidden > 0 && <button type="button" className="implementationMore" aria-expanded="false" aria-controls={listId} onMouseDown={event => event.preventDefault()}
        onClick={() => {setExpanded(true);search.current?.focus();}}>More ({hidden})…</button>}
      {actions.length > 0 && <div className="implementationActions">{actions.map(option => <button type="button" key={option.value} className="btn small"
        disabled={option.disabled} onClick={() => choose(option)}>{option.label}</button>)}</div>}
    </div>
  </>;
}
