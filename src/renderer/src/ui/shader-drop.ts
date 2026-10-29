import type {LauncherApi} from "./types";
import {shaderFormat} from "./shader-format";

export function droppedShaderPaths(data:DataTransfer,api?:Pick<LauncherApi,"getPathForFile">):string[]{
  const paths=new Set<string>();
  const add=(file:File&{path?:string})=>{const value=file.path||api?.getPathForFile(file);if(value&&shaderFormat(value))paths.add(value);};
  for(const file of Array.from(data.files||[]))add(file);
  for(const item of Array.from(data.items||[]))if(item.kind==="file"){const file=item.getAsFile();if(file)add(file);}
  for(const line of (data.getData("text/uri-list")||"").split(/\r?\n/))try{const url=new URL(line);if(url.protocol==="file:"){const value=decodeURIComponent(url.pathname);if(shaderFormat(value))paths.add(value);}}catch{/* Other drag data is handled by the launcher. */}
  return [...paths];
}
export const shaderFileDrag=(data:DataTransfer)=>Array.from(data.types||[]).includes("Files")&&!Array.from(data.types||[]).includes("application/x-maclauncher-effect");
