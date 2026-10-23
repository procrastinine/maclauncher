import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const source = `uniform float Amount < ui_label = "Blend amount"; ui_min = 0.0; ui_max = 1.0; ui_step = 0.25; > = 0.5;
texture2D Lookup < source = "lookup.png"; > { Width = 1; Height = 1; Format = RGBA8; };
sampler2D LookupSampler { Texture = Lookup; };
texture2D Depth : DEPTH;
sampler2D DepthSampler { Texture = Depth; };
void ContractVS(uint id : SV_VertexID, out float4 position : SV_Position, out float2 uv : TEXCOORD) {
    uv = float2((id << 1) & 2, id & 2);
    position = float4(uv * float2(2.0, -2.0) + float2(-1.0, 1.0), 0.0, 1.0);
}
float4 ContractPS(float4 position : SV_Position, float2 uv : TEXCOORD) : SV_Target {
    return tex2D(LookupSampler, uv) * Amount + tex2D(DepthSampler, uv) * 0.01;
}
technique CompilerContract { pass { VertexShader = ContractVS; PixelShader = ContractPS; } }
`;

// Exercise the subprocess protocol used by live shaders. Compilation is CPU-only;
// this does not load the presentation library or create a graphics device.
export function verifyReShadeCompiler(compiler) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-fx-contract-"));
  const input = path.join(directory, "effect.fx"), prepared = path.join(directory, "effect.prepared.fx");
  const output = path.join(directory, "compiled"), env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith("DYLD_") || name.startsWith("RESHADE_")) delete env[name];
  const invoke = args => execFileSync(compiler, args, { env, timeout: 30000, maxBuffer: 1 << 20 });
  const fail = detail => { throw new Error(`The ReShade compiler output is incomplete: ${detail}`); };
  const metadata = name => {
    const file = path.join(output, name);
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) fail(`${name} is required.`);
    try { return JSON.parse(fs.readFileSync(file, "utf8")); }
    catch { return fail(`${name} must contain valid JSON.`); }
  };
  try {
    fs.writeFileSync(input, source);
    invoke(["--prepare", input, prepared]);
    if (!fs.statSync(prepared, { throwIfNoEntry: false })?.isFile() || !fs.statSync(prepared).size)
      fail("The prepared effect is required.");
    invoke([prepared, output]);
    const textures = metadata("textures.json"), uniforms = metadata("uniforms.json"), requirements = metadata("requirements.json");
    if (!Array.isArray(textures) || textures.length !== 1 || textures[0] !== "lookup.png")
      fail("Image texture sources must match the compiled effect.");
    const amount = Array.isArray(uniforms) && uniforms.find(row => row.name === "V__Amount");
    if (!amount || amount.label !== "Blend amount" || amount.type !== "float" ||
        amount.default?.length !== 1 || amount.default[0] !== 0.5 || amount.min !== 0 || amount.max !== 1 || amount.step !== 0.25)
      fail("Shader parameters must include their labels, defaults and ranges.");
    if (!requirements || requirements.depth !== true || requirements.motion !== false ||
        requirements.techniques?.CompilerContract?.depth !== true || requirements.techniques.CompilerContract.motion !== false)
      fail("Shader input requirements must describe the selected technique.");
    const shaders = fs.readdirSync(output).filter(name => /\.(glsl|metal)$/.test(name));
    if (!shaders.some(name => name.endsWith(".glsl")) || !shaders.some(name => name.endsWith(".metal")) ||
        shaders.some(name => fs.statSync(path.join(output, name)).size === 0))
      fail("GLSL and Metal shader outputs are required.");
    return { textures, uniforms, requirements, shaders };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
