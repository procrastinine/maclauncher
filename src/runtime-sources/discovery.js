'use strict';
const Upstream=require('../modules/shared/runtime/upstream');
const {validateSource}=require('./schema');
async function discoverSource(source,{signal,logger,github=Upstream.github,builds,app}={}){
 validateSource(source);const upstream=source.upstream||{};
 const result={sourceId:source.id,source:source.id,kind:source.kind,available:false,candidates:[]};
 if(!upstream.github){const transport=upstream.builds?builds:app;if(typeof transport==='function')return transport(source,{signal,logger});return {...result,reason:'This upstream uses its existing runtime transport.'};}
 const rules=Object.entries(upstream.assets||{}).map(([intendedCPU,pattern])=>({intendedCPU,pattern:new RegExp(pattern,'i')}));
 const publisher=github({repository:upstream.github,allArchitectures:true,prerelease:upstream.prereleases===true,recognize:release=>{
  if(release.prerelease&&!upstream.prereleases)return [];
  const assets=(release.assets||[]).filter(asset=>rules.some(rule=>rule.pattern.test(asset.name||''))||/(?:sha256|checksums|sums)(?:[._-]|$)/i.test(asset.name||''));
  return assets.some(asset=>rules.some(rule=>rule.pattern.test(asset.name||'')))?[{version:release.tag_name,assets}]:[];
 }});
 const rows=await publisher.discover({signal,logger});
 for(const release of rows)for(const file of release.files||[]){const matches=rules.filter(rule=>rule.pattern.test(file.name||''));if(!matches.length)continue;
  const cpus=[...new Set(matches.map(rule=>rule.intendedCPU))];const asset=Upstream.asset(file);
  result.candidates.push({id:source.kind+':'+source.id+':'+release.revision+':'+(file.id||file.name),sourceId:source.id,source:source.id,kind:source.kind,version:release.version,installed:false,measured:false,binaries:[],...(cpus.length===1?{intendedCPU:cpus[0]}:{}),prerelease:release.prerelease===true,asset,verificationFiles:(release.files||[]).filter(candidate=>/(?:sha256|checksums|sums)(?:[._-]|$)/i.test(candidate.name||'')).map(Upstream.asset),provenance:{revision:release.revision,sourceUrl:release.sourceUrl,publishedAt:release.publishedAt}});
 }
 result.available=result.candidates.length>0;return result;
}
module.exports={discoverSource};
