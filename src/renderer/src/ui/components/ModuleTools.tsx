import React from "react";
import type { ModuleUiAction, ModuleUiGroup, RecentGame } from "../types";
import { getByPath, matchesAnyCondition } from "../ui-helpers";
import { ActionIcon } from "../icons";
import type { LibraryActions } from "./library-actions";
import { HelpTip } from "./HelpTip";
import { presentModuleFields } from "./module-tools-model";

export function ModuleTools({ game, groups, actions, results, busy, onAction }: {
  game: RecentGame; groups: ModuleUiGroup[]; actions: ModuleUiAction[];
  results: Record<string, any>; busy: Record<string, boolean>; onAction: LibraryActions["onModuleAction"];
}) {
  const byId = new Map(actions.map(action => [action.id, action]));
  return <>{groups.map(group => {
    if (matchesAnyCondition(game, group.hiddenWhen)) return null;
    const visibleActions = group.actions.map(id => byId.get(id))
      .filter((action): action is ModuleUiAction => Boolean(action) && !matchesAnyCondition(game, action!.hiddenWhen));
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
    const content = <>
      <div className="detailActions">
        {visibleActions.map(action => {
          const iconOnly = Boolean(action.icon && action.iconOnly);
          return <button key={action.id} className={["btn", "small", action.kind === "primary" ? "primary" : "",
            action.kind === "danger" ? "danger" : "", iconOnly ? "iconOnly" : ""].filter(Boolean).join(" ")}
            disabled={Boolean(busy[action.id]) || matchesAnyCondition(game, action.disabledWhen)}
            title={action.label} aria-label={action.label} onClick={() => onAction(game.gamePath, action.id, action)}>
            {action.icon ? <><ActionIcon icon={action.icon} />{!iconOnly && <span>{action.label}</span>}</> : action.label}
          </button>;
        })}
      </div>
      {(info.length > 0 || resultGroups.length > 0) && <details className="moduleToolResults">
        <summary>Details</summary>
        <dl className="moduleResultFields">
          {info.map(field => <React.Fragment key={`info:${field.key}`}><dt>{field.label}</dt><dd className={field.format === "path" ? "mono" : undefined}>{field.value}</dd></React.Fragment>)}
        </dl>
        {resultGroups.map(({ action, fields }) => <div className="moduleResultGroup" key={action.id}>
          {resultGroups.length > 1 && <div className="moduleResultTitle">{action.label}</div>}
          <dl className="moduleResultFields">{fields.map(field => <React.Fragment key={field.key}><dt>{field.label}</dt><dd className={field.format === "path" ? "mono" : undefined}>{field.value}</dd></React.Fragment>)}</dl>
        </div>)}
      </details>}
    </>;
    return group.collapsed ? <details className="moduleToolGroup" key={group.id}>
      <summary>{label}{help}</summary><div className="moduleToolGroupBody">{content}</div>
    </details> : <div className="detailRow detailToolRow" key={group.id}>
      <div className="detailLabel">{label}{help}</div>{content}
    </div>;
  })}</>;
}
