export type NeuralModelChoice={version:string;method?:string;operation?:string;compatibleMethods?:string[];ready?:boolean;curatedDefault?:boolean};
export function compatibleNeuralModel(model:NeuralModelChoice,method:string):boolean;
export function selectNeuralModel<T extends NeuralModelChoice>(method:string,models?:T[],preferences?:{defaultVersion?:string|null;defaultVersions?:Record<string,string>}):T|undefined;
