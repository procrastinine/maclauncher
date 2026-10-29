import {MAX_NODES,RENDER_DIVISORS,DEFAULT_PROCESSING_HEIGHT,DEPTH_INPUT_DEFAULTS,HELPER_ROLES,isResize,ownsHelpers,validate} from "./plan.mjs";
import {GRAPHICS_TYPES,graphicsType,shaderGeometry,implementationsFor,sameImplementation,bidirectionalFitImplementation,
  orderImplementations,extentEditable,slotExtent,isPresentationFit} from "./contracts.mjs";
import {effectSelectionKey} from "./selection-key.mjs";
import {NEURAL} from "./operation-contracts.mjs";

// Every graph edit is a pure function of a schema-2 plan. Helper rows carry
// explicit ownership; ids never imply it. Unchanged rows and plans keep their
// object identity, so callers can memoize by reference.
export const SIMPLE_ORDER = Object.freeze(["temporal","downsample","image","upscale","generation"]);
const RANK = new Map(SIMPLE_ORDER.map((type,index)=>[type,index]));
const ROLES = HELPER_ROLES;
const SIZES = Object.freeze(["extent","outputSize","presentationScale"]);
const PREFIXED = /^auto-(scale|nr)-(input|fit)-(.+)$/;
const conventional = id => PREFIXED.test(id);
const object = value => value!==null&&typeof value==="object"&&!Array.isArray(value);
const present = value => Object.keys(value).filter(key=>value[key]!==undefined);
const safe = key => !["__proto__","constructor","prototype"].includes(key);
const claim = value => object(value)&&typeof value.id==="string"&&ROLES.includes(value.role)&&Object.keys(value).length===2;
// Structural equality with an identity fast path; absent and undefined fields match.
function equal(a,b) {
  if(a===b)return true;
  if(typeof a!=="object"||typeof b!=="object"||!a||!b||Array.isArray(a)!==Array.isArray(b))return false;
  if(Array.isArray(a))return a.length===b.length&&a.every((value,index)=>equal(value,b[index]));
  const keys=present(a);return keys.length===present(b).length&&keys.every(key=>equal(a[key],b[key]));
}

const indexes = new WeakMap();
function rowsIndex(video) {
  let value=indexes.get(video);if(value)return value;
  const byId=new Map(),helpers=new Map();
  for(const row of video)byId.set(row.id,row);
  for(const row of video)if(claim(row.ownedBy)){const owned=helpers.get(row.ownedBy.id)||{};owned[row.ownedBy.role]??=row;helpers.set(row.ownedBy.id,owned);}
  value={byId,helpers};indexes.set(video,value);return value;
}
function mapRows(video,update) {
  let next;
  for(let index=0;index<video.length;index++){const row=update(video[index]);if(row!==video[index]){next??=video.slice();next[index]=row;}}
  return next||video;
}
const filterRows = (video,keep) => {const next=video.filter(keep);return next.length===video.length?video:next;};
const withVideo = (plan,video) => video===plan.video?plan:{...plan,video};
const replaceRow = (plan,row,next) => row===next?plan:withVideo(plan,mapRows(plan.video,value=>value===row?next:value));
const dropRow = (plan,row) => row?withVideo(plan,filterRows(plan.video,value=>value!==row)):plan;
function insertRow(plan,at,row) {const video=plan.video.slice();video.splice(at,0,row);return {...plan,video};}
function withSource(plan,source) {
  if(source==null?plan.renderResolution==null:equal(source,plan.renderResolution))return plan;
  const {renderResolution:_source,...rest}=plan;return source==null?rest:{...rest,renderResolution:source};
}
const dropManaged = (plan,id) => plan.renderResolution?.managedBy===id?withSource(plan,undefined):plan;
function stripManaged(plan,id) {
  if(plan.renderResolution?.managedBy!==id)return plan;
  const {managedBy:_owner,...source}=plan.renderResolution;return {...plan,renderResolution:source};
}
const enable = row => row.enabled?row:{...row,enabled:true};
function limit(next,plan) {
  if(next.video.length>MAX_NODES&&next.video.length>plan.video.length)throw new Error(`A graphics chain can contain at most ${MAX_NODES} effects.`);
  return next;
}

const contexts = new WeakMap();
export function createEditContext(catalog = [],{nativeVideo = false,newId = () => globalThis.crypto.randomUUID(),implementation:refine} = {}) {
  const selected=new Map(),library=catalog.filter(row=>!row.nodeId),implementations=new WeakMap(),types=new WeakMap();
  for(const row of catalog)if(row.nodeId){const key=row.nodeId+"\n"+row.selectionKey;if(!selected.has(key))selected.set(key,row);}
  const resolve=(row,found)=>refine?refine(row,found):found;
  const ctx=Object.freeze({catalog,library,nativeVideo:nativeVideo===true,newId,
    implementation(row) {
      if(implementations.has(row))return implementations.get(row);
      const found=resolve(row,selected.size&&selected.get(row.id+"\n"+effectSelectionKey(row))||library.find(choice=>sameImplementation(row,choice)));
      implementations.set(row,found);return found;
    },
    type(row) {
      let type=types.get(row);
      if(!type){type=graphicsType(row,ctx.implementation(row)||{});types.set(row,type);}
      return type;
    }});
  contexts.set(ctx,(row,choice)=>{if(!implementations.has(row))implementations.set(row,resolve(row,choice));});
  return ctx;
}
// A row created from a choice outside the context catalog, such as a newly
// imported shader, is typed by that choice.
const remember = (ctx,row,choice) => contexts.get(ctx)?.(row,choice);

