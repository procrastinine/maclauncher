function applyWindowOverlay(inputs) {
  const file = "gm8emulator/src/gml/kernel.rs";
  for (const [name, index] of [["display_get_width", 0], ["display_get_height", 1]]) {
    const before = `    pub fn ${name}(&self, args: &[Value]) -> gml::Result<Value> {\n        expect_args!(args, [])?;`;
    if (!inputs[file].includes(before)) throw Error(`Pinned OpenGMK ${name} patch context changed.`);
    inputs[file] = inputs[file].replace(before, `${before}\n        #[cfg(target_os = "macos")]\n        if self.play_type == PlayType::Normal {\n            return Ok(crate::maclauncher_window::display_size(self.window.nswindow()).${index}.into());\n        }`);
  }
  const before = `    pub fn window_center(&mut self, _args: &[Value]) -> gml::Result<Value> {\n        // TODO: make this do something!\n        Ok(Default::default())\n    }`;
  if (!inputs[file].includes(before)) throw Error("Pinned OpenGMK window_center patch context changed.");
  inputs[file] = inputs[file].replace(before, `    pub fn window_center(&mut self, args: &[Value]) -> gml::Result<Value> {\n        expect_args!(args, [])?;\n        #[cfg(target_os = "macos")]\n        if self.play_type == PlayType::Normal {\n            self.window_offset_spoof = crate::maclauncher_window::center(self.window.nswindow());\n        }\n        Ok(Default::default())\n    }`);
  const position = `    pub fn window_set_position(&mut self, args: &[Value]) -> gml::Result<Value> {\n        let (x, y) = expect_args!(args, [int, int])?;\n        self.window_offset_spoof = (x, y);`;
  if (!inputs[file].includes(position)) throw Error("Pinned OpenGMK window_set_position patch context changed.");
  inputs[file] = inputs[file].replace(position, `${position}\n        #[cfg(target_os = "macos")]\n        if self.play_type == PlayType::Normal {\n            self.window_offset_spoof = crate::maclauncher_window::set_position(self.window.nswindow(), x, y);\n        }`);
  for (const [name, index] of [["window_get_x", 0], ["window_get_y", 1]]) {
    const context = `    pub fn ${name}(&self, args: &[Value]) -> gml::Result<Value> {\n        expect_args!(args, [])?;`;
    if (!inputs[file].includes(context)) throw Error(`Pinned OpenGMK ${name} patch context changed.`);
    inputs[file] = inputs[file].replace(context, `${context}\n        #[cfg(target_os = "macos")]\n        if self.play_type == PlayType::Normal {\n            return Ok(crate::maclauncher_window::position(self.window.nswindow()).${index}.into());\n        }`);
  }
  const gameFile = "gm8emulator/src/game.rs";
  const firstResize = "            self.unscaled_width = width;\n            self.unscaled_height = height;";
  if (!inputs[gameFile].includes(firstResize)) throw Error("Pinned OpenGMK first room resize context changed.");
  inputs[gameFile] = inputs[gameFile].replace(firstResize, `            #[cfg(target_os = "macos")]\n            let first_resize = self.unscaled_width == 0 && self.unscaled_height == 0;\n${firstResize}`);
  const resize = "                self.window.set_size((width as _, height as _));";
  if (!inputs[gameFile].includes(resize)) throw Error("Pinned OpenGMK native room resize context changed.");
  inputs[gameFile] = inputs[gameFile].replace(resize, `${resize}\n                #[cfg(target_os = "macos")]\n                if first_resize && self.play_type == PlayType::Normal {\n                    self.window_offset_spoof = crate::maclauncher_window::center(self.window.nswindow());\n                }`);
  inputs["gm8emulator/src/main.rs"] = inputs["gm8emulator/src/main.rs"].replace("mod maclauncher_inspect;", "#[cfg(target_os = \"macos\")]\nmod maclauncher_window;\nmod maclauncher_inspect;");
}
module.exports = { applyWindowOverlay };
