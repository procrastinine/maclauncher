const fs=require("node:fs"),path=require("node:path");
// The same relative include/collection roots as preparation, with a bounded
// expanded source. This only reads source during an explicit metadata action.
function read(file,{resourceRoots=[]}={}){
  file=fs.realpathSync(file);const roots=[path.dirname(file),...resourceRoots.flatMap(root=>{try{return [fs.realpathSync(root)];}catch{return [];}})],dependencies=[];
  let bytes=0;
  function expand(source,stack=[]){
    if(stack.length>32||dependencies.length>=256)throw Error("The Magpie include nesting exceeds its limit.");
    let canonical,stat;try{canonical=fs.realpathSync(source);stat=fs.statSync(canonical);}catch(error){dependencies.push({file:source,stamp:null});throw error;}
    if(!roots.some(root=>canonical.startsWith(root+path.sep))||stack.includes(canonical))throw Error("Magpie includes must remain inside the shader folder or its declared collection roots without recursion.");
    if(!stat.isFile()||(bytes+=stat.size)>8*1024*1024)throw Error("The expanded Magpie source exceeds 8 MiB.");
    dependencies.push({file:canonical,stamp:[stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(":")});
    const text=fs.readFileSync(canonical,"utf8");
    return text.replace(/^\s*#\s*include\s*["<]([^">]+)[">][^\n]*$/gm,(_line,name)=>{
      const relative=name.replace(/\\/g,"/");if(/^stubdefs\.hlsli?$/i.test(path.basename(relative)))return "";
      if(path.isAbsolute(relative)||path.win32.isAbsolute(relative)||/[\x00-\x1f]/.test(relative))throw Error("Magpie includes require relative paths.");
      return expand(path.resolve(path.dirname(canonical),relative),[...stack,canonical]);
    });
  }
  try{return {text:expand(file),dependencies};}catch(error){error.dependencies=dependencies;throw error;}
}
module.exports={read};