// Owners keep sizing helpers by their own role: a scaler reduces its input and,
// at a fixed scale, fits its output; a neural image row works at a processing height.
const ownerRole = (row,ctx) => !row?"none":ctx.type(row)==="upscale"?"scale":row.kind==="neural"?"neural":"none";
function scaleOf(implementation) {
  const geometry=shaderGeometry(implementation||{}),declared=geometry.scale??geometry.range?.max;
  const scale=declared&&declared.x===declared.y?declared.x:undefined;
  return Number.isFinite(scale)&&scale>1?scale:2;
}
const divisor = scale => RENDER_DIVISORS.filter(value=>value<=scale+1e-9).at(-1)||1;
const inputScale = (input,owner,ctx) => input.extent?.relativeTo==="presentation"&&input.extent.factor>0?1/input.extent.factor:scaleOf(ctx.implementation(owner));
const modelBacked = (row,choice) => row.kind==="neural"||choice?.runtimeManagerId==="graphics-neural-models"||Boolean(choice?.modelOperation)||Object.hasOwn(NEURAL,row.method||"");
const sameSelection = (row,choice) => sameImplementation(row,choice)&&(row.kind!=="shader"||
  (choice.template.shader?.effectPath??null)===null||choice.template.shader.effectPath===row.shader?.effectPath);
// A replaced row's size carries to the new shader. An explicit factor or pixel
// size wins over the slot's automatic sizing even when it gives the shader
// another resize type; the window fit and the legacy automatic marker follow
// the slot.
const explicitSize = extent => !extent.automatic&&!(extent.relativeTo==="presentation"&&extent.factor===1);
function shaderExtent(choice,type,previous) {
  if(!extentEditable(choice))return undefined;
  const kept=previous&&graphicsType({...choice.template,extent:previous},choice);
  return kept===type||(kept==="downsample"||kept==="upscale")&&explicitSize(previous)?previous:slotExtent(type);
}
// A carried size keeps the direction its new row kind requires.
const sizeFits = (kind,extent) => !(extent?.relativeTo==="input"&&(kind==="downsample"&&extent.factor>1||kind==="upscale"&&extent.factor<1));
function sizeOf(row) {
  if(!row)return undefined;
  if(row.extent)return row.extent;
  if(row.kind==="shader"||row.kind==="neural")return undefined;
  if(row.outputSize?.width!==undefined)return {width:row.outputSize.width,...(row.outputSize.height!==undefined?{height:row.outputSize.height}:{})};
  if(row.outputSize?.height!==undefined)return {height:row.outputSize.height};
  if(row.presentationScale!==undefined)return {relativeTo:"presentation",factor:row.presentationScale};
  if(row.kind==="spatial"&&typeof row.settings?.spatialMultiplier==="number")return {relativeTo:"input",factor:row.settings.spatialMultiplier};
  return undefined;
}
// Simple places a row before the first visible row of a later type; an owner's
// input helper stays attached to its owner.
function slotIndex(video,type,ctx) {
  const rank=RANK.get(type),at=video.findIndex(row=>!row.ownedBy&&RANK.get(ctx.type(row))>rank);
  if(at<0)return video.length;
  const input=rowsIndex(video).helpers.get(video[at].id)?.input,position=input?video.indexOf(input):-1;
  return position>=0&&position<at?position:at;
}
// Sizing is manual with another source request, an explicit owner size other
// than the window fit, or another reduction in the chain.
function sizingManual(plan,owner,input,ctx) {
  const source=plan.renderResolution,extent=owner.extent;
  return source!=null&&source.managedBy!==owner.id||Boolean(extent)&&!(extent.relativeTo==="presentation"&&extent.factor===1)||
    plan.video.some(row=>row!==input&&(!row.ownedBy||row.enabled)&&ctx.type(row)==="downsample");
}
function respec(row,spec) {
  if(row.enabled&&row.kind===spec.kind&&row.method===spec.method&&equal(row.extent,spec.extent)&&row.outputSize===undefined&&row.presentationScale===undefined)return row;
  const {outputSize:_size,presentationScale:_scale,...rest}=row;return {...rest,...spec,enabled:true};
}
const helperRow = (id,ownerId,role,spec) => ({id,kind:spec.kind,enabled:true,method:spec.method,settings:{},extent:spec.extent,ownedBy:{id:ownerId,role}});
function scaleFit(ownerId,ctx) {
  const choice=bidirectionalFitImplementation(ctx.library);
  if(!choice||choice.template.kind==="shader")return undefined;
  const template=structuredClone(choice.template);
  return {...template,id:ctx.newId(),kind:"spatial",enabled:true,settings:{...template.settings,spatialMultiplier:null},ownedBy:{id:ownerId,role:"fit"}};
}
function neuralFit(ownerId,ctx) {
  const rows=implementationsFor("upscale",ctx.library).filter(row=>row.available&&isResize(row.template));
  const choice=orderImplementations(rows).find(row=>row.recommendationRank===0)||["bicubic","bilinear","metalfx"].map(method=>rows.find(row=>row.template.method===method)).find(Boolean);
  return choice&&{...structuredClone(choice.template),id:ctx.newId(),enabled:true,ownedBy:{id:ownerId,role:"fit"}};
}
// A model's fit follows the presentation in either direction: a non-shader
// owner with a fixed enlarging scale can exceed the window. Shader owners
// keep the fit chosen for them.
function intrinsicFit(owner,ctx) {
  if(!owner||owner.kind==="shader")return false;
  const geometry=shaderGeometry(ctx.implementation(owner)||{});
  return geometry.kind==="scale"&&geometry.directions.includes("upscale");
}
function normalizedFit(fit,ctx) {
  if(!["spatial","upscale"].includes(fit.kind)||!isPresentationFit(fit)||fit.extent&&fit.extent.factor!==1||fit.presentationScale!==undefined&&fit.presentationScale!==1)return fit;
  const choice=bidirectionalFitImplementation(ctx.library,fit.method);
  if(!choice||fit.kind==="spatial"&&fit.method===choice.template.method)return fit;
  return {...fit,kind:"spatial",method:choice.template.method,settings:fit.method===choice.template.method?fit.settings:{...choice.template.settings,spatialMultiplier:null}};
}

