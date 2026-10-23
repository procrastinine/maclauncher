function applyHighscoreOverlay(inputs) {
  const file = "gm8emulator/src/gml/kernel.rs";
  const replace = (name, receiver, count, body) => {
    const original = `    pub fn ${name}(${receiver}, _args: &[Value]) -> gml::Result<Value> {\n        // Expected arg count: ${count}\n        unimplemented!("Called unimplemented kernel function ${name}")\n    }`;
    if (!inputs[file].includes(original)) throw Error(`Pinned OpenGMK ${name} patch context changed.`);
    inputs[file] = inputs[file].replace(original, `    pub fn ${name}(${receiver}, args: &[Value]) -> gml::Result<Value> {\n${body}\n    }`);
  };
  const error = name => `.map_err(|error| gml::runtime::Error::FunctionError("${name}".into(), error))?`;
  replace("highscore_clear", "&mut self", 0, `        expect_args!(args, [])?;\n        crate::maclauncher_highscore::clear()${error("highscore_clear")};\n        Ok(Default::default())`);
  replace("highscore_add", "&mut self", 2, `        let (name, score) = expect_args!(args, [bytes, real])?;\n        crate::maclauncher_highscore::add(name.as_ref(), score.into())${error("highscore_add")};\n        Ok(Default::default())`);
  replace("highscore_value", "&self", 1, `        let place = expect_args!(args, [int])?;\n        Ok(crate::maclauncher_highscore::value(place)${error("highscore_value")}.into())`);
  replace("highscore_name", "&self", 1, `        let place = expect_args!(args, [int])?;\n        Ok(Value::Str(crate::maclauncher_highscore::name(place)${error("highscore_name")}.into()))`);
  inputs["gm8emulator/src/main.rs"] = inputs["gm8emulator/src/main.rs"].replace("mod maclauncher_inspect;", "mod maclauncher_highscore;\nmod maclauncher_inspect;");
}
module.exports = { applyHighscoreOverlay };
