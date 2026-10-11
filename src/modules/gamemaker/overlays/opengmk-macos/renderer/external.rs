use super::dll;
mod supersound;

pub struct IpcExternal { function: supersound::Function }
pub struct IpcManager { audio: supersound::Audio }

pub fn extension_profiles() -> serde_json::Value {
    serde_json::json!([{"id":"supersound-string-abi-v1","libraries":["supersound.dll","ssound.dll"],
        "functions":supersound::Function::functions().into_iter().map(|(symbol, _, arguments)|serde_json::json!({
            "symbol":symbol,"argumentCount":arguments,"argumentTypes":vec!["string";arguments],"returnType":"string"
        })).collect::<Vec<_>>()}])
}

impl IpcManager {
    pub fn new() -> Self { Self { audio: supersound::Audio::new() } }
    pub fn define(&self, signature: &dll::ExternalSignature) -> Result<IpcExternal, String> {
        let normalized = signature.dll.replace('\\', "/");
        let library = std::path::Path::new(&normalized).file_name().and_then(|name|name.to_str()).unwrap_or(&normalized);
        if library.eq_ignore_ascii_case("supersound.dll") || library.eq_ignore_ascii_case("ssound.dll") {
            if let Some((function, arguments)) = supersound::Function::from_symbol(&signature.symbol) {
                if signature.type_args.len() == arguments && signature.type_args.iter().all(|kind|matches!(kind, dll::ValueType::Str)) && matches!(signature.type_return, dll::ValueType::Str) {
                    return Ok(IpcExternal { function });
                }
                return Err(format!("Native SuperSound {} requires {} string arguments and a string return value", signature.symbol, arguments))
            }
        }
        Err(format!("Windows extension {} ({}) has no native macOS implementation", signature.dll, signature.symbol))
    }
    pub fn call(&mut self, external: &IpcExternal, args: &[dll::Value]) -> dll::Value {
        self.audio.call(external.function, args)
    }
    pub fn free(&mut self, _external: IpcExternal) {}
}
