const fs=require('node:fs'),path=require('node:path');
const {member}=require('../../src/modules/android/art/runtime');

// Component proofs consume the original pinned image and their explicit
// adapters, independently of the current application supplier's delivery set.
exports.componentSupplier=function(payload){
 const root=member(payload,'art'),manifest=JSON.parse(fs.readFileSync(path.join(root,'runtime.json')));
 const components=Object.fromEntries(Object.entries(manifest.components).map(([name,file])=>[name,name==='image'&&process.env.ANDROID_ART_IMAGE?fs.realpathSync(process.env.ANDROID_ART_IMAGE):member(root,file)]));
 return {root,manifest,bootClasspath:manifest.bootClasspath,components};
};
