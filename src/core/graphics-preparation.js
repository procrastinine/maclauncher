// Copyright (c) MacLauncher contributors. MIT license.
function selection(entry,settings){return JSON.stringify([entry?.effects??null,settings?.runtimes||{}]);}
function createGraphicsPreparation(){
  let revision=0,controller=new AbortController();
  return {snapshot:()=>({revision,signal:controller.signal}),isCurrent:request=>request.revision===revision,
    invalidate(){const previous=controller;controller=new AbortController();revision++;previous.abort(Object.assign(new Error('Graphics preparation was replaced by newer settings.'),{name:'AbortError',code:'GRAPHICS_PREPARATION_SUPERSEDED'}));return true;}};
}
module.exports={selection,createGraphicsPreparation};
