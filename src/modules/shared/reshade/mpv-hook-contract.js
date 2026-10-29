// Preparation metadata only. The original mpv parser owns executable syntax.
function constantCondition(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const tokens=text.trim().split(/\s+/),stack=[];
  if(tokens.length>32)return null;
  for(const token of tokens){
    if(/^\d+(?:\.\d*)?(?:[eE][+-]?\d+)?$/.test(token))stack.push(Math.fround(Number(token)));
    else if(token==="!"&&stack.length)stack.push(Number(!stack.pop()));
    else if(["+","-","*","/","%",">","<","="].includes(token)&&stack.length>=2){
      const b=stack.pop(),a=stack.pop();let value;
      switch(token){case"+":value=a+b;break;case"-":value=a-b;break;case"*":value=a*b;break;
        case"/":value=a/b;break;case"%":value=a%b;break;case">":value=Number(a>b);break;
        case"<":value=Number(a<b);break;case"=":value=Number(Math.abs(Math.fround(a-b))<=1e-6*Math.max(a,b));break;}
      stack.push(Math.fround(value));
    }else return null;
    if(stack.some(value=>!Number.isFinite(value)))return null;
  }
  return stack.length===1?stack[0]!==0:null;
}
function expressionTextures(text){return [...String(text||"").matchAll(/\b([A-Za-z_]\w*)\.(?:width|height|w|h)\b/g)].map(match=>match[1]);}
// Prove a scale-only condition from the authored RPN. Unknown expressions stay
// unknown; target allocation and shader names do not supply a direction.
function resizeCondition(text,{sizes=new Map(),outputNames=new Set(["OUTPUT"])}={}){
  if(typeof text!=="string"||!text.trim())return null;
  const tokens=text.trim().split(/\s+/),stack=[];if(tokens.length>64)return null;
  const truth=value=>value.truth||(!Object.keys(value.powers).length?[0,1,2].map(()=>value.coefficient?2:0):[1,1,1]);
  const quotient=(a,b,divide)=>{if(a.truth||b.truth||!b.coefficient&&divide)return null;const powers={...a.powers};for(const[k,v]of Object.entries(b.powers))powers[k]=(powers[k]||0)+(divide?-v:v);for(const k of Object.keys(powers))if(!powers[k])delete powers[k];return {coefficient:divide?a.coefficient/b.coefficient:a.coefficient*b.coefficient,powers};};
  for(const token of tokens){
    if(/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(token))stack.push({coefficient:Number(token),powers:{}});
    else if(/^[A-Za-z_]\w*\.(?:w|h|width|height)$/.test(token)){
      const [name,axis]=token.split("."),coefficient=outputNames.has(name)||/^NATIVE(?:_CROPPED)?$/.test(name)?1:sizes.get(name)?.[axis[0]==="w"?"x":"y"];
      if(!(coefficient>0))return null;
      stack.push({coefficient,powers:{[(outputNames.has(name)?"out":"in")+":"+axis[0]]:1}});
    }else if(token==="!"&&stack.length)stack.push({truth:truth(stack.pop()).map(value=>2-value)});
    else if(["*","/","+","<",">"].includes(token)&&stack.length>=2){
      const b=stack.pop(),a=stack.pop();
      if((token==="*"||token==="+")&&(a.truth||b.truth)){const x=truth(a),y=truth(b);stack.push({truth:x.map((value,i)=>token==="*"?Math.min(value,y[i]):Math.max(value,y[i]))});continue;}
      if(token==="*"||token==="/"){const value=quotient(a,b,token==="/");if(!value||!Number.isFinite(value.coefficient))return null;stack.push(value);continue;}
      if(token==="+")return null;
      const ratio=quotient(a,b,true);if(!ratio||!(ratio.coefficient>0))return null;
      const axes=["w","h"].filter(axis=>Math.abs(ratio.powers["out:"+axis])===1&&ratio.powers["out:"+axis]===-ratio.powers["in:"+axis]);
      if(!axes.length||Object.keys(ratio.powers).length!==axes.length*2||axes.some(axis=>ratio.powers["out:"+axis]!==ratio.powers["out:"+axes[0]]))return null;
      const inverse=ratio.powers["out:"+axes[0]]===-1,threshold=inverse?ratio.coefficient:1/ratio.coefficient,operation=inverse?(token==="<"?">":"<"):token;
      stack.push({truth:operation==="<"?[threshold>=1?2:1,1<threshold?2:0,threshold<=1?0:1]:[threshold>=1?0:1,1>threshold?2:0,threshold<=1?2:1]});
    }else return null;
  }
  if(stack.length!==1)return null;const possible=truth(stack[0]);
  return possible[1]===0?["downsample","upscale"].filter((_,i)=>possible[i*2]!==0):null;
}
module.exports={constantCondition,expressionTextures,resizeCondition};
