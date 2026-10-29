const {resolve}=require("./descriptor");
// Launch verification checks this directory; the provider reuses that result.
function prepare(root,options){const installed=resolve(root,options);if(!installed)return {};for(const row of installed.descriptor.files)require("../../payload-verification").verifyFile(installed.directory,row,{reuse:true});return {RESHADE_ASR_LIBRARY:installed.library,RESHADE_ASR_SHADER_DIRECTORY:installed.directory};}
module.exports={resolve,prepare};
