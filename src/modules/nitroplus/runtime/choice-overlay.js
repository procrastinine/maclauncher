const fs = require('node:fs');
const path = require('node:path');

const headerPath = path.join(__dirname, 'native/choice-state.hpp');
const externalRoot = path.resolve(__dirname, '../../../external');

function ownedStage(engine) {
  if (typeof engine !== 'string' || !path.isAbsolute(engine)) throw new Error('An absolute owned Nitroplus source stage is required.');
  const directory = fs.realpathSync(engine);
  const vendored = fs.realpathSync(externalRoot);
  if (directory === vendored || directory.startsWith(vendored + path.sep)) throw new Error('External Nitroplus sources are read-only.');
  return directory;
}

function stageFile(directory, relative, { optional = false } = {}) {
  const file = path.join(directory, relative);
  const parent = fs.realpathSync(path.dirname(file));
  if (!parent.startsWith(directory + path.sep)) throw new Error('NSS choice overlay escapes its owned stage.');
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('NSS choice overlay requires regular owned source files.');
  } catch (error) { if (!optional || error.code !== 'ENOENT') throw error; }
  return file;
}

function patchSource(file, apply) {
  let source = fs.readFileSync(file, 'utf8');
  apply((before, after) => {
    if (source.indexOf(before) < 0 || source.indexOf(before) !== source.lastIndexOf(before)) {
      throw new Error('Pinned NSS choice overlay differs in ' + path.basename(file) + '.');
    }
    source = source.replace(before, () => after);
  });
  // Verify the complete patch before changing even the owned stage.
  fs.writeFileSync(file, source);
}

/** Candidate overlay, separate from the immutable Mac v6 build recipe. */
function adaptChoiceObjects(engine) {
  const directory = ownedStage(engine);
  const choice = stageFile(directory, 'src/Choice.cpp');
  const header = stageFile(directory, 'include/choice-state.hpp', { optional: true });
  patchSource(choice, replaceOnce => {
    replaceOnce('#include "Window.hpp"', '#include "Window.hpp"\n#include "choice-state.hpp"');
    replaceOnce(`    Texture* pMouseOver = dynamic_cast<Texture*>(Read("MouseOver/img"));
    Texture* pMouseClick = dynamic_cast<Texture*>(Read("MouseClick/img"));
    Texture* pMouseUsual = dynamic_cast<Texture*>(Read("MouseUsual/img"));

    if (pMouseOver) pMouseOver->Fade(0, 0);
    if (pMouseClick) pMouseClick->Fade(0, 0);
    if (pMouseUsual) pMouseUsual->Fade(0, 0);

    if (MouseOver && pMouseOver) pMouseOver->Fade(0, 1000);
    else if (ButtonDown && pMouseClick) pMouseClick->Fade(0, 1000);
    else if (pMouseUsual) pMouseUsual->Fade(0, 1000);`, `    const bool showOver = MouseOver && NativeChoiceState::hasTextures(*this, "MouseOver");
    const bool showClick = !showOver && ButtonDown && NativeChoiceState::hasTextures(*this, "MouseClick");
    NativeChoiceState::fade(*this, "MouseOver", showOver ? 1000 : 0);
    NativeChoiceState::fade(*this, "MouseClick", showClick ? 1000 : 0);
    NativeChoiceState::fade(*this, "MouseUsual", !showOver && !showClick ? 1000 : 0);`);
    replaceOnce(`    Texture* pTexture = dynamic_cast<Texture*>(Read("MouseUsual/img"));
    if (!pTexture) return;
    int x1 = pTexture->GetX();
    int x2 = x1 + pTexture->GetWidth();
    int y1 = pTexture->GetY();
    int y2 = y1 + pTexture->GetHeight();
    Flag = x > x1 && x < x2 && y > y1 && y < y2;`, `    Flag = NativeChoiceState::contains(*this, x, y);`);
    replaceOnce(`    if (Choice* pChoice = pNextFocus[Index])
        if (Texture* pTexture = dynamic_cast<Texture*>(pChoice->Read("MouseOver/img")))
            Window::PushMoveCursorEvent(pTexture->GetX() + pTexture->GetWidth() / 2, pTexture->GetY() + pTexture->GetHeight() / 2);`, `    if (Choice* pChoice = pNextFocus[Index]) {
        int x, y;
        if (NativeChoiceState::center(*pChoice, x, y)) Window::PushMoveCursorEvent(x, y);
    }`);
  });
  fs.copyFileSync(headerPath, header);
}

function adaptChoiceFocus(engine) {
  const interpreter = stageFile(ownedStage(engine), 'src/NSBInterpreter.cpp');
  patchSource(interpreter, replaceOnce => {
    replaceOnce('#include "Window.hpp"', '#include "Window.hpp"\n#include "choice-state.hpp"');
    replaceOnce(`    Choice* pFirst = Get<Choice>(PopString());
    Choice* pSecond = Get<Choice>(PopString());
    string Key = PopString();`, `    Choice* pFirst = NativeChoiceState::containingChoice(ObjectHolder, PopString());
    Choice* pSecond = NativeChoiceState::containingChoice(ObjectHolder, PopString());
    string Key = PopString();`);
  });
}

module.exports = { headerPath, adaptChoiceObjects, adaptChoiceFocus };