function retire(plan,ownerId) {
  return dropManaged(withVideo(plan,mapRows(plan.video,row=>row.ownedBy?.id===ownerId&&row.enabled?{...row,enabled:false}:row)),ownerId);
}
// Re-enabling keeps the helpers chosen earlier. An input whose source request
// was replaced in the meantime no longer applies.
function restore(plan,ownerId,ctx) {
  const index=rowsIndex(plan.video),owner=index.byId.get(ownerId),owned=index.helpers.get(ownerId);
  if(!owner?.enabled||!owned)return plan;
  let next=plan;const {input,fit}=owned,source=plan.renderResolution;
  if(input&&ownerRole(owner,ctx)==="scale"&&source!=null&&source.managedBy!==ownerId)next=dropRow(next,input);
  else if(input){
    next=replaceRow(next,input,enable(input));
    if(ownerRole(owner,ctx)==="scale"&&source==null)next=withSource(next,{multiplier:divisor(inputScale(input,owner,ctx)),managedBy:ownerId});
  }
  return fit?replaceRow(next,fit,enable(fit)):next;
}
// Derives helpers for the owner's current implementation. Existing helpers are
// automatic by definition and follow it; new ones appear only when `create`.
// An implementation that owns no sizing loses its helpers, enabled or not.
function derive(plan,ownerId,ctx,create) {
  const index=rowsIndex(plan.video),owner=index.byId.get(ownerId);
  if(!owner)return plan;
  const role=ownerRole(owner,ctx),{input,fit}=index.helpers.get(ownerId)||{};
  let next=role==="scale"?plan:dropManaged(plan,ownerId);
  if(role==="none")return withVideo(next,filterRows(next.video,row=>row.ownedBy?.id!==ownerId));
  if(!owner.enabled)return retired(plan,owner,ctx,create);
  const implementation=ctx.implementation(owner);
  if(role==="scale"){
    const manual=sizingManual(next,owner,input,ctx),scale=scaleOf(implementation);
    if(!manual&&(input||create)){
      const spec={kind:"downsample",method:"bilinear",extent:{relativeTo:"presentation",factor:Math.max(1/16,1/scale)}};
      next=input?replaceRow(next,input,respec(input,spec)):insertRow(next,next.video.indexOf(owner),helperRow(ctx.newId(),ownerId,"input",spec));
      next=withSource(next,{multiplier:divisor(scale),managedBy:ownerId});
    }else if(input)next=next.renderResolution?.managedBy===ownerId?replaceRow(next,input,enable(input)):dropRow(next,input);
    if(shaderGeometry(implementation||{}).kind!=="scale")return dropRow(next,fit);
    if(fit)return replaceRow(next,fit,enable(intrinsicFit(owner,ctx)?normalizedFit(fit,ctx):fit));
    const row=create&&!manual?scaleFit(ownerId,ctx):undefined;
    return row?insertRow(next,next.video.indexOf(owner)+1,row):next;
  }
  if(ctx.nativeVideo)next=dropRow(next,input);
  else if(input)next=replaceRow(next,input,respec(input,{kind:"downsample",method:"bilinear",extent:{height:DEFAULT_PROCESSING_HEIGHT}}));
  else if(create&&!next.video.some(row=>row!==owner&&ctx.type(row)==="downsample"))
    next=insertRow(next,Math.min(slotIndex(next.video,"downsample",ctx),next.video.indexOf(owner)),
      helperRow(ctx.newId(),ownerId,"input",{kind:"downsample",method:"bilinear",extent:{height:DEFAULT_PROCESSING_HEIGHT}}));
  if(fit)return replaceRow(next,fit,enable(fit));
  const row=create&&!next.video.some(row=>ctx.type(row)==="upscale")?neuralFit(ownerId,ctx):undefined;
  return row?insertRow(next,Math.max(slotIndex(next.video,"upscale",ctx),next.video.indexOf(owner)+1),row):next;
}
// An Off owner keeps the helpers its current implementation derives, retired,
// so enabling it later restores sizing for that implementation. Rows and plans
// that come out structurally unchanged keep their identity.
function retired(plan,owner,ctx,create) {
  const on={...owner,enabled:true};remember(ctx,on,ctx.implementation(owner));
  const next=retire(replaceRow(derive(replaceRow(plan,owner,on),owner.id,ctx,create),on,owner),owner.id);
  if(next===plan)return plan;
  const {byId}=rowsIndex(plan.video),video=mapRows(next.video,row=>{const old=byId.get(row.id);return old!==row&&equal(old,row)?old:row;});
  const result=withVideo(next,video);
  return equal(result,plan)?plan:result;
}
// A user edit to a helper makes it an ordinary row. A conventionally named
// helper is renamed so that reading the plan never re-owns it, and an adopted
// input takes manual control of the source request it was paired with.
function adopt(plan,id,ctx) {
  const row=rowsIndex(plan.video).byId.get(id);
  if(row?.ownedBy===undefined)return {plan,id};
  const {ownedBy,...rest}=row,next=conventional(id)?ctx.newId():id;
  let result=replaceRow(plan,row,next===id?rest:{...rest,id:next});
  const quality=result.output?.adaptiveQuality;
  if(next!==id&&quality?.nodeId===id)result={...result,output:{...result.output,adaptiveQuality:{...quality,nodeId:next}}};
  return {plan:ownedBy.role==="input"?stripManaged(result,ownedBy.id):result,id:next};
}
const owns = (plan,id) => rowsIndex(plan.video).helpers.has(id)||plan.renderResolution?.managedBy===id;
// Neural helpers exist only while no other row of their type does.
function redundant(plan,row,ctx) {
  const type=ctx.type(row),role=type==="downsample"?"input":type==="upscale"?"fit":null;
  if(!role)return plan;
  const {byId}=rowsIndex(plan.video);
  return withVideo(plan,filterRows(plan.video,value=>!(value.ownedBy?.role===role&&value.ownedBy.id!==row.id&&ownerRole(byId.get(value.ownedBy.id),ctx)==="neural")));
}
function withExtent(row,extent) {
  if(row.kind==="shader"){
    if(equal(row.extent,extent??undefined))return row;
    const {extent:_extent,...rest}=row;return extent?{...rest,extent}:rest;
  }
  const {outputSize,presentationScale,extent:_extent,...rest}=row,{spatialMultiplier,...settings}=row.settings||{};
  if(equal(row.extent,extent??undefined)&&outputSize===undefined&&presentationScale===undefined&&spatialMultiplier===undefined)return row;
  return {...rest,settings,...(extent?{extent}:{})};
}
function merge(base,patch) {
  let result=base;
  for(const key of Object.keys(patch)){
    if(!safe(key))continue;
    if(patch[key]===undefined){if(Object.hasOwn(base,key)){if(result===base)result={...base};delete result[key];}}
    else if(!equal(base[key],patch[key])){if(result===base)result={...base};result[key]=patch[key];}
  }
  return result;
}
function placed(choice,slot,current,ctx,extent) {
  const row={...structuredClone(choice.template),id:current?current.id:ctx.newId(),enabled:true};
  if(row.kind==="shader"){
    if(choice.modelOperation)row.settings={...row.settings,modelPath:row.settings?.modelPath||null};
    const size=extent??shaderExtent(choice,slot,sizeOf(current));
    if(size)row.extent=size;else delete row.extent;
    return row;
  }
  if(modelBacked(row,choice))row.settings={...row.settings,modelPath:row.settings?.modelPath||null};
  if(current&&current.kind!=="shader"){
    if(current.method===row.method)row.settings={...row.settings,...current.settings};
    else if(current.kind==="frame-generation"&&row.kind==="frame-generation")row.settings={...row.settings,frameMultiplier:current.settings?.frameMultiplier??2};
    if(current.kind!=="neural"&&row.kind!=="neural"&&isResize(current)&&isResize(row)&&!choice.intrinsicScale&&SIZES.some(key=>current[key]!==undefined)&&sizeFits(row.kind,current.extent))
      for(const key of SIZES)if(current[key]===undefined)delete row[key];else row[key]=structuredClone(current[key]);
  }
  if(extent&&isResize(row)){for(const key of SIZES)delete row[key];row.extent=extent;}
  return row;
}
function place(plan,slot,current,choice,ctx,extent) {
  if(current?.ownedBy!==undefined){const adopted=adopt(plan,current.id,ctx);plan=adopted.plan;current=rowsIndex(plan.video).byId.get(adopted.id);}
  if(current&&sameSelection(current,choice)){
    const row=extent!==undefined&&(current.kind==="shader"||isResize(current))?withExtent(enable(current),extent):enable(current);
    return {plan:restore(replaceRow(plan,current,row),row.id,ctx),id:row.id};
  }
  const row=placed(choice,slot,current,ctx,extent);remember(ctx,row,choice);
  const next=current?replaceRow(plan,current,row):insertRow(plan,slotIndex(plan.video,slot,ctx),row);
  return {plan:limit(derive(redundant(next,row,ctx),row.id,ctx,true),plan),id:row.id};
}

