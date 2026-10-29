const test = require("node:test"), assert = require("node:assert/strict");
const Groups = require("../src/modules/shared/reshade/plane-groups");

test("plane programs isolate SAVE/BIND names and parameter uniforms", () => {
  const first = "//!PARAM Strength\n1.0\n//!HOOK LUMA\n//!BIND HOOKED\n//!SAVE features\nvec4 hook(){return features_tex(HOOKED_pos)*Strength;}\n//!HOOK LUMA\n//!BIND features\nvec4 hook(){return features_tex(HOOKED_pos);}";
  const next = first.replaceAll("LUMA", "CHROMA");
  const combined = Groups.combine([{source: first, parameters: {Strength: [0.5]}}, {source: next, parameters: {Strength: [0.8]}}]);
  assert.ok(combined);
  assert.match(combined.source, /\/\/!SAVE mlg0_features/);
  assert.match(combined.source, /\/\/!BIND mlg1_features/);
  assert.match(combined.source, /mlg1_features_tex\(HOOKED_pos\)\*mlg1_Strength/);
  assert.deepEqual(combined.parameters, {mlg0_Strength: [0.5], mlg1_Strength: [0.8]});
  assert.match(combined.source, /\/\/!HOOK LUMA/);assert.match(combined.source, /\/\/!HOOK CHROMA/);
});

test("a phase inversion cannot silently reorder logical effect rows", () => {
  assert.equal(Groups.combine([{source: "//!HOOK MAIN\nvec4 hook(){return vec4(1);}"},
    {source: "//!HOOK LUMA\nvec4 hook(){return vec4(1);}"}]), null);
  assert.ok(Groups.combine([{source: "//!HOOK LUMA\nvec4 hook(){return vec4(1);}"},
    {source: "//!HOOK CHROMA\n//!BIND LUMA\nvec4 hook(){return vec4(1);}"}]));
});

test("built-in plane SAVE and human descriptions keep their meaning", () => {
  const source = "//!DESC features and Strength\n//!PARAM Strength\n1.0\n//!HOOK LUMA\n//!SAVE LUMA\n//!WIDTH LUMA.w 2 *\nvec4 hook(){return vec4(Strength);}";
  const combined = Groups.combine([{source, parameters: {Strength: [1]}}]);
  assert.match(combined.source, /\/\/!SAVE LUMA/);assert.match(combined.source, /\/\/!WIDTH LUMA.w 2 \*/);
  assert.match(combined.source, /\/\/!DESC features and Strength/);
  assert.match(combined.source, /vec4\(mlg0_Strength\)/);
});

test("namespace isolation does not rewrite exponents or hexadecimal literals", () => {
  const source = "//!PARAM e\n1.0\n//!HOOK LUMA\nvec4 hook(){return vec4(e + 1e-5 + 0xEE);}";
  const combined = Groups.combine([{source, parameters: {e: [1]}}]);
  assert.match(combined.source, /mlg0_e \+ 1e-5 \+ 0xEE/);
});
test("explicit shader output boundaries remain independent of plane grouping", async t => {
  const fs=require("node:fs"),os=require("node:os"),path=require("node:path"),directory=fs.mkdtempSync(path.join(os.tmpdir(),"plane-boundary-"));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const nodes=["LUMA","CHROMA"].map((plane,index)=>{const file=path.join(directory,index+".hook");fs.writeFileSync(file,`//!HOOK ${plane}\n//!BIND HOOKED\nvec4 hook(){return HOOKED_tex(HOOKED_pos);}`);return {id:String(index),kind:"shader",enabled:true,format:"libplacebo",file};});
  nodes[0].outputSize={width:8,height:6};
  const prepared=await Groups.prepare(nodes,{features:{providers:{libplacebo:{planeGroups:true}}},root:directory,userDataDir:directory});
  assert.deepEqual(prepared,nodes);assert.deepEqual(prepared[0].outputSize,{width:8,height:6});
});
test("a grouped refinement shader keeps the output target of its individual row", async t => {
  const fs=require("node:fs"),os=require("node:os"),path=require("node:path"),Libplacebo=require("../src/modules/shared/reshade/libplacebo");
  const Traits=require("../src/modules/shared/reshade/shader-traits"),Contracts=require("../src/modules/shared/effects/contracts.mjs");
  const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"plane-refinement-")));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const sources=["//!HOOK LUMA\n//!BIND HOOKED\nvec4 hook(){return HOOKED_tex(HOOKED_pos);}",
    "//!HOOK POSTKERNEL\n//!BIND HOOKED\n//!BIND LUMA\n//!WHEN OUTPUT.w MAIN.w >\nvec4 hook(){return HOOKED_tex(HOOKED_pos)+LUMA_tex(LUMA_pos);}"];
  // Runtime rows receive the classifier's default output for their own source.
  const nodes=sources.map((source,index)=>{const file=path.join(directory,index+".hook");fs.writeFileSync(file,source);
    return {id:String(index),kind:"shader",enabled:true,format:"libplacebo",file,parameters:{},...Contracts.shaderDefaultOutput({traits:Traits.inspect(source,"libplacebo")})};});
  assert.equal(nodes[1].outputExtent,"presentation");
  t.mock.method(Libplacebo,"prepare",async()=>({effect:path.join(directory,"group.bundle"),revision:"r"}));
  const [group,...rest]=await Groups.prepare(nodes,{features:{providers:{libplacebo:{planeGroups:true}}},root:directory,userDataDir:directory});
  assert.deepEqual(group.planeGroupMembers,["0","1"]);assert.equal(rest.length,0);
  for(const field of ["outputExtent","outputScale","outputSize","presentationScale"])assert.deepEqual(group[field],nodes[1][field],field);
});
