const path=require("node:path");
const Cache=require("../prepared-cache");

/** Code leases owned by the same supervisor as authenticated package rows.
 * Canonical replies can reference only generations already admitted through
 * this profile's original preparation/catalog boundary. */
function createPackageSources(userDataDir){
  const roots=new Map();let closed=false;
  function lease(values){
    for(const value of values)value.references++;
    let released;
    return ()=>released??=(async()=>{
      for(const value of values)if(!value.closed&&--value.references===0){
        value.closed=true;roots.delete(value.root);await value.release();
      }
    })();
  }
  return {
    async acquire(packages=[]){
      if(closed)throw Error("Android package source owner is closed.");
      const selected=[];
      try{
        for(const record of packages){
          if(!record.preparedRoot)continue;const root=path.resolve(record.preparedRoot);
          let value=roots.get(root);
          if(value){if(value.packageName!==record.packageName||value.uid!==record.uid)throw Error("Android package source identity changed.");}
          else {value={root,packageName:record.packageName,uid:record.uid,references:0,closed:false,release:await Cache.retainPackageSource(userDataDir,record)};roots.set(root,value);}
          if(selected.includes(value))continue;
          selected.push(value);
        }
        return lease(selected);
      }catch(error){for(const value of selected)if(!value.references&&!value.closed){value.closed=true;roots.delete(value.root);await value.release();}throw error;}
    },
    retainCanonical(values){
      if(closed)throw Error("Android package source owner is closed.");
      const selected=[...new Set(values)].map(root=>{
        const value=roots.get(root);if(!value||value.closed)throw Error("Android package source was not admitted by its supervisor.");return value;
      });
      return lease(selected);
    },
    async close(){
      if(closed)return;closed=true;const values=[...roots.values()];roots.clear();
      await Promise.all(values.map(async value=>{if(!value.closed){value.closed=true;await value.release();}}));
    }
  };
}
module.exports={createPackageSources};