// Reading
export function migrateOwnership(plan) {
  if(!object(plan)||plan.schema!==2||!Array.isArray(plan.video)||plan.video.some(row=>!object(row)||typeof row.id!=="string"))return plan;
  return repair(assign(plan));
}
// Preparation reads fits as the edits derived them: the presentation fit of
// an enlarging model owner follows the catalog's bidirectional fit method.
export function normalizeFits(plan,ctx) {
  const {byId}=rowsIndex(plan.video);
  return withVideo(plan,mapRows(plan.video,row=>row.ownedBy?.role==="fit"&&intrinsicFit(byId.get(row.ownedBy.id),ctx)?normalizedFit(row,ctx):row));
}
// Conventional helper ids become explicit ownership.
function assign(plan) {
  return withVideo(plan,mapRows(plan.video,row=>{
    const match=row.ownedBy===undefined&&isResize(row)&&PREFIXED.exec(row.id);
    return match?{...row,ownedBy:{id:match[3],role:match[2]}}:row;
  }));
}
// Helpers without a valid owner (missing, itself a helper, or of a kind that
// cannot own helpers) are removed, they follow their owner's enabled state,
// and they sit on their own side of it. A source request follows its owner's
// input helper.
function repair(plan) {
  const {byId}=rowsIndex(plan.video),kept=new Map();
  const valid=row=>{const owner=byId.get(row.ownedBy.id);return Boolean(owner)&&owner!==row&&owner.ownedBy===undefined&&ownsHelpers(owner);};
  for(const row of plan.video)if(claim(row.ownedBy)&&isResize(row)&&valid(row)){
    const key=row.ownedBy.id+"\n"+row.ownedBy.role,current=kept.get(key);
    if(!current||!current.enabled&&row.enabled)kept.set(key,row);
  }
  const helper=row=>claim(row.ownedBy)&&isResize(row);
  let video=filterRows(plan.video,row=>!helper(row)||kept.get(row.ownedBy.id+"\n"+row.ownedBy.role)===row&&(row.enabled||!byId.get(row.ownedBy.id).enabled));
  video=mapRows(video,row=>helper(row)&&row.enabled&&!byId.get(row.ownedBy.id).enabled?{...row,enabled:false}:row);
  const position=new Map(video.map((row,index)=>[row,index]));
  const misplaced=video.filter(row=>helper(row)&&position.get(row)<position.get(byId.get(row.ownedBy.id))!==(row.ownedBy.role==="input"));
  if(misplaced.length){
    const moving=new Set(misplaced),attached=(row,role)=>misplaced.filter(value=>value.ownedBy.id===row.id&&value.ownedBy.role===role);
    video=video.filter(row=>!moving.has(row)).flatMap(row=>[...attached(row,"input"),row,...attached(row,"fit")]);
  }
  let next=withVideo(plan,video);const source=plan.renderResolution;
  if(object(source)&&typeof source.managedBy==="string"){
    const owner=byId.get(source.managedBy);
    if(!owner?.enabled||!ownsHelpers(owner))next=withSource(next,undefined);
    else if(!video.some(row=>helper(row)&&row.ownedBy.id===owner.id&&row.ownedBy.role==="input"&&row.enabled))next=stripManaged(next,owner.id);
  }
  return next;
}

