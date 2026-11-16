'use strict';
// Context adapter for the one installer; source/version decisions are complete.
function installExactBackend({manager,context,options}){
 if(typeof manager?.installRuntime!=='function'||!options.version||options.exactVersion!==true)throw new Error('An exact existing runtime backend is required.');
 const settings=context.settings?.runtimes?.[manager.id];
 return manager.installRuntime({...options,...(settings!==undefined?{settings}:{}),runtimeSettings:context.settings?.runtimes});
}
module.exports={installExactBackend};
