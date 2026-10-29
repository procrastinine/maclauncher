import React, {useEffect, useId, useState} from "react";
import {useEffectsEditor, type EffectsEditorProps} from "../useEffectsEditor";
import {useGraphicsCatalog} from "../useGraphicsCatalog";
import {shaderFileDrag} from "../shader-drop";
import type {EffectsChainTemplate, GraphicsNotice} from "../types";
import {HelpTip} from "./HelpTip";
import {MenuButton} from "./Popover";
import {StatusBadge} from "./StatusBadge";
import {ErrorText} from "./ErrorText";
import {EffectsPresetMenuItems, EffectsPresetSaveForm} from "./EffectsPresetPicker";
import {GraphicsRuntimeStatus} from "./GraphicsRuntimeStatus";
import {GraphicsStatusLabel} from "./GraphicsStatusLabel";
import {SimpleEffectsView} from "./SimpleEffectsView";
import {AdvancedEffectsView} from "./AdvancedEffectsView";
import {OutputPolicyControls, SourcePolicyControls} from "./OutputPolicyControls";
import {graphicsSummary} from "./inspector-sections-model";

export type {EffectsDraftEditor} from "../useEffectsEditor";
export {effectChoice, effectChooserRows, effectAvailability} from "../effects-catalog";

type Props = EffectsEditorProps & {children?: React.ReactNode; footer?: React.ReactNode; visible?: boolean;
  /** Launch warnings recorded for the saved plan. */
  warnings?: string[]};

// The Graphics section's open state follows the user across games for the
// window's session, like the chosen Simple or Advanced view.
let graphicsSectionOpen = true;

// Notices are complete sentences. A row notice also marks its row; a dropped
// part has no row, so this list is its only place.
function NoticeList({notices, lead, alert}: {notices: GraphicsNotice[]; lead: string; alert?: boolean}) {
  return <div className="detailMeta graphicsNotices" role={alert ? "alert" : "status"}>
    <StatusBadge tone="warning">Needs attention</StatusBadge> {lead}
    <ul>{notices.map((notice, index) => <li key={index}>{notice.message}</li>)}</ul>
  </div>;
}

/**
 * The graphics editor of a game or a preset draft. State and edit actions live
 * in `useEffectsEditor`; the Simple and Advanced views are two presentations
 * of the same plan. A game's editor is a collapsible inspector section whose
 * header keeps the master switch, status and actions visible while closed.
 */
