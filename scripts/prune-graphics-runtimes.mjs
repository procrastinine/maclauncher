import fs from 'node:fs';
import path from 'node:path';
import {liveGenerationPaths,generationProcesses,generationReferenced,processAlive} from './generation-cache.mjs';

// Staged graphics generations are named <version>-<source hash>-<payload hash>.
const GENERATION=/^\d+\.\d+\.\d+-[0-9a-f]{8}-[0-9a-f]{8}$/;

/**
 * Remove staged graphics runtime generations other than the selected one and
 * its predecessor. The predecessor is the previously selected generation when
 * it still exists, otherwise the most recently staged other generation.
 * Incomplete generations, symbolic links and generations held by a lease or a
 * running process are kept. Returns the removed directory names.
 */
export function pruneGraphicsRuntimes(root,{selected,previous,processes=generationProcesses(),alive=processAlive}={}){
 if(!GENERATION.test(selected||''))throw Error('The selected graphics runtime generation is invalid.');
 // Failure to list processes disables pruning; a running game is never guessed to be absent.
 if(processes===null||!fs.existsSync(root))return [];
 const paths=liveGenerationPaths(root,{alive}),generations=[];
 for(const entry of fs.readdirSync(root,{withFileTypes:true})){
  if(!entry.isDirectory()||!GENERATION.test(entry.name))continue;
  const manifest=path.join(root,entry.name,'universal','runtime.json');
  if(fs.existsSync(manifest))generations.push({name:entry.name,at:fs.statSync(manifest).mtimeMs});
 }
 if(!generations.some(row=>row.name===selected))return [];
 const fallback=generations.some(row=>row.name===previous&&previous!==selected)?previous:
  generations.filter(row=>row.name!==selected).sort((a,b)=>b.at-a.at)[0]?.name;
 const removed=[];
 for(const {name}of generations){
  const directory=path.join(root,name);
  if(name===selected||name===fallback||generationReferenced(directory,paths,processes))continue;
  fs.rmSync(directory,{recursive:true,force:true});removed.push(name);
 }
 return removed;
}
