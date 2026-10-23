import React, { useEffect, useId, useRef, useState } from "react";
import type { ModuleUiAction, ModuleUiGroup, RecentGame } from "../types";
import { getByPath, matchesAnyCondition } from "../ui-helpers";
import { ActionIcon } from "../icons";
import type { LibraryActions } from "./library-actions";
import { HelpTip } from "./HelpTip";
import { presentModuleFields } from "./module-tools-model";
import { positionHelpTip } from "./help-tip-model";

function ModuleActionMenu({ label, children }: { label: string; children: React.ReactNode }) {
  const id = useId(), button = useRef<HTMLButtonElement>(null), popover = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  function position() {
    if (!button.current || !popover.current?.matches(":popover-open")) return;
    const anchor = button.current.getBoundingClientRect(), size = popover.current.getBoundingClientRect();
    if (anchor.bottom < 0 || anchor.top > innerHeight || anchor.right < 0 || anchor.left > innerWidth) {
      popover.current.hidePopover(); return;
    }
    const next = positionHelpTip(anchor, size.width, size.height, innerWidth, innerHeight);
    popover.current.style.left = `${next.left}px`; popover.current.style.top = `${next.top}px`;
  }
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !popover.current?.matches(":popover-open")) return;
      event.preventDefault(); event.stopPropagation(); popover.current.hidePopover(); button.current?.focus();
    };
    document.addEventListener("keydown", escape, true);
    window.addEventListener("resize", position); document.addEventListener("scroll", position, true);
    return () => {
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", position); document.removeEventListener("scroll", position, true);
    };
  }, [open]);
  return <div className="moduleToolMenu">
    <button ref={button} type="button" className="btn small" popoverTarget={id} aria-controls={id}
      aria-label={`More ${label.toLowerCase()} actions`} aria-expanded={open} onClick={event => {
        event.preventDefault();
        const menu = popover.current;
        if (!menu) return;
        if (menu.matches(":popover-open")) { menu.hidePopover(); return; }
        menu.style.visibility = "hidden"; menu.showPopover(); position(); menu.style.visibility = "";
      }}>More…</button>
    <div ref={popover} id={id} popover="auto" className="moduleToolMenuItems"
      onToggle={event => setOpen(event.newState === "open")}>{children}</div>
  </div>;
}

