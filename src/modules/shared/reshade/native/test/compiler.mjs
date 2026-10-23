import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const compiler = path.resolve(process.argv[2] || "");
if (process.argv.length !== 3 || !fs.statSync(compiler).isFile())
  throw new Error("Usage: node compiler.mjs /path/to/fx-compile");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "reshade-compiler-"));
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^(DYLD_|RESHADE_)/.test(key)) delete env[key];
const run = args => execFileSync(compiler, args, { env, timeout: 10000, maxBuffer: 1 << 20, encoding: "utf8" });
try {
  fs.mkdirSync(path.join(root, "nested"));
  fs.writeFileSync(path.join(root, "nested/second.fxh"), "#define INCLUDED_VALUE 7\n");
  fs.writeFileSync(path.join(root, "nested/first.fxh"), String.raw`#define NEXT_INCLUDE ".\second.fxh"
#if !exists(NEXT_INCLUDE)
#error The relative include must exist
#endif
#include NEXT_INCLUDE
`);
  const include = path.join(root, "include.fx"), prepared = path.join(root, "prepared.fx");
  fs.writeFileSync(include, String.raw`#include ".\nested\first.fxh"
INCLUDED_VALUE
".\unchanged\ordinary-string"
`);
  run(["--prepare", include, prepared]);
  const output = fs.readFileSync(prepared, "utf8");
  assert.match(output, /\b7\b/);
  assert.ok(output.includes(String.raw`".\unchanged\ordinary-string"`), "ordinary strings retain their separators");

  const legacy = ["tex2Doffset(S, uv, int2(1, -1))", "tex2Dlodoffset(S, float4(uv, 0, 0), int2(-1, 1))",
    "tex2Dgather(S, uv, 0)", "tex2Dgatheroffset(S, uv, int2(1, 0), 1)",
    "tex2Dgather2(S, uv)", "tex2Dgather3(S, uv)"];
  const modern = ["tex2D(S, uv, int2(1, -1))", "tex2Dlod(S, float4(uv, 0, 0), int2(-1, 1))",
    "tex2DgatherR(S, uv)", "tex2DgatherG(S, uv, int2(1, 0))", "tex2DgatherB(S, uv)", "tex2DgatherA(S, uv)"];
  const shader = expressions => `texture T : COLOR; sampler S { Texture = T; };
void VS(uint id : SV_VertexID, out float4 pos : SV_Position, out float2 uv : TEXCOORD) {
  uv = float2((id << 1) & 2, id & 2); pos = float4(uv * 2 - 1, 0, 1);
}
float4 PS(float4 pos : SV_Position, float2 uv : TEXCOORD) : SV_Target { return ${expressions.join(" + ")}; }
technique Sampling { pass { VertexShader = VS; PixelShader = PS; } }
`;
  for (const [name, expressions] of [["legacy", legacy], ["modern", modern]]) {
    const file = path.join(root, name + ".fx"); fs.writeFileSync(file, shader(expressions));
    run([file, path.join(root, name)]);
  }
  const files = fs.readdirSync(path.join(root, "modern")).sort();
  assert.deepEqual(fs.readdirSync(path.join(root, "legacy")).sort(), files);
  assert.ok(files.some(name => name.endsWith(".glsl")) && files.some(name => name.endsWith(".metal")));
  for (const file of files) assert.deepEqual(fs.readFileSync(path.join(root, "legacy", file)),
    fs.readFileSync(path.join(root, "modern", file)), "legacy and modern sampling generate identical " + file);
  console.log("Compiler compatibility passed: nested include/exists, literal preservation, identical legacy sampling GLSL/MSL.");
} finally { fs.rmSync(root, { recursive: true, force: true }); }
