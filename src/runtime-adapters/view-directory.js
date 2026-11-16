'use strict';
const fs=require('node:fs'),path=require('node:path');
const Writable=require('../modules/shared/writable-input');
function canonical(file) {
 const tail=[];let current=path.resolve(file);
 while(!fs.lstatSync(current,{throwIfNoEntry:false})) {tail.unshift(path.basename(current));current=path.dirname(current);}
 return path.join(fs.realpathSync(current),...tail);
}
function directoryFor(build,directory) {
 if(!path.isAbsolute(directory||''))throw new Error('A per-launch component view is required.');
 if(build?.root) {
  const installed=fs.realpathSync(build.root),view=canonical(directory);
  if(view===installed||view.startsWith(installed+path.sep))throw new Error('A component view cannot modify an installed publisher build.');
 }
 Writable.assertOwnDirectory(directory,directory);
 return directory;
}
module.exports={directoryFor};
