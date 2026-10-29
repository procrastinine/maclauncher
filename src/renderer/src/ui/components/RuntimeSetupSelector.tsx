import React, {useEffect,useState} from "react";
import {HelpTip} from "./HelpTip";
import {ImplementationPicker} from "./ImplementationPicker";
import {withAvailability} from "../ui-helpers";

type Action = {id:string;label?:string;buttonLabel?:string;description?:string;available?:boolean;installed?:boolean;group?:string};
export function RuntimeSetupSelector({id,actions,label,searchLabel,busy,onAction}:{
  id:string;actions:Action[];label:string;searchLabel?:string;busy:boolean;onAction:(actionId:string)=>void;
}) {
  const [selection,setSelection]=useState("");
  const fallback=actions.find(row=>row.available!==false)||actions[0];
  const selected=actions.find(row=>row.id===selection)||fallback;
  useEffect(()=>{setSelection(current=>actions.some(row=>row.id===current)?current:fallback?.id||"");},[actions,fallback?.id]);
  if(!selected)return null;
  return <div className="runtimeSetup runtimeSetupSelector">
    <label htmlFor={id}>{label}{selected.description&&<HelpTip label={`About ${selected.label||label}`}>{selected.description}</HelpTip>}</label>
    <ImplementationPicker id={id} label={label} value={selected.id} searchLabel={searchLabel} emptyLabel="No matching downloads"
      options={actions.map(row=>({value:row.id,label:withAvailability(row.label||row.id,row.installed&&row.id!==selected.id?"installed":null),
        title:row.description,disabled:row.available===false,group:row.group}))}
      onChange={event=>setSelection(event.target.value)}/>
    <button type="button" className="btn" disabled={busy||selected.installed||selected.available===false}
      onClick={()=>onAction(selected.id)}>{selected.installed?"Installed":selected.buttonLabel||"Install"}</button>
  </div>;
}
