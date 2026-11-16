'use strict';
const fs=require('node:fs'),path=require('node:path');
const Writable=require('../modules/shared/writable-input');

// Parts have already been admitted for the consumer by the launch plan.
// Only the per-launch view is writable; publisher files remain unchanged.
function apply({build={},parts={},environment={},parameters={}}={}) {
 const driver=parts.driver,library=parts.library||driver;
 for(const file of [driver,library,parts.icd].filter(Boolean))
  if(!path.isAbsolute(file)||!fs.statSync(file).isFile())throw new Error('The selected Vulkan part is missing.');
 if(!driver)throw new Error('The selected Vulkan driver is missing.');
 const env={...environment};let icd;
 if(parameters.driverEnvironment!==false) {
  const directory=require('./view-directory').directoryFor(build,parameters.directory||parameters.viewRoot);
  const descriptor=parts.icd?JSON.parse(fs.readFileSync(parts.icd,'utf8')):{file_format_version:'1.0.0',ICD:{api_version:parameters.apiVersion}};
  if(!descriptor.ICD||typeof descriptor.ICD!=='object')throw new Error('The selected Vulkan ICD has no driver declaration.');
  if(!parts.icd&&!/^\d+\.\d+\.\d+$/.test(parameters.apiVersion||''))throw new Error('A Vulkan build without an ICD must declare its API version.');
  descriptor.ICD={...descriptor.ICD,library_path:driver,is_portability_driver:false};
  icd=path.join(directory,'vulkan-icd.json');
  if([driver,library,parts.icd].includes(icd))throw new Error('The Vulkan view overlaps an installed part.');
  const text=JSON.stringify(descriptor)+'\n';
  if(!fs.existsSync(icd)||fs.lstatSync(icd).isSymbolicLink()||fs.readFileSync(icd,'utf8')!==text)Writable.atomicWrite(icd,text,{root:directory});
  env.VK_DRIVER_FILES=icd;env.VK_ICD_FILENAMES=icd;
 }
 const values={driver,library,icd};
 for(const [key,part]of Object.entries(parameters.environmentBindings||{})) {
  if(!/^[A-Za-z_][A-Za-z_0-9]*$/.test(key)||!Object.hasOwn(values,part)||!values[part])throw new Error('Invalid Vulkan environment binding.');
  env[key]=values[part];
 }
 return {environment:env,library,driver,icd};
}
module.exports={apply};