const projections = new WeakMap(), checks = new WeakMap(), NONE = {};
function memo(cache,plan,ctx,compute) {
  let entries=cache.get(plan);if(!entries){entries=new WeakMap();cache.set(plan,entries);}
  const key=ctx||NONE;if(!entries.has(key))entries.set(key,compute());
  return entries.get(key);
}
export function project(plan,ctx) {
  return memo(projections,plan,ctx,()=>{
    const helpers=new Map(),types=new Map(),slots=new Map(SIMPLE_ORDER.map(type=>[type,[]])),ranks=[];
    for(const row of plan.video){
      if(row.ownedBy!==undefined){const id=row.ownedBy?.id,list=helpers.get(id);if(list)list.push(row);else helpers.set(id,[row]);continue;}
      const type=ctx.type(row);types.set(row.id,type);slots.get(type).push(row);
      if(row.enabled)ranks.push(RANK.get(type));
    }
    return {slots:SIMPLE_ORDER.map(id=>{
      const rows=slots.get(id),enabled=rows.filter(row=>row.enabled),{label}=GRAPHICS_TYPES.find(type=>type.id===id);
      return {id,label,rows,row:enabled.length===1?enabled[0]:rows.length===1?rows[0]:undefined,custom:enabled.length>1};
    }),imageRows:slots.get("image"),helpers,types,customOrder:ranks.some((rank,index)=>index>0&&rank<ranks[index-1])};
  });
}
// Plan.validate's ownership rules are reported as O1, so O7 covers the rest.
function validated(plan) {
  if(!Array.isArray(plan?.video)||!plan.video.some(row=>row?.ownedBy!==undefined))return validate(plan);
  return validate({...plan,video:plan.video.map(row=>{if(row?.ownedBy===undefined)return row;const {ownedBy:_owner,...rest}=row;return rest;})});
}
export function check(plan,ctx) {
  return memo(checks,plan,ctx,()=>{
    const violations=[],report=(code,message,rowId)=>violations.push(rowId===undefined?{code,message}:{code,message,rowId});
    const video=Array.isArray(plan?.video)?plan.video:[],byId=new Map(video.map(row=>[row?.id,row])),roles=new Set();
    video.forEach((row,index)=>{
      if(row?.ownedBy===undefined){if(PREFIXED.test(row?.id))report("O5","A conventionally named helper has no owner.",row.id);return;}
      const owner=claim(row.ownedBy)?byId.get(row.ownedBy.id):undefined;
      if(!owner||owner===row||owner.ownedBy!==undefined||!ownsHelpers(owner)||!isResize(row)){report("O1","A helper is a resize row owned by another, unowned row that can own helpers.",row.id);return;}
      const key=row.ownedBy.id+"\n"+row.ownedBy.role;
      if(roles.has(key))report("O1","An owner has at most one helper per role.",row.id);
      roles.add(key);
      if(row.enabled!==owner.enabled)report("O2","A helper follows its owner's enabled state.",row.id);
      if(index<video.indexOf(owner)!==(row.ownedBy.role==="input"))report("O4","An input helper precedes its owner and a fit helper follows it.",row.id);
    });
    const managed=plan?.renderResolution?.managedBy;
    if(managed!==undefined&&!(byId.get(managed)?.enabled&&video.some(row=>row.ownedBy?.id===managed&&row.ownedBy.role==="input"&&row.enabled)))
      report("O3","A managed source request needs its enabled owner and input helper.",managed);
    if(ctx&&!violations.some(item=>item.code==="O1")){
      const projection=project(plan,ctx),visible=projection.slots.reduce((total,slot)=>total+slot.rows.length,0);
      const attached=[...projection.helpers].reduce((total,[id,rows])=>total+(byId.has(id)?rows.length:0),0);
      if(visible+attached!==video.length)report("O6","Every row is one Simple row or a helper of one.");
    }
    try{validated(plan);}catch(error){report("O7",error.message);}
    return violations;
  });
}

