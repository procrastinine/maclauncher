import React from "react";
import { TrashIcon } from "../icons";
import {HelpTip} from "./HelpTip";
import {availabilityLabel,formatRuntimeVersionTag,formatUserError} from "../ui-helpers";
import {runtimeOperationDefaults,runtimeRemovalPresentation} from "./runtime-tabs-model";
import {modelPresentation} from "../../../../modules/shared/effects/presentation.mjs";

export function RuntimeModelTable({actions,installed,section,busy,onInstall,onRemove,onDefault}:{
  actions:Record<string,any>[];installed:Record<string,any>[];section:Record<string,any>;busy:boolean;
  onInstall:(id:string)=>void;onRemove:(row:Record<string,any>)=>void;onDefault:(row:Record<string,any>,selectionId:string)=>void;
}) {
  const represented=new Set(actions.map(action=>action.installedVersion).filter(Boolean));
  const all=[...actions.map(action=>({action,model:installed.find(model=>model.version===action.installedVersion)})),
    ...installed.filter(model=>!represented.has(model.version)).map(model=>({action:undefined,model}))];
  // Installed models lead; downloads not yet installed follow behind More
  // while any model is installed.
  const [expanded,setExpanded]=React.useState(false);
  const present=(row:typeof all[number])=>Boolean(row.model)||Boolean(row.action?.installed);
  const ordered=[...all.filter(present),...all.filter(row=>!present(row))];
  const rows=expanded||!all.some(present)?ordered:ordered.filter(present),hidden=ordered.length-rows.length;
  return <div className="filterLibraryScroll" role="region" aria-label="Neural model library" tabIndex={0}>
    <table className="filterLibraryTable runtimeModelTable"><thead><tr><th>Model</th><th>Input → output</th><th>Status</th><th>Default for</th><th>Actions</th></tr></thead>
      <tbody>{rows.map(({action,model})=>{
        const present=Boolean(model)||action?.installed,ready=model?.ready!==false;
        const defaults=runtimeOperationDefaults(model,section.defaultSelections);
        const presentation=modelPresentation(model?.operation||model?.method,model?.intrinsicScale);
        const name=action?.label||formatRuntimeVersionTag(model?.version,section),help=action?.description||model?.purpose||presentation.purpose;
        return <tr key={action?.id||model?.version}>
          {/* A model's purpose is its name's tooltip, as an installed row's details are in Runtimes. */}
          <td><span title={help||undefined}>{name}</span></td>
          <td>{model?.inputOutputLabel||action?.inputOutputLabel||presentation.inputOutputLabel}</td>
          <td>{availabilityLabel(present?(ready?"installed":"unavailable"):"notInstalled")}
            {model?.error&&<HelpTip label={`About ${name} availability`}>{formatUserError(model.error)}</HelpTip>}</td>
          {/* Each operation the model serves reads Default, or offers Make default, as installed rows do. */}
          <td>{defaults.length?defaults.map(scope=><div key={scope.id} className="runtimeModelDefault"><span>{scope.label}</span>
            {scope.isDefault?<span className="badge badgeAccent">Default</span>
              :scope.makeDefault&&<button type="button" className="btn small" disabled={busy} title={`Make ${name} the default for ${scope.label}`}
                aria-label={`Make ${name} the default for ${scope.label}`} onClick={()=>onDefault(model!,scope.id)}>Make default</button>}
          </div>):<span className="dim">—</span>}</td>
          <td><div className="detailActions">{!present&&action&&<button type="button" className="btn small" disabled={busy||action.available===false} onClick={()=>onInstall(action.id)}>Install</button>}
            {model&&model.removable!==false&&<button type="button" className="btn small iconOnly danger" disabled={busy}
              title={runtimeRemovalPresentation(model,section).label} aria-label={runtimeRemovalPresentation(model,section).label} onClick={()=>onRemove(model)}><TrashIcon /></button>}
          </div></td>
        </tr>;
      })}{hidden>0&&<tr><td colSpan={5}><button type="button" className="implementationMore" aria-expanded="false" onClick={()=>setExpanded(true)}>More downloads ({hidden})…</button></td></tr>}
      {!rows.length&&<tr><td colSpan={5} className="dim">No compatible models in this operation.</td></tr>}</tbody>
    </table>
  </div>;
}
