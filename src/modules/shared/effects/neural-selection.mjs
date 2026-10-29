// Copyright (c) MacLauncher contributors. MIT license.
export const compatibleNeuralModel=(model,method)=>(model.operation||model.method||'mlx-dlss')===method||model.compatibleMethods?.includes(method);
export function selectNeuralModel(method,models=[],preferences={}){
  const compatible=models.filter(model=>model.ready!==false&&compatibleNeuralModel(model,method));
  return compatible.find(model=>model.version===preferences.defaultVersions?.[method])||compatible.find(model=>model.version===preferences.defaultVersion)||compatible.find(model=>model.curatedDefault===true)||compatible[0];
}
