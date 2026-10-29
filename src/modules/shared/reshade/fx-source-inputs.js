// Literal local includes describe source identity; the original preprocessor
// remains authoritative for executable includes, macros and shader semantics.
const fs=require("node:fs"),path=require("node:path");
function dependencies(file,source){
  const rows=[],seen=new Set([file]);let bytes=Buffer.byteLength(source);
  function visit(parent,text){
    for(const match of text.matchAll(/^\s*#\s*include\s*"([^"\r\n]+)"/gm)){
      const candidate=path.resolve(path.dirname(parent),match[1]);let target=candidate,stat;
      try{target=fs.realpathSync(candidate);stat=fs.statSync(target);}catch{if(!seen.has(candidate)){if(rows.length>=128)throw Error("The shader include metadata exceeds its source limit.");seen.add(candidate);rows.push({file:candidate,stamp:null});}continue;}
      if(seen.has(target))continue;seen.add(target);
      if(rows.length>=128||!stat.isFile()||(bytes+=stat.size)>8*1024*1024)throw Error("The shader include metadata exceeds its source limit.");
      rows.push({file:target,stamp:[stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(":")});
      visit(target,fs.readFileSync(target,"utf8"));
    }
  }
  visit(file,source);return rows;
}
module.exports={dependencies};
