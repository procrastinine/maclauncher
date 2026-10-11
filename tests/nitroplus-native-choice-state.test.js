const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const Build = require('../src/modules/nitroplus/runtime/build');
const Overlay = require('../src/modules/nitroplus/runtime/choice-overlay');

const boost = ['/opt/homebrew/include', '/usr/local/include'].find(root => fs.existsSync(path.join(root, 'boost/locale.hpp')));
const initialized = fs.existsSync(path.join(Build.sourcePath, 'src/Choice.cpp')) && fs.existsSync(path.join(Build.npaSourcePath, 'include/inpafile.hpp'));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('NSS choice hit testing and focus work with arbitrary named state textures and preserve img choices', {
  skip: process.platform !== 'darwin' || !boost || !initialized
}, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nitroplus-choice-state-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const originals = [path.join(Build.sourcePath, 'src/Choice.cpp'), path.join(Build.sourcePath, 'include/Object.hpp')];
  const seals = originals.map(hash);
  for (const variant of ['baseline', 'candidate']) {
    const engine = path.join(root, variant);
    fs.cpSync(path.join(Build.sourcePath, 'include'), path.join(engine, 'include'), { recursive: true });
    fs.mkdirSync(path.join(engine, 'src'));
    fs.copyFileSync(originals[0], path.join(engine, 'src/Choice.cpp'));
    Build.adaptObjectSources(engine);
    if (variant === 'candidate') Overlay.adaptChoiceObjects(engine);
  }
  const source = path.join(root, 'fixture.cpp');
  fs.writeFileSync(source, `#include "Choice.hpp"
#include "Window.hpp"
#include <cassert>
#include <iostream>
#include <map>
#ifdef ADAPTED_CHOICE_STATE
#include "choice-state.hpp"
#endif
Window* Object::pWindow = nullptr;
static std::map<Texture*, int> opacity;
static int focusX=-1,focusY=-1;
GLTexture::GLTexture() { Width=Height=0; GLTextureID=0; }
GLTexture::~GLTexture() {}
Texture::Texture() { X=Y=0; XScale=YScale=1000; }
Texture::~Texture() {}
void Texture::Request(int32_t) { assert(false); }
void Texture::Draw(uint32_t) { assert(false); }
void Texture::SetPosition(int x,int y) { X=x;Y=y; }
void Texture::Fade(int32_t time,int alpha,int32_t) { assert(time==0);opacity[this]=alpha; }
void Window::PushMoveCursorEvent(int x,int y) { focusX=x;focusY=y; }
struct Face:Texture {
    Face(int x=120,int y=230,int w=560,int h=34) { Width=w;Height=h;SetPosition(x,y);opacity[this]=42; }
};
static SDL_Event event(unsigned type,int x,int y) {
    SDL_Event e={};e.type=type;e.button.button=SDL_BUTTON_LEFT;e.button.x=x;e.button.y=y;return e;
}
int main() {
    // Existing img faces retain selection, fade precedence and direct focus.
    Choice legacy;
    auto normal=new Face,over=new Face,click=new Face;
    legacy.Write("MouseUsual/img",normal);legacy.Write("MouseOver/img",over);legacy.Write("MouseClick/img",click);
    assert(legacy.IsSelected(event(SDL_MOUSEBUTTONUP,400,246)));legacy.Reset();
    assert(opacity[normal]==1000&&opacity[over]==0&&opacity[click]==0);
    assert(!legacy.IsSelected(event(SDL_MOUSEBUTTONUP,119,246)));legacy.Reset();
    // A state with no alternate face remains visible while hovered.
    Choice normalOnly;auto only=new Face;
    normalOnly.Write("MouseUsual/img",only);
    normalOnly.IsSelected(event(SDL_MOUSEMOTION,400,246));assert(opacity[only]==1000);
    // Face names are object handles, not a reserved img spelling. Native
    // source consumers use both UTF-8 and CP932 names and grouped state faces.
    Choice named;auto namedNormal=new Face,namedOver=new Face,namedClick=new Face;
    named.Write("MouseUsual/face",namedNormal);named.Write("MouseOver/alternate",namedOver);named.Write("MouseClick/pressed",namedClick);
    named.Write("MouseUsual/callback",new Object);
    bool namedSelected=named.IsSelected(event(SDL_MOUSEBUTTONUP,400,246));named.Reset();
#ifdef ADAPTED_CHOICE_STATE
    assert(namedSelected&&opacity[namedNormal]==1000&&opacity[namedOver]==0&&opacity[namedClick]==0);
    named.IsSelected(event(SDL_MOUSEMOTION,400,246));assert(opacity[namedOver]==1000&&opacity[namedNormal]==0);
    named.IsSelected(event(SDL_MOUSEMOTION,50,50));assert(opacity[namedNormal]==1000&&opacity[namedOver]==0);
    Choice encoded;encoded.Write(std::string("MouseUsual/")+"\\x89\\xe6\\x91\\x9c",new Face);
    assert(encoded.IsSelected(event(SDL_MOUSEBUTTONUP,400,246)));encoded.Reset();
    Choice nested;nested.Write("MouseUsual/group",new Name);nested.Write("MouseUsual/group/custom",new Face(20,30,60,40));
    assert(nested.IsSelected(event(SDL_MOUSEBUTTONUP,25,35)));nested.Reset();
    assert(!nested.IsSelected(event(SDL_MOUSEBUTTONUP,400,246)));nested.Reset();
    assert(!named.IsSelected(event(SDL_MOUSEBUTTONUP,680,246)));named.Reset();
    assert(named.IsSelected(event(SDL_MOUSEBUTTONUP,120,230)));named.Reset();
    ObjectHolder_t root;auto first=new Choice,second=new Choice;
    root.Write("first",first);root.Write("second",second);root.WriteAlias("second","second_alias");
    first->Write("MouseUsual/custom",new Face(10,20,40,30));second->Write("MouseUsual/custom",new Face(120,230,560,34));
    assert(NativeChoiceState::containingChoice(root,"first/MouseUsual/custom")==first);
    assert(NativeChoiceState::containingChoice(root,"@second_alias/MouseUsual/custom")==second);
    assert(!NativeChoiceState::containingChoice(root,"missing/MouseUsual/custom"));
    auto a=NativeChoiceState::containingChoice(root,"first/MouseUsual/custom");
    auto b=NativeChoiceState::containingChoice(root,"@second_alias/MouseUsual/custom");
    a->SetNextFocus(b,"DOWN");SDL_Event down={};down.type=SDL_KEYDOWN;down.key.keysym.sym=SDLK_DOWN;a->IsSelected(down);
    assert(focusX==400&&focusY==247);
    Choice deleted;deleted.Write("MouseUsual/custom",new Face);deleted.Delete("MouseUsual/custom");
    assert(!deleted.IsSelected(event(SDL_MOUSEBUTTONUP,400,246)));
    // Repeated use does not rewrite namespaces or retain foreign objects.
    for(int i=0;i<50;i++){assert(named.IsSelected(event(SDL_MOUSEBUTTONUP,400,246)));named.Reset();}
    std::cout<<"{\\"variant\\":\\"candidate\\",\\"arbitraryFaceSelected\\":true,\\"focus\\":["<<focusX<<","<<focusY<<"]}";
#else
    assert(!namedSelected&&opacity[namedNormal]==42); // Exact original regression.
    std::cout<<"{\\"variant\\":\\"baseline\\",\\"arbitraryFaceSelected\\":false}";
#endif
}
`);
  for (const variant of ['baseline', 'candidate']) {
    const engine = path.join(root, variant), executable = path.join(root, variant + '-fixture');
    const args = ['-std=c++17', '-I', path.join(engine, 'include'), '-I', path.join(Build.npaSourcePath, 'include'), '-I', boost,
      source, path.join(engine, 'src/Choice.cpp'), '-o', executable];
    if (variant === 'candidate') args.unshift('-DADAPTED_CHOICE_STATE=1');
    execFileSync('/usr/bin/clang++', args, { timeout: 30000 });
    const result = JSON.parse(execFileSync(executable, [], { encoding: 'utf8', timeout: 5000 }));
    assert.equal(result.variant, variant);
    assert.equal(result.arbitraryFaceSelected, variant === 'candidate');
    if (variant === 'candidate') assert.deepEqual(result.focus, [400, 247]);
  }
  assert.deepEqual(originals.map(hash), seals);
  assert.throws(() => Overlay.adaptChoiceObjects(Build.sourcePath), /read-only/);
});

test('NSS focus overlay resolves containing choice handles only in an owned source stage', { skip: !initialized }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nitroplus-choice-focus-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'));
  const original = path.join(Build.sourcePath, 'src/NSBInterpreter.cpp'), file = path.join(root, 'src/NSBInterpreter.cpp');
  const before = hash(original);
  fs.copyFileSync(original, file);
  Overlay.adaptChoiceFocus(root);
  assert.match(fs.readFileSync(file, 'utf8'), /NativeChoiceState::containingChoice\(ObjectHolder, PopString\(\)\)/);
  const adapted = hash(file);
  assert.throws(() => Overlay.adaptChoiceFocus(root), /Pinned NSS choice overlay differs/);
  assert.equal(hash(file), adapted);
  assert.equal(hash(original), before);
  fs.unlinkSync(file); fs.symlinkSync(original, file);
  assert.throws(() => Overlay.adaptChoiceFocus(root), /regular owned source/);
  assert.equal(hash(original), before);
});