export function EffectsControls({footer, visible = true, warnings = [], children: _children, ...props}: Props) {
  const [open, setOpenState] = useState(graphicsSectionOpen), [savingPreset, setSavingPreset] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false), [templates, setTemplates] = useState<EffectsChainTemplate[]>();
  // Editor demand: a game's catalog and effects are read only while its
  // section or its menu is open. A preset draft supplies its own catalog.
  const demanded = Boolean(props.editor) || visible && (open || menuOpen);
  const catalog = useGraphicsCatalog(demanded && !props.status), status = props.status ?? catalog;
  const awaitingCatalog = !status && Boolean(typeof window !== "undefined" && window.MacLauncher?.launcher?.requestGraphicsCatalog);
  const editor = useEffectsEditor({...props, status, active: demanded && !awaitingCatalog});
  // Live editing follows the status owner's launch binding once it is bound.
  const {plan, info, graphics, running, game, view, embedded} = editor, live = graphics.status?.live || (info?.live ?? props.live);
  const id = useId();
  // Templates are read when the menu opens.
  useEffect(() => {
    const api = typeof window === "undefined" ? undefined : window.MacLauncher?.launcher;
    if (!menuOpen || embedded || !api?.getGameEffectTemplates) return;
    let current = true;
    api.getGameEffectTemplates(game.gamePath).then(rows => {if (current) setTemplates(rows);}, () => {if (current) setTemplates([]);});
    return () => {current = false;};
  }, [menuOpen, embedded, game.gamePath, game.effects]);
  const setOpen = (next: boolean) => {graphicsSectionOpen = next;setOpenState(next);};
  // The library record carries the saved plan's error and notices and is
  // updated by every save and Clear effects.
  const planError = embedded ? undefined : game.graphicsPlanError;
  const notices = embedded ? [] : (game.effectsNotices || []).filter(notice => notice.message);
  const kept = notices.some(notice => notice.dropped || !notice.rowId || !plan.video.some(row => row.id === notice.rowId));
  const saveNotices = editor.saveNotices.filter(notice => notice.message);
  const drop = {
    onDragOver: (event: React.DragEvent) => {if (shaderFileDrag(event.dataTransfer)) {event.preventDefault();event.dataTransfer.dropEffect = "copy";}},
    onDrop: (event: React.DragEvent) => editor.dropShaders(event)
  };
  const editing = <>
    <div className="graphicsViewSwitcher" role="group" aria-label="Graphics view">
      <button type="button" className="btn small" aria-pressed={view === "simple"} onClick={() => editor.setView("simple")}>Simple</button>
      <button type="button" className="btn small" aria-pressed={view === "advanced"} onClick={() => editor.setView("advanced")}>Advanced</button>
      <HelpTip label="About graphics views">Both views edit the same settings. Simple inserts effects in the default order. Advanced controls each effect and its position. Switching views preserves the chain.</HelpTip>
    </div>
    {running && info?.activeLaunch?.runtimeId && info.activeLaunch.runtimeId !== game.runtimeId &&
      <p className="detailMeta">Running: {info.activeLaunch.runtimeId} · Next launch: {game.runtimeId}</p>}
    {editor.loading && !info && <p className="detailMeta" role="status">Loading available effects…</p>}
    <fieldset className="effectsEditor" aria-busy={editor.pending}>
      <legend className="srOnly">Ordered video effects</legend>
      <SourcePolicyControls editor={editor} />
      {view === "simple" ? <SimpleEffectsView editor={editor} /> : <AdvancedEffectsView editor={editor} />}
    </fieldset>
    <OutputPolicyControls editor={editor} />
    <ErrorText error={editor.error} inline />
  </>;
  if (embedded) return <section className="effectsControls" aria-label="Ordered graphics effects" {...drop}>{editing}{footer}</section>;

  const summary = graphicsSummary(plan, {running, live, warnings: warnings.length + notices.length + saveNotices.length, unreadable: Boolean(planError)});
  const device = info?.graphicsHardware?.state === "ready" ? info.graphicsHardware.device?.name : undefined;
  return <section className={["effectsControls collapsibleSection graphicsSection", open ? "open" : ""].filter(Boolean).join(" ")}
    aria-labelledby={`${id}-title`} {...drop}>
    <div className="collapsibleHeader graphicsHeader">
      <h3 className="detailSectionHeading"><button type="button" id={`${id}-title`} className="collapsibleToggle" aria-expanded={open}
        aria-controls={`${id}-body`} onClick={() => setOpen(!open)}>Graphics</button></h3>
      <span className="graphicsHeaderControls">
        <input type="checkbox" aria-label="Enable graphics chain" checked={!planError && plan.enabled !== false} disabled={Boolean(planError)}
          onChange={event => void editor.setMaster(event.target.checked)} />
        <HelpTip label="About graphics effects">Effects run from top to bottom. Turning Graphics off bypasses the chain and preserves its settings. Drop shader files to add effects, or onto a method to replace it.
          {running && (live ? " Changes update during play when the loaded graphics adapter supports them." : " The current runtime applies graphics changes on its next launch.")}
          {device && ` The launcher's default graphics device is ${device}; a running game may select another.`}
        </HelpTip>
      </span>
      {!open && <span className="collapsibleSummary">{summary}</span>}
      <div className="collapsibleActions">
        {editor.undo && <span className="graphicsState graphicsUndo" role="status">Effects replaced
          <button type="button" className="btn small" onClick={editor.restore}>Undo</button></span>}
        <GraphicsStatusLabel enabled={plan.enabled !== false} saving={editor.pending} status={graphics.status} completed={graphics.completed}
          retainedReason={graphics.retainedReason} running={running} />
        <MenuButton label="⋯" ariaLabel="Graphics actions" popoverClassName="menuPopover menuItems graphicsMenu" onOpenChange={setMenuOpen}>
          {!planError && <EffectsPresetMenuItems templates={templates} disabled={!info} onApply={next => void editor.applyPreset(next)}
            onSave={() => {setOpen(true);setSavingPreset(true);}} />}
          {!planError && <hr className="menuSeparator" />}
          <button type="button" className="btn small" onClick={() => void editor.reset()}>Clear effects</button>
        </MenuButton>
      </div>
    </div>
    <div id={`${id}-body`} className="collapsibleBody" hidden={!open}>
      {savingPreset && <EffectsPresetSaveForm plan={plan} onClose={() => setSavingPreset(false)} />}
      {planError && <div className="error errorInline graphicsPlanError" role="alert"><span className="errorMessage">{planError.message}</span>
        <button type="button" className="btn small" onClick={() => void editor.reset()}>Clear effects</button></div>}
      {saveNotices.length > 0 && <NoticeList notices={saveNotices} lead="Some changes were not saved." alert />}
      {notices.length > 0 && <NoticeList notices={notices} lead={kept ? "Some saved graphics settings were not kept." : "Some saved effects need attention."} />}
      {(status?.notices?.length || 0) > 0 && <NoticeList notices={status!.notices!} lead="Some graphics components could not be read." />}
      {warnings.length > 0 && <div className="detailMeta graphicsLaunchWarnings" role="status">
        <StatusBadge tone="warning">Needs attention</StatusBadge> Some graphics settings could not be applied at launch.
        <ul>{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
      </div>}
      {planError ? <ErrorText error={editor.error} inline /> : editing}
      <GraphicsRuntimeStatus game={{...game, effects: plan}} running={running} visible={visible && open} live={live}
        inspectDetails={view === "simple" ? editor.simpleOptions !== null : plan.video.some(node => editor.expandedSteps[node.id])}
        requestKey={`${graphics.status?.desiredRevision || ""}:${graphics.status?.phase || ""}`}
        onStatus={graphics.observe} />
      {footer}
    </div>
  </section>;
}