export function ModuleTools({ game, groups, actions, results, busy, cancelling = {}, onAction, onCancel, onRevealPath }: {
  game: RecentGame; groups: ModuleUiGroup[]; actions: ModuleUiAction[];
  results: Record<string, any>; busy: Record<string, boolean>; onAction: LibraryActions["onModuleAction"];
  cancelling?: Record<string, boolean>; onCancel?: LibraryActions["onCancelModuleAction"];
  onRevealPath?: LibraryActions["onRevealToolPath"];
}) {
  const byId = new Map(actions.map(action => [action.id, action]));
  return <>{groups.map(group => {
    if (matchesAnyCondition(game, group.hiddenWhen)) return null;
    const visibleActions = group.actions.map(id => byId.get(id))
      .filter((action): action is ModuleUiAction => Boolean(action) && action!.inspector !== false && !matchesAnyCondition(game, action!.hiddenWhen));
    const info = presentModuleFields(game, (group.infoFields || []).filter(field => !matchesAnyCondition(game, field.hiddenWhen)));
    const resultGroups = visibleActions.flatMap(action => {
      if (busy[action.id] || !results[action.id]) return [];
      const fields = presentModuleFields(results[action.id], (action.resultFields || [])
        .filter(field => !matchesAnyCondition(game, field.hiddenWhen)));
      return fields.length ? [{ action, fields }] : [];
    });
    if (!visibleActions.length && !info.length && !resultGroups.length) return null;
    const labelOverride = group.labelKey ? getByPath(game, group.labelKey) : null;
    const label = typeof labelOverride === "string" && labelOverride.trim() ? labelOverride.trim() : group.label;
    const help = group.note ? <HelpTip label={`About ${label}`}>{group.note}</HelpTip> : null;
    const running = visibleActions.filter(action => busy[action.id]);
    const primary = visibleActions.find(action => action.kind === "primary") ||
      visibleActions.find(action => !action.autoRun && !action.iconOnly) || visibleActions[0];
    const supporting = visibleActions.filter(action => action !== primary);
    const actionButton = (action: ModuleUiAction, inMenu = false) => {
      const iconOnly = !inMenu && Boolean(action.icon && action.iconOnly);
      return <button key={action.id} type="button" className={["btn", "small", action.kind === "primary" && !inMenu ? "primary" : "",
            action.kind === "danger" ? "danger" : "", iconOnly ? "iconOnly" : ""].filter(Boolean).join(" ")}
            disabled={Boolean(busy[action.id]) || matchesAnyCondition(game, action.disabledWhen)}
            aria-busy={Boolean(busy[action.id]) || undefined}
            title={action.label} aria-label={action.label} onClick={event => {
              const menu = event.currentTarget.closest(".moduleToolMenu");
              const popover = menu?.querySelector<HTMLElement>("[popover]");
              if (popover?.matches(":popover-open")) popover.hidePopover();
              menu?.querySelector<HTMLElement>("button[popovertarget]")?.focus();
              void onAction(game.gamePath, action.id, action);
            }}>
            {action.icon ? <><ActionIcon icon={action.icon} />{!iconOnly && <span>{action.label}</span>}</> : action.label}
          </button>;
    };
    const controls = <div className="detailActions">
      {group.collapsed ? visibleActions.map(action => actionButton(action, true)) : group.inlineActions ? visibleActions.map(action => actionButton(action)) : <>
        {primary && actionButton(primary)}
        {supporting.length > 0 && <ModuleActionMenu label={label}>
          {supporting.map(action => actionButton(action, true))}
        </ModuleActionMenu>}
      </>}
    </div>;
    const activity = running.length > 0 && <div className="moduleToolActivity" role="status">
      {running.map(action => <div className="detailActions" key={action.id}>
        <span>{action.label.replace(/…$/, "")}…</span>
        {action.cancellable && onCancel && <button className="btn small" type="button"
              disabled={Boolean(cancelling[action.id])} aria-label={`Cancel ${action.label.replace(/…$/, "")}`}
              onClick={() => onCancel(game.gamePath, action.id)}>
              {cancelling[action.id] ? "Canceling…" : "Cancel"}
        </button>}
      </div>)}
    </div>;
    const fieldsList = (fields: ReturnType<typeof presentModuleFields>) => <dl className="moduleResultFields">
      {fields.map(field => <React.Fragment key={field.key}><dt>{field.label}</dt>
        <dd className={field.format === "path" ? "mono moduleResultPath" : undefined}>
          <span>{field.value}</span>
          {field.format === "path" && typeof field.value === "string" && field.value.startsWith("/") && onRevealPath &&
            <button className="btn small iconOnly" type="button" title="Reveal in Finder"
              aria-label={`Reveal ${field.label.toLowerCase() || "output"}`}
              onClick={() => void onRevealPath(game.gamePath, field.value)}><ActionIcon icon="folder" /></button>}
        </dd></React.Fragment>)}
    </dl>;
    const resultsContent = <>
      {info.length > 0 && <details className="moduleToolResults">
        <summary>Details</summary>
        {fieldsList(info)}
      </details>}
        {resultGroups.map(({ action, fields }) => <div className="moduleResultGroup" role="status" key={action.id}>
          {resultGroups.length > 1 && <div className="moduleResultTitle">{action.label}</div>}
          {fieldsList(fields)}
        </div>)}
    </>;
    return group.collapsed ? <div className="moduleToolSection" key={group.id}>
      <details className="moduleToolGroup"><summary>{label}{help}</summary>
        <div className="moduleToolGroupBody">{controls}</div>
      </details>
      {activity}{resultsContent}
    </div> : <div className="detailRow detailToolRow" key={group.id}>
      <div className="detailLabel"><span>{label}</span>{help}</div>{controls}{activity}{resultsContent}
    </div>;
  })}</>;
}