function pairedInput(row,owner) {
  const match=row.ownedBy===undefined&&PREFIXED.exec(row.id);
  return row.ownedBy?.id===owner&&row.ownedBy.role==="input"||Boolean(match)&&match[2]==="input"&&match[3]===owner;
}
// Three-way merge of one editor's change (base → desired) into the current
// plan. Other editors' rows, fields and order survive; ownership is repaired.
// Sizes and ownership are single choices, never merged field by field.
const ATOMIC = new Set(["renderResolution","extent","outputSize","ownedBy"]);
function patch(current,base,desired) {
  if(equal(base,desired))return current;
  if(!object(base)||!object(desired))return desired;
  let result=object(current)?current:{};
  for(const key of new Set([...present(base),...present(desired)])){
    if(!safe(key)||equal(base[key],desired[key]))continue;
    if(desired[key]===undefined){if(Object.hasOwn(result,key)){if(result===current)result={...result};delete result[key];}continue;}
    const value=ATOMIC.has(key)?desired[key]:patch(result[key],base[key],desired[key]);
    if(value!==result[key]&&!equal(value,result[key])){if(result===current)result={...result};result[key]=value;}
  }
  return result;
}
// A row whose kind changed is a replacement, and its size fields are one choice.
function mergeRow(current,base,desired) {
  if(base.kind!==desired.kind)return desired;
  if(current.kind!==base.kind)return current;
  const row=patch(current,base,desired);
  if(SIZES.every(key=>equal(base[key],desired[key]))||SIZES.every(key=>equal(row[key],desired[key])))return row;
  const sized={...row};
  for(const key of SIZES)if(desired[key]===undefined)delete sized[key];else sized[key]=desired[key];
  return sized;
}
export function rebase(current,base,desired) {
  if(!base||!current||current===base)return migrateOwnership(desired);
  const {video:currentRows,...currentFields}=current,{video:baseRows,...baseFields}=base,{video:desiredRows,...desiredFields}=desired;
  const previous=new Map(baseRows.map(row=>[row.id,row])),requested=new Map(desiredRows.map(row=>[row.id,row])),rows=new Map();
  for(const row of currentRows)if(!previous.has(row.id)||requested.has(row.id))rows.set(row.id,row);
  for(const row of desiredRows){
    if(!previous.has(row.id))rows.set(row.id,row);
    else if(rows.has(row.id))rows.set(row.id,mergeRow(rows.get(row.id),previous.get(row.id),row));
  }
  let order=[...rows.keys()];
  if(baseRows.length!==desiredRows.length||baseRows.some((row,index)=>row.id!==desiredRows[index].id)){
    const wanted=desiredRows.map(row=>row.id).filter(id=>rows.has(id)),wantedSet=new Set(wanted),gaps=new Map();
    let anchor=null;
    for(const id of order){
      if(wantedSet.has(id))anchor=id;
      else{const group=gaps.get(anchor)||[];group.push(id);gaps.set(anchor,group);}
    }
    order=[...(gaps.get(null)||[]),...wanted.flatMap(id=>[id,...(gaps.get(id)||[])])];
  }
  const fields={...patch(currentFields,baseFields,desiredFields)};
  // A convenience source request never replaces another editor's source
  // choice. A managed request that does not survive takes its input helper along.
  if(!equal(current.renderResolution,base.renderResolution)&&(desired.renderResolution?.managedBy||base.renderResolution?.managedBy&&desired.renderResolution==null)){
    if(current.renderResolution==null)delete fields.renderResolution;else fields.renderResolution=current.renderResolution;
  }
  let video=order.map(id=>rows.get(id));
  for(const owner of new Set([current.renderResolution?.managedBy,desired.renderResolution?.managedBy]))
    if(owner!==undefined&&owner!==fields.renderResolution?.managedBy)video=video.filter(row=>!pairedInput(row,owner));
  const unchanged=video.length===currentRows.length&&video.every((row,index)=>row===currentRows[index]);
  const keys=present(fields),same=unchanged&&keys.length===present(currentFields).length&&keys.every(key=>fields[key]===current[key]);
  return migrateOwnership(same?current:{...fields,video:unchanged?currentRows:video});
}

