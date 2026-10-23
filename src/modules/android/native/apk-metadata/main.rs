use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use aim_apps::apk::{Apk, Resources, ATTR_THEME};
use aim_apps::cg::{Canvas, Rect};
use aim_apps::drawable::Drawer;
use aim_apps::res::{Element, Value};
use serde_json::{json, Value as Json};

fn full_name(package: &str, name: &str) -> String {
    if name.starts_with('.') { format!("{package}{name}") }
    else if name.contains('.') { name.to_owned() }
    else { format!("{package}.{name}") }
}

fn text(value: Option<&Value>) -> Option<&str> {
    match value { Some(Value::String(s)) => Some(s), _ => None }
}

fn integer(res: &Resources, element: &Element, name: &str) -> Option<i32> {
    match res.resolve(element.named(name)?).map(|v| v.0) {
        Some(Value::Int(value)) => Some(value), _ => None,
    }
}

fn extract(request: &Json) -> Result<Json, String> {
    let inputs = request.get("sourceApks").or_else(|| request.get("sources")).and_then(Json::as_array).ok_or("Expected sourceApks array")?;
    if inputs.is_empty() || inputs.len() > 1024 { return Err("Expected 1 to 1024 package sources".into()); }
    let paths: Vec<PathBuf> = inputs.iter().map(|p| p.as_str().map(PathBuf::from).ok_or("Package source must be a path".to_owned())).collect::<Result<_,_>>()?;
    if paths.iter().any(|p| !p.is_absolute()) {return Err("Package sources must be absolute paths".into());}
    let locale = request.get("locale").and_then(Json::as_str).unwrap_or("en-US");
    let output = Path::new(request.get("outputDirectory").and_then(Json::as_str).ok_or("Expected private outputDirectory")?);
    if !output.is_absolute() || !output.is_dir() || fs::symlink_metadata(output).map_err(|e|e.to_string())?.file_type().is_symlink() { return Err("Output directory must be an existing absolute directory".into()); }
    let output = fs::canonicalize(output).map_err(|e|e.to_string())?;
    // The complete upstream parser supplies resource resolution and drawing.
    let apk = open_sources(&paths, locale)?;
    let manifest = apk.manifest().map_err(|e| e.to_string())?;
    let package = text(manifest.named("package")).ok_or("Package manifest has no package name")?;
    let application = manifest.children.iter().find(|e| e.name == "application");
    let apps = aim_apps::app::read(&apk, None, None).map_err(|e|e.to_string())?;
    let chosen = apps.first();
    let theme = chosen.map(|a|a.theme).unwrap_or_else(||match application.and_then(|e|e.attr(ATTR_THEME)) {Some(Value::Ref(id))=>*id,_=>0});
    let resources = Resources { app: &apk, framework: None, theme, night: false };
    let label = chosen.map(|a|a.label.clone()).or_else(||application.and_then(|e|e.named("label")).and_then(|v|resources.string(v))).unwrap_or_else(||package.to_owned());
    let mut windows = BTreeMap::new();
    if let Some(application) = application {
        for activity in application.children.iter().filter(|e|e.name=="activity" || e.name=="activity-alias") {
            let Some(name) = text(activity.named("name")) else {continue};
            let orientation = integer(&resources,activity,"screenOrientation").or_else(|| {
                if activity.name != "activity-alias" {return None;}
                let target = full_name(package,text(activity.named("targetActivity"))?);
                let declaration = application.children.iter().find(|e|e.name=="activity" && text(e.named("name")).is_some_and(|name|full_name(package,name)==target))?;
                integer(&resources,declaration,"screenOrientation")
            });
            let landscape = match orientation {Some(0|6|8|11)=>Some(true),Some(1|7|9|12)=>Some(false),_=>None};
            windows.insert(full_name(package,name),json!({"landscape":landscape}));
        }
    }
    let icon = chosen.and_then(|a|a.icon.as_ref()).or_else(||application.and_then(|e|e.named("icon")));
    let mut icon_file = None;
    let mut diagnostic = None;
    if let Some(icon) = icon {
        let canvas = Canvas::new(256);
        // Adaptive layers use a 108 dp canvas around Android's 72 dp visible
        // viewport. Draw the overscan outside the bitmap, then apply the
        // launcher's own Dock silhouette once. Legacy drawables use 48 dp.
        let adaptive = matches!(aim_apps::icon::Icon::of(&resources,icon),Some(aim_apps::icon::Icon::Adaptive {..}));
        let (dp,bounds) = if adaptive {(256.0 / 72.0,Rect::new(-64.0,-64.0,384.0,384.0))}
            else {(256.0 / 48.0,Rect::new(0.0,0.0,256.0,256.0))};
        let drawer = Drawer { res: &resources, canvas: &canvas, dp };
        if drawer.draw(icon,bounds) {
            if let Some(bytes) = canvas.image().png() {
                if bytes.len() > 8*1024*1024 {return Err("Package icon exceeds its size limit".into());}
                let file = output.join("icon.png");
                let mut stream = OpenOptions::new().write(true).create_new(true).mode(0o600).open(&file).map_err(|e|e.to_string())?;
                stream.write_all(&bytes).map_err(|e|e.to_string())?;
                icon_file = Some(file);
            } else {diagnostic=Some("The package icon could not be encoded");}
        } else {diagnostic=Some("The package icon resource could not be rendered");}
    }
    let mut result=json!({"schemaVersion":1,"packageName":package,"label":label.trim(),"activityWindows":windows,"iconFile":icon_file,"icon":icon_file.is_some(),"locale":locale});
    if let Some(message)=diagnostic {result["iconDiagnostic"]=json!(message);}
    Ok(result)
}

fn open_sources(paths:&[PathBuf], locale:&str)->Result<Apk,String> {
    Apk::open_many(paths,locale).map_err(|e|e.to_string())
}

fn main() {
    let mut bytes=Vec::new();
    let result=(|| {
        std::io::stdin().take(1024*1024+1).read_to_end(&mut bytes).map_err(|e|e.to_string())?;
        if bytes.len()>1024*1024 {return Err("Package metadata request exceeds its size limit".to_owned());}
        let request:Json=serde_json::from_slice(&bytes).map_err(|e|e.to_string())?;
        extract(&request)
    })();
    match result {
        Ok(value)=>{
            let encoded=value.to_string();
            if encoded.len()>1024*1024 {eprintln!("APK metadata response exceeds its size limit");std::process::exit(1);}
            println!("{encoded}");
        }
        Err(error)=>{eprintln!("APK metadata: {}",error.chars().take(4096).collect::<String>());std::process::exit(1);}
    }
}
