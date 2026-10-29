import React from "react";
import type { ModuleActionError, ModuleUiAction, ModuleUiGroup, RecentGame } from "../types";
import { getByPath, matchesAnyCondition } from "../ui-helpers";
import { ActionIcon } from "../icons";
import type { LibraryActions } from "./library-actions";
import { HelpTip } from "./HelpTip";
import { presentModuleFields } from "./module-tools-model";
import { MenuButton } from "./Popover";
import { ErrorText } from "./ErrorText";

export function ModuleTools({ game, groups, actions, results, busy, cancelling = {}, error = null, onAction, onCancel, onRevealPath }: {
  game: RecentGame; groups: ModuleUiGroup[]; actions: ModuleUiAction[];
  results: Record<string, any>; busy: Record<string, boolean>; onAction: LibraryActions["onModuleAction"];
  /** The last failed action; it is shown in the group that ran it. */
  error?: ModuleActionError | null;
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
    const failure = error && group.actions.includes(error.actionId) ? <ErrorText error={error.message} inline /> : null;
    if (!visibleActions.length && !info.length && !resultGroups.length && !failure) return null;
    const labelOverride = group.labelKey ? getByPath(game, group.labelKey) : null;
    const label = typeof labelOverride === "string" && labelOverride.trim() ? labelOverride.trim() : group.label;
    const help = group.note ? <HelpTip label={`About ${label}`}>{group.note}</HelpTip> : null;
    const running = visibleActions.filter(action => busy[action.id]);
    const primary = visibleActions.find(action => action.kind === "primary") ||
      visibleActions.find(action => !action.autoRun && !action.iconOnly) || visibleActions[0];
    const supporting = visibleActions.filter(action => action !== primary);
    const actionButton = (action: ModuleUiAction, inMenu = false) => {
      const iconOnly = !inMenu && Boolean(action.icon && action.iconOnly);
      // A tool's main action leads its group; the primary button style is kept for Play.
      return <button key={action.id} type="button" className={["btn", "small",
            action.kind === "danger" ? "danger" : "", iconOnly ? "iconOnly" : ""].filter(Boolean).join(" ")}
            disabled={Boolean(busy[action.id]) || matchesAnyCondition(game, action.disabledWhen)}
            aria-busy={Boolean(busy[action.id]) || undefined}
            title={action.label} aria-label={action.label} onClick={() => void onAction(game.gamePath, action.id, action)}>
            {action.icon ? <><ActionIcon icon={action.icon} />{!iconOnly && <span>{action.label}</span>}</> : action.label}
          </button>;
    };
    const controls = <div className="detailActions">
      {group.collapsed ? visibleActions.map(action => actionButton(action, true)) : group.inlineActions ? visibleActions.map(action => actionButton(action)) : <>
        {primary && actionButton(primary)}
        {supporting.length > 0 && <MenuButton label="More…" ariaLabel={`More ${label.toLowerCase()} actions`} placement="side"
          className="moduleToolMenu" popoverClassName="moduleToolMenuItems">
          {supporting.map(action => actionButton(action, true))}
        </MenuButton>}
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
      {fields.map(field => <React.Fragment key={field.key}><dt>{field.label}{field.help && <HelpTip label={`About ${field.label.toLowerCase()}`}>{field.help}</HelpTip>}</dt>
        <dd className={field.format === "path" ? "moduleResultPath" : undefined}>
          {field.format === "path" && typeof field.value === "string" && field.value.startsWith("/") && onRevealPath ?
            <button className="btn small" type="button" title="Reveal in Finder"
              aria-label={`Reveal ${field.label.toLowerCase() || "output"}`}
              onClick={() => void onRevealPath(game.gamePath, field.value)}><ActionIcon icon="folder" />Reveal</button>
            : <span className={field.format === "path" ? "mono" : undefined}>{field.value}</span>}
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
      {activity}{failure}{resultsContent}
    </div> : <div className="detailRow detailToolRow" key={group.id}>
      <div className="detailLabel"><span>{label}</span>{help}</div>{controls}{activity}{failure}{resultsContent}
    </div>;
  })}</>;
}