// Edits
export function setSlot(plan,slot,rowId,choice,ctx,o = {}) {
  if(!choice)return rowId==null?plan:setEnabled(plan,rowId,false,ctx);
  const current=rowId==null?undefined:rowsIndex(plan.video).byId.get(rowId);
  if(rowId!=null&&!current)return plan;
  return place(plan,slot,current,choice,ctx,o.extent).plan;
}
export function setEnabled(plan,rowId,enabled,ctx) {
  let row=rowsIndex(plan.video).byId.get(rowId);
  if(!row||row.ownedBy!==undefined&&row.enabled===enabled)return plan;
  if(row.ownedBy!==undefined){({plan,id:rowId}=adopt(plan,rowId,ctx));row=rowsIndex(plan.video).byId.get(rowId);}
  const next=row.enabled===enabled?plan:replaceRow(plan,row,{...row,enabled});
  return enabled?restore(next,rowId,ctx):retire(next,rowId);
}
// An input helper owns the source request made for it, so removing either the
// helper or its owner removes that request. A manual request stays.
export function remove(plan,rowId,_ctx) {
  const row=rowsIndex(plan.video).byId.get(rowId);
  if(!row)return plan;
  const next=withVideo(plan,filterRows(plan.video,value=>value!==row&&value.ownedBy?.id!==rowId));
  return dropManaged(row.ownedBy?.role==="input"?dropManaged(next,row.ownedBy.id):next,rowId);
}
// An owner moves with its helpers, the input directly before it and the fit
// directly after; the group lands past the nearest other row in that direction.
export function move(plan,rowId,to,ctx) {
  const {byId,helpers}=rowsIndex(plan.video),row=byId.get(rowId),last=plan.video.length-1;
  if(!row)return plan;
  const from=plan.video.indexOf(row);to=Math.max(0,Math.min(last,Math.trunc(to)));
  if(to===from)return plan;
  if(row.ownedBy!==undefined){const adopted=adopt(plan,rowId,ctx);return move(adopted.plan,adopted.id,to,ctx);}
  const owned=helpers.get(rowId),group=[owned?.input,row,owned?.fit].filter(Boolean),members=new Set(group),down=to>from;
  let target=to;
  while(target>=0&&target<=last&&members.has(plan.video[target]))target+=down?1:-1;
  if(target<0||target>last)return plan;
  const rest=plan.video.filter(value=>!members.has(value)),at=rest.indexOf(plan.video[target])+(down?1:0);
  const video=[...rest.slice(0,at),...group,...rest.slice(at)];
  return video.every((value,index)=>value===plan.video[index])?plan:withVideo(plan,video);
}
export function setExtent(plan,rowId,extent,ctx,o = {}) {
  let row=rowsIndex(plan.video).byId.get(rowId);
  if(!row)return plan;
  if(row.kind!=="shader"&&!isResize(row))throw new Error("This effect has no output size.");
  if(withExtent(row,extent)===row)return plan;
  if(row.ownedBy!==undefined&&!(o.asOwner===true&&row.ownedBy.role==="fit")){({plan,id:rowId}=adopt(plan,rowId,ctx));row=rowsIndex(plan.video).byId.get(rowId);}
  const sized=withExtent(row,extent),next=replaceRow(plan,row,sized);
  return row.ownedBy===undefined&&owns(next,rowId)&&ctx.type(row)!==ctx.type(sized)?derive(next,rowId,ctx,false):next;
}
// Parameters, method settings and model paths. A model change that alters the
// intrinsic scale or type refits owned sizing.
export function setSettings(plan,rowId,changes = {},ctx) {
  const update=row=>{
    let next=row;
    if(changes.shader&&row.kind==="shader"){const shader=merge(row.shader,changes.shader);if(shader!==row.shader)next={...next,shader};}
    if(changes.settings){const base=row.settings||{},settings=merge(base,changes.settings);if(settings!==base)next={...next,settings};}
    return next;
  };
  let row=rowsIndex(plan.video).byId.get(rowId);
  if(!row||update(row)===row)return plan;
  if(row.ownedBy!==undefined){({plan,id:rowId}=adopt(plan,rowId,ctx));row=rowsIndex(plan.video).byId.get(rowId);}
  const changed=update(row),next=replaceRow(plan,row,changed);
  if((row.settings?.modelPath??null)===(changed.settings?.modelPath??null))return next;
  return ctx.type(row)!==ctx.type(changed)||scaleOf(ctx.implementation(row))!==scaleOf(ctx.implementation(changed))?limit(derive(next,rowId,ctx,true),plan):next;
}
export function add(plan,choice,ctx,o = {}) {
  const type=o.type||graphicsType(choice.template,choice);
  if(o.view==="simple")return place(plan,type,undefined,choice,ctx);
  const row={...structuredClone(choice.template),id:ctx.newId(),enabled:true};
  if(row.kind==="shader"){const extent=shaderExtent(choice,type,row.extent);if(extent)row.extent=extent;else delete row.extent;}
  if(row.kind==="shader"?choice.modelOperation:modelBacked(row,choice))row.settings={...row.settings,modelPath:row.settings?.modelPath||null};
  remember(ctx,row,choice);
  return {plan:limit(withVideo(plan,[...plan.video,row]),plan),id:row.id};
}
function swapped(row,choice,type,ctx) {
  const template=structuredClone(choice.template),base={...template,id:row.id,enabled:row.enabled};
  if(isResize(template)&&isResize(row)){
    if(modelBacked(template,choice))return base;
    const kind=row.kind==="spatial"?"spatial":template.kind,size=sizeOf(row),extent=sizeFits(kind,size)?size:undefined;
    return {...base,kind,...(extent?{extent}:{}),settings:{...template.settings,
      ...(!modelBacked(row,ctx.implementation(row))?row.settings:{}),...(extent?{spatialMultiplier:null}:{}),spatialMethod:template.method}};
  }
  const extent=template.kind==="shader"?shaderExtent(choice,type,sizeOf(row)):sizeOf(row);
  return extent&&extentEditable(choice)&&(template.kind==="shader"||isResize(template)&&sizeFits(template.kind,extent))?{...base,extent}:base;
}
// Advanced method picker: settings and size carry within the same type.
export function changeMethod(plan,rowId,choice,ctx) {
  let row=rowsIndex(plan.video).byId.get(rowId);
  if(!row||sameImplementation(row,choice))return plan;
  if(row.ownedBy!==undefined){({plan,id:rowId}=adopt(plan,rowId,ctx));row=rowsIndex(plan.video).byId.get(rowId);}
  const next=swapped(row,choice,ctx.type(row),ctx);remember(ctx,next,choice);
  const result=replaceRow(plan,row,next);
  return owns(result,rowId)?derive(result,rowId,ctx,false):result;
}
export function placeImported(plan,choices,target = {},ctx,view = "advanced") {
  const incompatible=[];let next=plan,replaceId=target.rowId;
  if(replaceId!=null&&!rowsIndex(plan.video).byId.has(replaceId))return {plan,incompatible};
  for(const choice of choices){
    const type=target.slot||graphicsType(choice.template,choice);
    if(!implementationsFor(type,[choice],{contextual:true}).length){incompatible.push(choice.label);continue;}
    const replace=replaceId==null?undefined:rowsIndex(next.video).byId.get(replaceId);replaceId=undefined;
    if(replace&&sameImplementation(replace,choice))continue;
    if(view==="simple")next=place(next,type,replace,choice,ctx).plan;
    else if(replace){
      let row=replace;
      if(row.ownedBy!==undefined){const adopted=adopt(next,row.id,ctx);next=adopted.plan;row=rowsIndex(next.video).byId.get(adopted.id);}
      const swap=swapped(row,choice,type,ctx);remember(ctx,swap,choice);next=replaceRow(next,row,swap);
      if(owns(next,swap.id))next=derive(next,swap.id,ctx,false);
    }else next=add(next,choice,ctx,{type,view:"advanced"}).plan;
  }
  return {plan:next,incompatible};
}
// A source choice is manual. It replaces a managed request together with the
// input helper paired with it.
export function setSource(plan,value) {
  let source;
  if(value!=null){const {managedBy:_owner,...rest}=value;source=rest;}
  if(source==null?plan.renderResolution==null:equal(source,plan.renderResolution))return plan;
  const owner=plan.renderResolution?.managedBy,input=owner===undefined?undefined:rowsIndex(plan.video).helpers.get(owner)?.input;
  return withSource(dropRow(plan,input),source);
}
export function setOutput(plan,changes) {
  const base=plan.output||{},output=merge(base,changes);
  if(output===base)return plan;
  if(present(output).length)return {...plan,output};
  const {output:_output,...rest}=plan;return rest;
}
// The game's depth input keeps only values that differ from the defaults.
export function setDepthInput(plan,changes) {
  const base=plan.depthInput||{},merged=merge(base,changes);
  const depthInput=Object.fromEntries(Object.entries(merged).filter(([key,value])=>!equal(value,DEPTH_INPUT_DEFAULTS[key])));
  if(equal(depthInput,base))return plan;
  if(present(depthInput).length)return {...plan,depthInput};
  const {depthInput:_depthInput,...rest}=plan;return rest;
}
export function setMaster(plan,enabled) {
  return (plan.enabled!==false)===enabled?plan:{...plan,enabled};
}
// Clear effects removes managed source requests with their rows and keeps a
// manual source choice.
export function clear(plan) {
  const source=plan.renderResolution,manual=source!=null&&!source.managedBy;
  if(!plan.video.length&&plan.output===undefined&&plan.enabled!==false&&(source==null||manual))return plan;
  const {output:_output,renderResolution:_source,...rest}=plan;
  return {...rest,enabled:true,video:[],...(manual?{renderResolution:source}:{})};
}
