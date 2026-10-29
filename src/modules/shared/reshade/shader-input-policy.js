const VALUES=Object.freeze(["source","srgb-sdr","linear-source"]);
function declared(text){
  let selected;
  for(const line of text.split(/\r?\n/)){
    if(!/^\s*\/\/!\s*INPUT_POLICY\b/.test(line))continue;
    const value=/^\s*\/\/!\s*INPUT_POLICY\s+(\S+)\s*$/.exec(line)?.[1];
    if(!VALUES.includes(value)||selected&&selected!==value)throw Error("Shader input policy must be source, srgb-sdr or linear-source.");
    selected=value;
  }
  return selected;
}
function availability(policy,{features={}}={}){
  if(policy!==undefined&&!VALUES.includes(policy))return "The shader input color contract is unsupported.";
  return policy==="linear-source"&&features.linearInputPolicyAPI!==1?"Requires updated linear-color shader support.":null;
}
module.exports={declared,availability,VALUES};
