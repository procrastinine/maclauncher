const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const previous=require("../v1/collection-overlay");
const hash=file=>crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function apply(directory,identity){
  const result=previous.apply(directory,identity);
  for(const name of ["SSRT3_Lighting.fx","SSRT3_Diffuse.fx"]){
    const file=path.join(directory,"Shaders",name),source=fs.readFileSync(file,"utf8"),marker="//! INPUT_POLICY source\n";
    if(source.split(marker).length!==2)throw Error("The shader collection color boundary changed.");
    fs.writeFileSync(file,source.replace(marker,"//! INPUT_POLICY linear-source\n"));
  }
  return {...result,version:2,files:{...Object.fromEntries(Object.entries(result.files).map(([name,value])=>["v1/"+name,value])),
    "collection-overlay.js":hash(__filename)}};
}
module.exports={apply,ownedFiles:["collection-overlay.js"],sourceFiles:previous.sourceFiles};
