const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {binaryXml}=require('./android-packages');
const source=path.resolve(__dirname,'../fixtures'),directories=new WeakMap();
function prepare(output){
 if(!path.isAbsolute(output||''))throw new Error('A temporary fixture directory is required.');
 function visit(directory){
  for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
   const file=path.join(directory,entry.name);
   if(entry.isDirectory())visit(file);
   else if(entry.isFile()&&entry.name.endsWith('.xml.tree.json')){
    const {tree,resourceIds}=JSON.parse(fs.readFileSync(file));
    const destination=path.join(output,path.relative(source,file).replace(/\.tree\.json$/,'.bin'));
    fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,binaryXml(tree,true,resourceIds));
   }
  }
 }
 visit(source);return output;
}
function file(t,name){
 if(!t||typeof t.after!=='function')throw new Error('A test context is required for generated manifests.');
 let directory=directories.get(t);
 if(!directory){directory=prepare(fs.mkdtempSync(path.join(os.tmpdir(),'android-manifest-fixture-')));directories.set(t,directory);t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));}
 if(!/^[A-Za-z0-9/-]+$/.test(name)||name.split('/').includes('..'))throw new Error('Invalid manifest fixture name.');
 return path.join(directory,name+'.xml.bin');
}
module.exports={prepare,file};
