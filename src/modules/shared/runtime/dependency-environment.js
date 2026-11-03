const path=require('node:path');
const {resolveInstalledEnvironment}=require('./bundled-native');
function environment(install,base=process.env){
 const supplied=resolveInstalledEnvironment(install),result={...base,...supplied};
 if(supplied.DYLD_FALLBACK_LIBRARY_PATH)result.DYLD_FALLBACK_LIBRARY_PATH=[...new Set([
  ...supplied.DYLD_FALLBACK_LIBRARY_PATH.split(path.delimiter),...(base.DYLD_FALLBACK_LIBRARY_PATH||'').split(path.delimiter).filter(Boolean)
 ])].join(path.delimiter);
 return result;
}
module.exports={environment};
