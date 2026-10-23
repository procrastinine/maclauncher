//! Offline asset/ABI inventory. This never creates a window, loads a DLL,
//! writes included files, compiles GML, or invokes game initialization.
use gm8exe::{asset::{CodeAction, extension::{FileKind, FunctionValueKind, CallingConvention}}, GameAssets};
use gml_parser::{lexer::Lexer, token::{Token, Separator}};
use serde_json::{json, Value};

const MAX_DECLARATIONS: usize = 4096;
fn string(bytes: &[u8]) -> String { String::from_utf8_lossy(bytes).into_owned() }
fn value_kind(kind: FunctionValueKind) -> &'static str {
    match kind { FunctionValueKind::GMString => "string", FunctionValueKind::GMReal => "real" }
}

fn scan(source: &[u8], location: &str, calls: &mut Vec<Value>) -> Result<(), String> {
    let mut tokens = Lexer::new(source).peekable();
    while let Some(token) = tokens.next() {
        let Token::Identifier(name) = token else { continue };
        if name != b"external_define" && !name.starts_with(b"external_define") { continue }
        if tokens.next() != Some(Token::Separator(Separator::ParenLeft)) { continue }
        if calls.len() >= MAX_DECLARATIONS { return Err("External definitions exceed the inspection limit".into()) }
        let mut parameters: Vec<Vec<Token<'_>>> = vec![Vec::new()];
        let mut depth = 1;
        for token in tokens.by_ref() {
            match token {
                Token::Separator(Separator::ParenLeft) => depth += 1,
                Token::Separator(Separator::ParenRight) => { depth -= 1; if depth == 0 { break } },
                Token::Separator(Separator::Comma) if depth == 1 => { parameters.push(Vec::new()); continue },
                _ => (),
            }
            parameters.last_mut().unwrap().push(token);
        }
        let literal = |index: usize| -> Option<Value> {
            match parameters.get(index)?.as_slice() {
                [Token::String(value)] => Some(json!(string(value))),
                [Token::Real(value)] => Some(json!(value)),
                [Token::Identifier(value)] => Some(json!({"identifier":string(value)})),
                _ => None,
            }
        };
        calls.push(json!({"function":string(name),"location":location,
            "library":literal(0),"symbol":literal(1),"callingConvention":literal(2),
            "returnType":literal(3),"argumentCount":literal(4),
            "argumentTypes":(5..parameters.len()).map(literal).collect::<Vec<_>>(),
            "runtimeDefinitionRequired":true}));
    }
    Ok(())
}
fn actions(items: &[CodeAction], location: &str, calls: &mut Vec<Value>) -> Result<(), String> {
    for action in items {
        scan(action.fn_code.0.as_ref(), location, calls)?;
        for value in &action.param_strings { scan(value.0.as_ref(), location, calls)?; }
        if action.fn_name.0.as_ref() == b"external_define" {
            calls.push(json!({"function":"external_define","location":location,"library":null,
                "symbol":null,"runtimeDefinitionRequired":true}));
        }
    }
    Ok(())
}

pub fn print_report(assets: &GameAssets) -> Result<(), String> {
    let mut extensions = Vec::new();
    let mut calls = Vec::new();
    for extension in &assets.extensions {
        if extensions.len() >= MAX_DECLARATIONS { return Err("Extensions exceed the inspection limit".into()) }
        let mut files = Vec::new();
        for file in &extension.files {
            let kind = match file.kind { FileKind::DynamicLibrary => "dll", FileKind::GmlScript => "gml", FileKind::ActionLibrary => "action-library", FileKind::Other => "other" };
            let functions: Vec<Value> = file.functions.iter().map(|function| json!({
                "name":string(function.name.0.as_ref()), "symbol":string(function.external_name.0.as_ref()),
                "callingConvention":match function.convention { CallingConvention::Stdcall => "stdcall", CallingConvention::Cdecl => "cdecl", CallingConvention::Gml => "gml", CallingConvention::Unknown => "unknown" },
                "argumentCount":function.arg_count,
                "argumentTypes":function.arg_types.iter().take(function.arg_count.max(0).min(17) as usize).map(|kind|value_kind(*kind)).collect::<Vec<_>>(),
                "returnType":value_kind(function.return_type)
            })).collect();
            files.push(json!({"name":string(file.name.0.as_ref()),"kind":kind,"functions":functions,
                "initializer":string(file.initializer.0.as_ref()),"finalizer":string(file.finalizer.0.as_ref())}));
            if file.kind == FileKind::GmlScript { scan(&file.contents, &format!("extension:{}:{}",string(extension.name.0.as_ref()),string(file.name.0.as_ref())), &mut calls)?; }
        }
        extensions.push(json!({"name":string(extension.name.0.as_ref()),"files":files}));
    }
    for script in assets.scripts.iter().flatten() { scan(script.source.0.as_ref(), &format!("script:{}", string(script.name.0.as_ref())), &mut calls)?; }
    for trigger in assets.triggers.iter().flatten() { scan(trigger.condition.0.as_ref(), &format!("trigger:{}", string(trigger.name.0.as_ref())), &mut calls)?; }
    for object in assets.objects.iter().flatten() {
        for (kind, events) in object.events.iter().enumerate() {
            for (number, code) in events { actions(code, &format!("object:{}:{kind}:{number}",string(object.name.0.as_ref())), &mut calls)?; }
        }
    }
    for timeline in assets.timelines.iter().flatten() {
        for (moment, code) in &timeline.moments { actions(code, &format!("timeline:{}:{moment}",string(timeline.name.0.as_ref())), &mut calls)?; }
    }
    for room in assets.rooms.iter().flatten() {
        let location = format!("room:{}",string(room.name.0.as_ref()));
        scan(room.creation_code.0.as_ref(), &location, &mut calls)?;
        for instance in &room.instances { scan(instance.creation_code.0.as_ref(), &format!("{location}:instance:{}",instance.id), &mut calls)?; }
    }
    for (index, source) in assets.library_init_strings.iter().enumerate() { scan(source.0.as_ref(), &format!("library-init:{index}"), &mut calls)?; }
    let report = json!({"schemaVersion":1,"engine":"gamemaker-classic","assetsVerified":true,
        "version":match assets.version {gm8exe::GameVersion::GameMaker8_0=>"8.0",gm8exe::GameVersion::GameMaker8_1=>"8.1"},
        "extensions":extensions,"externalDefinitions":calls,"windowsExtensionHost":false,
        "nativeExtensionProfiles":crate::game::external::native_extension_profiles(),
        "inventory":{"scripts":assets.scripts.iter().flatten().count(),"objects":assets.objects.iter().flatten().count(),
            "rooms":assets.rooms.iter().flatten().count(),"sounds":assets.sounds.iter().flatten().count()}});
    println!("{}", serde_json::to_string(&report).map_err(|error|error.to_string())?);
    Ok(())
}
