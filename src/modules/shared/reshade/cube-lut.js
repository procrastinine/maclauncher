const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const Writable = require("../writable-input");
const VERSION = 1, MAX_SOURCE = 8 * 1024 * 1024, MAX_HOOK = 16 * 1024 * 1024;
const traits = Object.freeze({category: "color", rgbCompatible: true, geometryKnown: true});
const cache = new Map();
const number = value => /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value) && Number.isFinite(Number(value)) ? Number(value) : NaN;
const vector = values => `vec3(${values.map(value => Number(value).toPrecision(9)).join(",")})`;
function parse(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_SOURCE || text.includes("\0")) throw new Error("Choose a CUBE LUT of at most 8 MiB.");
  const headers = new Map(), rows = [];let data = false;
  for (const [index, original] of text.replace(/^\uFEFF/, "").split(/\r?\n/).entries()) {
    const line = original.split("#", 1)[0].trim();if (!line) continue;
    const parts = line.split(/\s+/), key = parts[0].toUpperCase();
    const fail = message => {throw new Error(`CUBE LUT line ${index + 1}: ${message}`);};
    if (/^[A-Z_]/.test(key)) {
      if (data) fail("headers must precede LUT entries.");
      if (key === "TITLE") continue;
      const count = ["LUT_1D_SIZE", "LUT_3D_SIZE"].includes(key) ? 1 : ["DOMAIN_MIN", "DOMAIN_MAX"].includes(key) ? 3
        : ["LUT_1D_INPUT_RANGE", "LUT_3D_INPUT_RANGE"].includes(key) ? 2 : 0;
      if (!count) fail("unsupported LUT header.");
      const values = parts.slice(1).map(number);
      if (headers.has(key) || values.length !== count || values.some(value => !Number.isFinite(value) || !Number.isFinite(Math.fround(value)))) fail("invalid or repeated LUT header.");
      headers.set(key, values);continue;
    }
    data = true;
    const values = parts.map(number);
    if (values.length !== 3 || values.some(value => !Number.isFinite(value) || Math.abs(value) > 65504))
      fail("entries need three finite values in the half-float texture range.");
    rows.push(values);
  }
  const size1d = headers.get("LUT_1D_SIZE")?.[0] || 0, size3d = headers.get("LUT_3D_SIZE")?.[0] || 0;
  if (!size1d && !size3d || size1d && (!Number.isInteger(size1d) || size1d < 2 || size1d > 65536) ||
      size3d && (!Number.isInteger(size3d) || size3d < 2 || size3d > 80)) throw new Error("Choose a supported 1D LUT or a 3D LUT fitting the shader texture budget.");
  if (size1d && size3d && (headers.has("DOMAIN_MIN") || headers.has("DOMAIN_MAX")))
    throw new Error("Combined shaper and 3D LUTs require separate LUT_1D_INPUT_RANGE and LUT_3D_INPUT_RANGE headers.");
  if (rows.length !== size1d + size3d ** 3) throw new Error("The CUBE LUT entry count does not match its dimensions.");
  const minimum = headers.get("DOMAIN_MIN") || [0, 0, 0], maximum = headers.get("DOMAIN_MAX") || [1, 1, 1];
  if (minimum.some((value, i) => !(Math.fround(maximum[i]) > Math.fround(value)))) throw new Error("CUBE LUT domain maxima must exceed their minima in shader precision.");
  function domain(key, present) {
    const range = headers.get(key);
    if (range && !present) throw new Error("A LUT input range needs its corresponding table.");
    if (range && !(Math.fround(range[1]) > Math.fround(range[0]))) throw new Error("LUT input range maxima must exceed their minima in shader precision.");
    return range ? {minimum: [range[0], range[0], range[0]], maximum: [range[1], range[1], range[1]]} : {minimum, maximum};
  }
  return {size1d, size3d, domain1d: domain("LUT_1D_INPUT_RANGE", size1d), domain3d: domain("LUT_3D_INPUT_RANGE", size3d), rows};
}
function texture(name, rows, sizes) {
  const count = sizes.reduce((a, b) => a * b, 1), bytes = Buffer.alloc(count * 16);
  for (let i = 0; i < count; i++) {
    const row = rows[Math.min(i, rows.length - 1)];
    for (let channel = 0; channel < 3; channel++) bytes.writeFloatLE(row[channel], i * 16 + channel * 4);
    bytes.writeFloatLE(1, i * 16 + 12);
  }
  return `//!TEXTURE ${name}\n//!SIZE ${sizes.join(" ")}\n//!FORMAT rgba16f\n//!FILTER LINEAR\n//!BORDER CLAMP\n${bytes.toString("hex")}\n`;
}
function hook(lut) {
  let source = "// Copyright (c) MacLauncher contributors. MIT license.\n";
  source += "//!PARAM Strength\n//!DESC LUT strength\n//!TYPE float\n//!MINIMUM 0\n//!MAXIMUM 1\n1\n";
  source += "//!PARAM InputTransfer\n//!DESC LUT input transfer\n//!TYPE ENUM int\nEncoded\nLinear\n";
  source += "//!PARAM OutputTransfer\n//!DESC LUT output transfer\n//!TYPE ENUM int\nEncoded\nLinear\n";
  if (lut.size3d) source += "//!PARAM Interpolation\n//!DESC LUT interpolation\n//!TYPE ENUM int\nTrilinear\nTetrahedral\n";
  const width = Math.min(lut.size1d, 1024), height = lut.size1d ? Math.ceil(lut.size1d / width) : 0;
  if (lut.size1d) source += texture("MLShaper", lut.rows.slice(0, lut.size1d), [width, height]);
  if (lut.size3d) source += texture("MLCube", lut.rows.slice(lut.size1d), [lut.size3d, lut.size3d, lut.size3d]);
  source += "//!HOOK MAIN\n//!DESC Color LUT\n//!BIND HOOKED\n";
  if (lut.size1d) source += "//!BIND MLShaper\n";
  if (lut.size3d) source += "//!BIND MLCube\n";
  source += `vec3 mlDecode(vec3 c) {return mix(c/12.92,pow(max((c+0.055)/1.055,vec3(0)),vec3(2.4)),greaterThan(c,vec3(0.04045)));}
vec3 mlEncode(vec3 c) {return mix(12.92*c,1.055*pow(max(c,vec3(0)),vec3(1.0/2.4))-0.055,greaterThan(c,vec3(0.0031308)));}
`;
  if (lut.size1d) source += `vec3 mlShaperEntry(float index) {return texture(MLShaper,(vec2(mod(index,${width}.0),floor(index/${width}.0))+0.5)/vec2(${width}.0,${height}.0)).rgb;}
vec3 mlShape(vec3 c) {
  vec3 p=clamp((c-${vector(lut.domain1d.minimum)})/(${vector(lut.domain1d.maximum)}-${vector(lut.domain1d.minimum)}),0.0,1.0)*${lut.size1d - 1}.0;
  vec3 lo=floor(p),hi=min(lo+1.0,vec3(${lut.size1d - 1}.0));
  return vec3(mix(mlShaperEntry(lo.r).r,mlShaperEntry(hi.r).r,p.r-lo.r),mix(mlShaperEntry(lo.g).g,mlShaperEntry(hi.g).g,p.g-lo.g),mix(mlShaperEntry(lo.b).b,mlShaperEntry(hi.b).b,p.b-lo.b));
}
`;
  if (lut.size3d) source += `vec3 mlCubeEntry(vec3 p) {return texture(MLCube,(p+0.5)/${lut.size3d}.0).rgb;}
vec3 mlLookup(vec3 c) {
  vec3 p=clamp((c-${vector(lut.domain3d.minimum)})/(${vector(lut.domain3d.maximum)}-${vector(lut.domain3d.minimum)}),0.0,1.0)*${lut.size3d - 1}.0;
  if(Interpolation==0)return texture(MLCube,(p+0.5)/${lut.size3d}.0).rgb;
  vec3 lo=min(floor(p),vec3(${lut.size3d - 2}.0)),f=p-lo;
  vec3 a=mlCubeEntry(lo),d=mlCubeEntry(lo+vec3(1)),b,c1;
  if(f.r>=f.g){if(f.g>=f.b){b=mlCubeEntry(lo+vec3(1,0,0));c1=mlCubeEntry(lo+vec3(1,1,0));return a+f.r*(b-a)+f.g*(c1-b)+f.b*(d-c1);}
    if(f.r>=f.b){b=mlCubeEntry(lo+vec3(1,0,0));c1=mlCubeEntry(lo+vec3(1,0,1));return a+f.r*(b-a)+f.b*(c1-b)+f.g*(d-c1);}
    b=mlCubeEntry(lo+vec3(0,0,1));c1=mlCubeEntry(lo+vec3(1,0,1));return a+f.b*(b-a)+f.r*(c1-b)+f.g*(d-c1);}
  if(f.r>=f.b){b=mlCubeEntry(lo+vec3(0,1,0));c1=mlCubeEntry(lo+vec3(1,1,0));return a+f.g*(b-a)+f.r*(c1-b)+f.b*(d-c1);}
  if(f.g>=f.b){b=mlCubeEntry(lo+vec3(0,1,0));c1=mlCubeEntry(lo+vec3(0,1,1));return a+f.g*(b-a)+f.b*(c1-b)+f.r*(d-c1);}
  b=mlCubeEntry(lo+vec3(0,0,1));c1=mlCubeEntry(lo+vec3(0,1,1));return a+f.b*(b-a)+f.g*(c1-b)+f.r*(d-c1);
}
`;
  source += `vec4 hook(){vec4 original=HOOKED_tex(HOOKED_pos);vec3 c=original.a>0.0?original.rgb/original.a:vec3(0);if(InputTransfer==1)c=mlDecode(c);`;
  if (lut.size1d) source += "c=mlShape(c);";
  if (lut.size3d) source += "c=mlLookup(c);";
  source += "if(OutputTransfer==1)c=mlEncode(c);return vec4(mix(original.rgb,c*original.a,Strength),original.a);}\n";
  if (Buffer.byteLength(source) > MAX_HOOK) throw new Error("The LUT textures exceed the prepared shader budget.");
  return source;
}
function prepare(file, userDataDir) {
  if (!path.isAbsolute(userDataDir || "")) throw new Error("LUT preparation requires the application's graphics storage.");
  const input = fs.realpathSync(file), stat = fs.statSync(input), identity = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
  if (!stat.isFile() || stat.size > MAX_SOURCE) throw new Error("Choose a CUBE LUT of at most 8 MiB.");
  const previous = cache.get(input);
  if (previous?.identity === identity) {
    const stored = fs.lstatSync(previous.file, {throwIfNoEntry: false});
    if (stored?.isFile() && !stored.isSymbolicLink() && [stored.ino, stored.size, stored.mtimeMs, stored.ctimeMs].join(":") === previous.outputIdentity) return previous.file;
  }
  const fd = fs.openSync(input, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);let bytes;
  try {
    const before = fs.fstatSync(fd);bytes = fs.readFileSync(fd);const after = fs.fstatSync(fd);
    if (!before.isFile() || before.size !== bytes.length || bytes.length > MAX_SOURCE || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      throw new Error("The LUT changed while being prepared. Try again.");
  } finally {fs.closeSync(fd);}
  const digest = crypto.createHash("sha256").update(String(VERSION)).update(bytes).digest("hex"), output = hook(parse(bytes.toString("utf8")));
  const target = path.join(userDataDir, "graphics", "luts", String(VERSION), digest, "effect.hook");
  Writable.assertOwnDirectory(userDataDir, path.dirname(target));
  const existing = fs.lstatSync(target, {throwIfNoEntry: false});
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink() || existing.size !== Buffer.byteLength(output) || fs.readFileSync(target, "utf8") !== output)
      throw new Error("The prepared LUT changed. Import the source LUT again.");
  } else {Writable.atomicWrite(target, output, {root: userDataDir});fs.chmodSync(target, 0o444);}
  const stored = fs.lstatSync(target);
  if (cache.size >= 64) cache.delete(cache.keys().next().value);
  cache.set(input, {identity, file: target, outputIdentity: [stored.ino, stored.size, stored.mtimeMs, stored.ctimeMs].join(":")});
  return target;
}
module.exports = {VERSION, MAX_SOURCE, MAX_HOOK, traits, parse, hook, prepare};
