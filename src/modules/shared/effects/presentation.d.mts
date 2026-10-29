import type {ContractImplementation} from './contracts.mjs';
export const IMPLEMENTATION_GROUPS:readonly string[];
export function implementationGroup(row:{template?:{kind:string;method?:string};kind?:string;method?:string;category?:string;traits?:{neural?:boolean}},type?:string):string;
export function implementationHeading(row:{template?:{kind:string;method?:string};kind?:string;method?:string;category?:string;collection?:string;recommendationRank?:number;inputsAbsent?:boolean;purpose?:string;traits?:{neural?:boolean}},type?:string):string;
export function implementationMore(row:{recommendationRank?:number;inputsAbsent?:boolean}):boolean;
export const SHADER_PURPOSES:readonly string[];
export function implementationName(row:{template?:{kind:string;method?:string};kind?:string;method?:string;category?:string;collection?:string;recommendationRank?:number;inputsAbsent?:boolean;label?:string;family?:string;purpose?:string;traits?:{neural?:boolean}},type?:string):string;
export function orderImplementationGroups<T extends {template?:{kind:string;method?:string};kind?:string;method?:string;category?:string;collection?:string;traits?:{neural?:boolean}}>(rows:readonly T[],type?:string):T[];
export function libplaceboFilterLabel(name:string,label?:string):string;

export function modelPresentation(method?:string,scale?:number):{inputOutputLabel:string;purpose:string};
export function implementationOutputSummary(row:ContractImplementation&{template?:{kind:string};intrinsicScales?:number[];nodeId?:string;traits?:{recommendedPlacement?:string}},type?:string):string;
export function implementationHelp(row:ContractImplementation&{template?:{kind:string};recommendedPlacement?:string;traits?:{recommendedPlacement?:string}}):string;
