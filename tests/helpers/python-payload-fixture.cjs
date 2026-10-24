const fs=require('node:fs'),path=require('node:path');
const Python=require('../../scripts/python-resources.cjs'),profile=require('../../src/modules/shared/runtime/embedded-python.json');
module.exports=function pythonPayloadFixture(root,{source=false}={}){
 const put=(file,body,mode=0o644)=>{const target=path.join(root,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,body,{mode});};
 put(Python.configuration().interpreter,'Synthetic Python interpreter\n',0o755);
 put('runtime.json',JSON.stringify(profile));
 for(const file of Python.requiredFiles)put(file,'Synthetic standard library or pinned module\n');
 for(const[alias,target]of Object.entries(Python.configuration().aliases)){
  if(source)put(alias,'Synthetic Python interpreter\n',0o755);
  else fs.symlinkSync(target,path.join(root,alias));
 }
 return root;
};
