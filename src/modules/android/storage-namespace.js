const path=require('node:path');
const policy=require('./runtime-source').json('native/resources/storage-namespace.json');

function directories({dataRoot,filesRoot=path.join(dataRoot,'files'),cacheRoot=path.join(dataRoot,'cache'),partitionsRoot}){
 const values={data:dataRoot,files:filesRoot,cache:cacheRoot,partitions:partitionsRoot};
 for(const name of ['data','files','cache','partitions'])if(typeof values[name]!=='string'||!path.isAbsolute(values[name])||/[\0\r\n\t]/.test(values[name]))throw Error('Invalid Android namespace directory');
 for(const name of ['files','cache']){const relative=path.relative(dataRoot,values[name]);if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('Android paths must remain in application storage');}
 return values;
}
function expandValue(value,values){return path.normalize(value.replace(/\{(\w+)\}/g,(_,name)=>{if(!(name in values))throw Error('Invalid Android namespace binding');return values[name];}));}
/** The process environment shares the same scoped directories as Android paths. */
function environment(options){
 const values=directories(options),result=Object.fromEntries(Object.entries(policy.environment).map(([name,value])=>[name,expandValue(value,values)]));
 for(const [name,partition]of Object.entries(policy.partitions))result[name]=path.join(values.partitions,partition);
 return result;
}
/** Android aliases name the existing bottle directories in both execution paths. */
function namespace(options){
 const {packageName}=options;
 if(typeof packageName!=='string'||packageName.length>255||!/^\w+(?:\.\w+)*$/.test(packageName)||!packageName.split('.').every(value=>/^[A-Za-z_]/.test(value)))throw Error('Invalid Android package name');
 const values={...directories(options),package:packageName},expand=value=>expandValue(value,values);
 const variables=environment(options);
 const mappings=[];
 for(const partition of Object.values(policy.partitions))mappings.push({android:'/'+partition,target:path.join(values.partitions,partition)});
 for(const [android,target,nativeMount=true]of policy.mappings)mappings.push({android:expand(android),target:expand(target),nativeMount});
 for(const [prefixes,aliases]of [[policy.dataPrefixes,policy.dataAliases],[policy.storagePrefixes,policy.storageAliases]])
  for(const prefix of prefixes)for(const [suffix,target]of aliases)mappings.push({android:path.join(expand(prefix),expand(suffix)),target:expand(target)});
 mappings.sort((a,b)=>b.android.split(path.sep).length-a.android.split(path.sep).length||a.android.localeCompare(b.android));
 return {environment:variables,mappings};
}
module.exports={namespace,environment};
