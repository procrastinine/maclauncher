// Copyright (c) MacLauncher contributors. MIT license.
use librashader_common::{FilterMode, ImageFormat, WrapMode};
use librashader_pack::ShaderPresetPack;
use librashader_presets::{context::VideoDriver, PassConfig, PassMeta, Scale2D, ScaleFactor, ScaleType, Scaling, ShaderFeatures, ShaderPreset};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, error::Error, fmt::Write, fs, path::Path};
type Result<T> = std::result::Result<T, Box<dyn Error + Send + Sync>>;
fn quoted(value: &str) -> Result<String> {
    if value.contains(['"', '\n', '\r']) { return Err("Shader metadata contains an invalid quoted value".into()); }
    Ok(format!("\"{value}\""))
}
fn wrap(value: WrapMode) -> &'static str { match value {
    WrapMode::ClampToBorder => "clamp_to_border", WrapMode::ClampToEdge => "clamp_to_edge",
    WrapMode::Repeat => "repeat", WrapMode::MirroredRepeat => "mirrored_repeat",
}}
fn scale(value: ScaleType) -> &'static str { match value {
    ScaleType::Input => "source", ScaleType::Absolute => "absolute", ScaleType::Viewport => "viewport", ScaleType::Original => "original",
}}
fn format_name(value: ImageFormat) -> Result<String> {
    // Derive the spelling by round-tripping through the upstream parser. This
    // keeps format interpretation with the same owner as runtime compilation.
    let debug = format!("{value:?}");
    for suffix in ["UnormPack32", "UintPack32", "Unorm", "Uint", "Sint", "Sfloat", "Srgb"] {
        if let Some(prefix) = debug.strip_suffix(suffix) {
            let text = format!("{}_{}", prefix.to_uppercase(), suffix.replace("Pack32", "_PACK32").to_uppercase());
            if text.parse::<ImageFormat>().unwrap() == value { return Ok(text); }
        }
    }
    Err("Unrecognized upstream shader image format".into())
}
fn load(path: &Path) -> Result<ShaderPresetPack> {
    let preset = if path.extension().and_then(|v|v.to_str()) == Some("slang") {
        // A standalone pass has the upstream single-pass defaults; no shader
        // text is parsed or rewritten to infer preset behavior.
        let source = fs::canonicalize(path)?;
        let axis=||Scaling {scale_type:ScaleType::Input,factor:ScaleFactor::Float(1.0)};
        ShaderPreset {pass_count:1,passes:vec![PassConfig {path:source,meta:PassMeta {
            id:0,alias:None,filter:FilterMode::Nearest,wrap_mode:WrapMode::ClampToBorder,
            frame_count_mod:0,srgb_framebuffer:false,float_framebuffer:false,mipmap_input:false,
            scaling:Scale2D {valid:false,x:axis(),y:axis()},
        }}],textures:vec![],parameters:vec![],features:ShaderFeatures::empty()}
    } else { ShaderPreset::try_parse_with_driver_context(path, ShaderFeatures::empty(), VideoDriver::Metal)? };
    ShaderPresetPack::load_from_preset::<Box<dyn Error + Send + Sync>>(preset)
}
fn uses_subframes(source: &str) -> bool {
    let mut clean=String::with_capacity(source.len());let mut chars=source.chars().peekable();
    while let Some(c)=chars.next(){
        if c=='/' && chars.peek()==Some(&'/'){chars.next();for next in chars.by_ref(){if next=='\n'{clean.push('\n');break;}}}
        else if c=='/' && chars.peek()==Some(&'*'){chars.next();let mut previous=' ';for next in chars.by_ref(){if previous=='*'&&next=='/'{break;}previous=next;}clean.push(' ');}
        else{clean.push(c);}
    }
    // A standard uniform declaration alone does not put an ordinary shader
    // in the refresh domain. Require a use beyond its declaration in a typed
    // stage; never count the duplicate vertex/fragment declarations together.
    ["TotalSubFrames","CurrentSubFrame"].iter().any(|name|clean.split(|c:char|!c.is_ascii_alphanumeric()&&c!='_').filter(|token|token==name).count()>1)
}
fn metadata(pack: &ShaderPresetPack) -> Value {
    let mut params = BTreeMap::new();
    for pass in &pack.passes { for (name, p) in &pass.data.parameters {
        let initial = pack.parameters.iter().find(|v|v.name == *name).map_or(p.initial, |v|v.value);
        params.insert(name.to_string(), json!({"name":name.as_str(),"label":p.description,"type":"float","default":[initial],"min":p.minimum,"max":p.maximum,"step":p.step}));
    }}
    let subframes=pack.passes.iter().any(|pass|uses_subframes(&pass.data.vertex)||uses_subframes(&pass.data.fragment));
    json!({"schema":1,"format":"slangp","parameters":params.into_values().collect::<Vec<_>>(),"passes":pack.pass_count,"displaySubframes":subframes,"upstream":{"version":"0.12.1","commit":"07ac790cdb9826f37cf8e1daf5011f03e3c4daa7"}})
}
fn write_file(root: &Path, name: &str, bytes: &[u8], files: &mut Vec<Value>) -> Result<()> {
    fs::write(root.join(name), bytes)?;
    files.push(json!({"path":name,"size":bytes.len(),"sha256":format!("{:x}",Sha256::digest(bytes))})); Ok(())
}
fn prepare(pack: ShaderPresetPack, output: &Path) -> Result<Value> {
    fs::create_dir(output)?;
    let mut info=metadata(&pack); let mut files=Vec::new(); let mut preset=String::new();
    writeln!(preset,"shaders = {}",pack.pass_count)?;
    for (i, pass) in pack.passes.iter().enumerate() {
        let m=&pass.meta;let source=&pass.data;let name=format!("pass-{i}.slang");
        writeln!(preset,"shader{i} = {name}")?;
        writeln!(preset,"filter_linear{i} = {}\nwrap_mode{i} = {}\nframe_count_mod{i} = {}\nsrgb_framebuffer{i} = {}\nfloat_framebuffer{i} = {}\nmipmap_input{i} = {}",
            m.filter == FilterMode::Linear,wrap(m.wrap_mode),m.frame_count_mod,m.srgb_framebuffer,m.float_framebuffer,m.mipmap_input)?;
        if let Some(alias)=&m.alias {writeln!(preset,"alias{i} = {}",quoted(alias)?)?;}
        if m.scaling.valid {writeln!(preset,"scale_type_x{i} = {}\nscale_type_y{i} = {}\nscale_x{i} = {}\nscale_y{i} = {}",
            scale(m.scaling.x.scale_type),scale(m.scaling.y.scale_type),f32::from(m.scaling.x.factor),f32::from(m.scaling.y.factor))?;}
        // The upstream preprocessor requires one version header before its
        // stage markers. Both typed stages already carry that same header.
        let (version,vertex)=source.vertex.split_once('\n').ok_or("Missing vertex version header")?;
        let (fragment_version,fragment)=source.fragment.split_once('\n').ok_or("Missing fragment version header")?;
        if !version.starts_with("#version ")||version!=fragment_version {return Err("Inconsistent upstream stage version headers".into());}
        let mut shader=format!("{version}\n");
        if let Some(alias)=&source.name {writeln!(shader,"#pragma name {alias}")?;}
        if source.format != ImageFormat::Unknown {writeln!(shader,"#pragma format {}",format_name(source.format)?)?;}
        let mut parameters=source.parameters.values().collect::<Vec<_>>();parameters.sort_by(|a,b|a.id.cmp(&b.id));
        for p in parameters {writeln!(shader,"#pragma parameter {} {} {} {} {} {}",p.id,quoted(&p.description)?,p.initial,p.minimum,p.maximum,p.step)?;}
        writeln!(shader,"#pragma stage vertex\n{vertex}\n#pragma stage fragment\n{fragment}")?;
        write_file(output,&name,shader.as_bytes(),&mut files)?;
    }
    if !pack.textures.is_empty() {writeln!(preset,"textures = {}",quoted(&pack.textures.iter().map(|t|t.meta.name.as_str()).collect::<Vec<_>>().join(";"))?)?;}
    for (i,t) in pack.textures.into_iter().enumerate() {
        let m=t.meta;let name=format!("lut-{i}.png");let image:Option<image::RgbaImage>=t.data.into();
        let image=image.ok_or("Invalid upstream lookup texture")?;let mut bytes=std::io::Cursor::new(Vec::new());
        image.write_to(&mut bytes,image::ImageFormat::Png)?;write_file(output,&name,bytes.get_ref(),&mut files)?;
        writeln!(preset,"{} = {name}\n{}_linear = {}\n{}_wrap_mode = {}\n{}_mipmap = {}",m.name,m.name,m.filter_mode==FilterMode::Linear,m.name,wrap(m.wrap_mode),m.name,m.mipmap)?;
    }
    if !pack.parameters.is_empty(){writeln!(preset,"parameters = {}",quoted(&pack.parameters.iter().map(|p|p.name.as_str()).collect::<Vec<_>>().join(";"))?)?;}
    for p in pack.parameters {writeln!(preset,"{} = {}",p.name,p.value)?;}
    write_file(output,"effect.slangp",preset.as_bytes(),&mut files)?;
    files.sort_by(|a,b|a["path"].as_str().cmp(&b["path"].as_str()));info["files"]=json!(files);
    fs::write(output.join("metadata.json"),serde_json::to_vec_pretty(&info)?)?;Ok(info)
}
fn main() {let result=(|| -> Result<()> {
    let args=std::env::args().skip(1).collect::<Vec<_>>();
    match args.as_slice() {
        [mode,input] if mode=="--inspect" => println!("{}",metadata(&load(Path::new(input))?)),
        [mode,input,output] if mode=="--prepare" => {let pack=load(Path::new(input))?;println!("{}",prepare(pack,Path::new(output))?);},
        _ => return Err("Usage: retroarch-prepare --inspect PRESET | --prepare PRESET OUTPUT".into()),
    } Ok(())})();if let Err(error)=result {eprintln!("{error}");std::process::exit(1);}}
