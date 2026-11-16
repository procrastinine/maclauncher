'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const native = path.join(root, 'src', 'modules', 'shared', 'reshade', 'native');
const graphics = path.join(root, 'src', 'modules', 'godot', 'graphics');
const temporary = t => { const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'godot-ui-layer-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true })); return directory; };
const compile = (args, t) => {
  const built = spawnSync('xcrun', ['clang++', '-std=c++17', '-Wall', '-Wextra', '-Werror', ...args], { encoding: 'utf8', timeout: 60000 });
  assert.equal(built.status, 0, built.stderr);
  return built;
};

test('HUD split recovers the HUD-less colour of an 8-bit Godot composite within its rounding bound', t => {
  const directory = temporary(t), source = path.join(directory, 'split.cpp'), binary = path.join(directory, 'split');
  fs.writeFileSync(source, String.raw`#include "hud-split.hpp"
#include <cmath>
#include <cstdio>
#include <cstring>
int main(){
 using namespace macfx;
 // Godot's mix blend into a transparent layer stores premultiplied colour;
 // the same canvas over the 3D image stores ui + hud * (1 - alpha), rounded to 8 bits.
 const auto q=[](double v){return std::round(v*255.0)/255.0;};
 unsigned checked=0,failures=0;double worst=0;
 for(int ai=0;ai<=255;++ai){const float a=float(ai/255.0);
  if(hudSplitDerivable(a)!=(a<=0.9f)){std::printf("derivable %d\n",ai);++failures;}
  for(int h=0;h<=255;h+=3)for(int s=0;s<=255;s+=17){
   const double hud=h/255.0,ui=q(s/255.0*a),composed=q(ui+hud*(1.0-a));
   if(!hudSplitDerivable(a))continue;
   const double got=hudSplitChannel(float(composed),float(ui),a);
   // Reference: (final - ui) / (1 - alpha), clamped to the encoded range.
   const double reference=std::fmin(1.0,std::fmax(0.0,(composed-ui)/(1.0-a)));
   const double bound=0.5/255.0/(1.0-a)+1e-5;
   if(std::fabs(got-reference)>1e-5||std::fabs(got-hud)>bound){if(failures<5)std::printf("a=%d h=%d s=%d got=%f hud=%f\n",ai,h,s,got,hud);++failures;}
   worst=std::fmax(worst,std::fabs(got-hud)*255.0);++checked;
  }}
 if(hudSplitChannel(0.2f,0.5f,0.1f)!=0.0f||hudSplitChannel(1.0f,0.0f,0.5f)!=1.0f)++failures;
 if(!std::strstr(hudSplitSharedSource,"hudSplitChannel")||!std::strstr(hudSplitSharedSource,"hudSplitDerivable"))++failures;
 std::printf("checked=%u failures=%u worst=%.3f\n",checked,failures,worst);return failures?1:0;}
`);
  compile(['-I', native, source, '-o', binary], t);
  const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 30000 });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /failures=0/);
});

test('The HUD split kernel source compiles for Metal with the shared math', t => {
  const directory = temporary(t), source = path.join(directory, 'kernel.mm'), binary = path.join(directory, 'kernel');
  fs.writeFileSync(source, String.raw`#import <Metal/Metal.h>
#include "hud-split.hpp"
#include <cstdio>
int main(){@autoreleasepool{
 auto device=MTLCreateSystemDefaultDevice();if(!device){std::puts("NO_DEVICE");return 0;}
 NSError*error=nil;auto library=[device newLibraryWithSource:@(macfx::hudSplitKernelSource().c_str()) options:nil error:&error];
 if(!library||![library newFunctionWithName:@"hudSplit"]){std::printf("%s\n",error.localizedDescription.UTF8String?:"missing");return 1;}
 std::puts("KERNEL_OK");return 0;}}
`);
  const built = spawnSync('xcrun', ['clang++', '-std=c++17', '-fobjc-arc', '-x', 'objective-c++', '-I', native, source, '-framework', 'Metal', '-framework', 'Foundation', '-o', binary], { encoding: 'utf8', timeout: 60000 });
  assert.equal(built.status, 0, built.stderr);
  const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 30000 });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /KERNEL_OK|NO_DEVICE/);
});

test('The Godot bridge registers the UI layer methods and forwards them to the core', t => {
  const header = process.env.MACLAUNCHER_GDEXTENSION_INTERFACE_DIR;
  if (!header || !fs.existsSync(path.join(header, 'gdextension_interface.h'))) { t.skip('Set MACLAUNCHER_GDEXTENSION_INTERFACE_DIR to the Godot 4.4 gdextension_interface.h directory.'); return; }
  const directory = temporary(t), source = path.join(directory, 'host.cpp'), binary = path.join(directory, 'host');
  fs.writeFileSync(source, String.raw`#include <gdextension_interface.h>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <map>
#include <string>
#include <vector>
struct Method{std::string name;unsigned count=0;int type=-1;void*user=nullptr;GDExtensionClassMethodPtrCall ptr=nullptr;};
static std::vector<Method> methods;static GDExtensionClassCreationInfo2 created{};static void*instance=nullptr;
static int demand=1,clears=0;static void*seenOwner=nullptr,*seenTexture=nullptr;static uint64_t seenFrame=0;
extern "C" uint32_t rsGetSceneUILayerDemand(uint32_t version){return version==1?uint32_t(demand):0u;}
extern "C" int rsSetSceneUILayerForFrame(void*owner,void*texture,uint64_t frame){seenOwner=owner;seenTexture=texture;seenFrame=frame;return 0;}
extern "C" void rsClearSceneUILayers(void*owner){if(owner)++clears;}
extern "C" GDExtensionBool maclauncher_godot_camera_init(GDExtensionInterfaceGetProcAddress,GDExtensionClassLibraryPtr,GDExtensionInitialization*);
static void nameNew(GDExtensionUninitializedStringNamePtr out,const char*text){std::strncpy(static_cast<char*>(out),text,63);}
static void stringNew(GDExtensionUninitializedStringPtr out,const char*text){std::strncpy(static_cast<char*>(out),text,63);}
static void destroy(GDExtensionTypePtr){}
static GDExtensionPtrDestructor destructor(GDExtensionVariantType){return destroy;}
static void toValue(GDExtensionUninitializedTypePtr,GDExtensionVariantPtr){}
static GDExtensionTypeFromVariantConstructorFunc toType(GDExtensionVariantType){return toValue;}
static void fromValue(GDExtensionUninitializedVariantPtr,GDExtensionTypePtr){}
static GDExtensionVariantFromTypeConstructorFunc fromType(GDExtensionVariantType){return fromValue;}
static GDExtensionVariantType variantType(GDExtensionConstVariantPtr){return GDEXTENSION_VARIANT_TYPE_NIL;}
static void newNil(GDExtensionUninitializedVariantPtr){}
static int objectStorage;
static GDExtensionObjectPtr construct(GDExtensionConstStringNamePtr){return &objectStorage;}
static void setInstance(GDExtensionObjectPtr,GDExtensionConstStringNamePtr,GDExtensionClassInstancePtr value){instance=value;}
static void registerClass(GDExtensionClassLibraryPtr,GDExtensionConstStringNamePtr,GDExtensionConstStringNamePtr,const GDExtensionClassCreationInfo2*info){created=*info;}
static void registerMethod(GDExtensionClassLibraryPtr,GDExtensionConstStringNamePtr,const GDExtensionClassMethodInfo*info){Method m;m.name=static_cast<const char*>(info->name);m.count=info->argument_count;m.type=info->has_return_value?int(info->return_value_info->type):-1;m.user=info->method_userdata;m.ptr=info->ptrcall_func;methods.push_back(m);}
static void unregisterClass(GDExtensionClassLibraryPtr,GDExtensionConstStringNamePtr){}
static GDExtensionInterfaceFunctionPtr get(const char*name){
 static const std::map<std::string,GDExtensionInterfaceFunctionPtr> table={
  {"string_name_new_with_utf8_chars",reinterpret_cast<GDExtensionInterfaceFunctionPtr>(nameNew)},{"string_new_with_utf8_chars",reinterpret_cast<GDExtensionInterfaceFunctionPtr>(stringNew)},
  {"variant_get_ptr_destructor",reinterpret_cast<GDExtensionInterfaceFunctionPtr>(destructor)},{"get_variant_to_type_constructor",reinterpret_cast<GDExtensionInterfaceFunctionPtr>(toType)},
  {"get_variant_from_type_constructor",reinterpret_cast<GDExtensionInterfaceFunctionPtr>(fromType)},{"variant_get_type",reinterpret_cast<GDExtensionInterfaceFunctionPtr>(variantType)},
  {"variant_new_nil",reinterpret_cast<GDExtensionInterfaceFunctionPtr>(newNil)},{"classdb_construct_object",reinterpret_cast<GDExtensionInterfaceFunctionPtr>(construct)},
  {"object_set_instance",reinterpret_cast<GDExtensionInterfaceFunctionPtr>(setInstance)},{"classdb_register_extension_class2",reinterpret_cast<GDExtensionInterfaceFunctionPtr>(registerClass)},
  {"classdb_register_extension_class_method",reinterpret_cast<GDExtensionInterfaceFunctionPtr>(registerMethod)},{"classdb_unregister_extension_class",reinterpret_cast<GDExtensionInterfaceFunctionPtr>(unregisterClass)}};
 auto i=table.find(name);return i==table.end()?nullptr:i->second;}
static const Method*find(const char*name){for(const auto&m:methods)if(m.name==name)return &m;return nullptr;}
int main(){
 GDExtensionInitialization init{};if(!maclauncher_godot_camera_init(get,nullptr,&init)){std::puts("init failed");return 1;}
 init.initialize(init.userdata,GDEXTENSION_INITIALIZATION_SCENE);
 std::map<std::string,int>seen;for(const auto&m:methods)if(++seen[m.name]>1){std::printf("duplicate %s\n",m.name.c_str());return 1;}
 for(const char*name:{"available","clear","submit","submit_destination","aov_slot_idle"})if(!find(name)){std::printf("missing %s\n",name);return 1;}
 const auto*demandMethod=find("ui_layer_demand");const auto*submitMethod=find("submit_ui_layer");
 if(!demandMethod||!submitMethod){std::printf("missing UI layer methods (%zu registered)\n",methods.size());return 1;}
 if(demandMethod->count!=0||demandMethod->type!=GDEXTENSION_VARIANT_TYPE_INT||submitMethod->count!=2||submitMethod->type!=GDEXTENSION_VARIANT_TYPE_BOOL){std::puts("UI layer signatures differ");return 1;}
 created.create_instance_func(created.class_userdata);if(!instance){std::puts("no instance");return 1;}
 int64_t value=-1;demandMethod->ptr(demandMethod->user,instance,nullptr,&value);if(value!=1){std::puts("demand not forwarded");return 1;}
 demand=0;demandMethod->ptr(demandMethod->user,instance,nullptr,&value);if(value!=0){std::puts("demand off not forwarded");return 1;}
 const int64_t texture=0x5150,frame=77;const void*args[]={&texture,&frame};GDExtensionBool accepted=0;
 submitMethod->ptr(submitMethod->user,instance,args,&accepted);if(!accepted||seenOwner!=instance||seenTexture!=reinterpret_cast<void*>(uintptr_t(texture))||seenFrame!=77){std::puts("submit not forwarded");return 1;}
 const int64_t none=0;const void*empty[]={&none,&frame};accepted=1;submitMethod->ptr(submitMethod->user,instance,empty,&accepted);if(accepted){std::puts("null texture accepted");return 1;}
 const auto*clear=find("clear");clear->ptr(clear->user,instance,nullptr,nullptr);if(clears!=1){std::puts("clear keeps UI layers");return 1;}
 created.free_instance_func(created.class_userdata,instance);if(clears!=2){std::puts("destruction keeps UI layers");return 1;}
 std::printf("BRIDGE_UI_LAYER_OK %zu\n",methods.size());return 0;}
`);
  compile(['-I', header, path.join(graphics, 'bridge.cpp'), source, '-o', binary], t);
  const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 30000 });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /BRIDGE_UI_LAYER_OK/);
});

const godot = process.env.MACLAUNCHER_TEST_GODOT || path.join(os.homedir(), 'Library', 'Application Support', 'maclauncher',
  'runtimes', 'godot', '4.6.3-stable', 'mono', 'Godot_mono.app', 'Contents', 'MacOS', 'Godot');

test('The Godot graphics scripts parse headless', t => {
  if (!fs.existsSync(godot)) { t.skip('A local Godot runtime is required for GDScript parsing.'); return; }
  const directory = temporary(t);
  for (const name of ['autoload.gd', 'camera-effect.gd', 'aov-effect.gd']) fs.copyFileSync(path.join(graphics, name), path.join(directory, name));
  fs.writeFileSync(path.join(directory, 'project.godot'), '[application]\nconfig/name="GodotUILayerParse"\n');
  fs.writeFileSync(path.join(directory, 'verify.gd'), `extends SceneTree
func _init() -> void:
	for name in ["autoload.gd", "camera-effect.gd", "aov-effect.gd"]:
		var script := load("res://" + name) as GDScript
		if script == null or not script.can_instantiate():
			printerr("PARSE_FAILED " + name)
			quit(1)
			return
	print("GODOT_SCRIPTS_PARSE_OK")
	quit(0)
`);
  const result = spawnSync(godot, ['--headless', '--path', directory, '--script', 'res://verify.gd'], { encoding: 'utf8', timeout: 30000, env: { ...process.env, HOME: directory } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /GODOT_SCRIPTS_PARSE_OK/);
  assert.doesNotMatch(result.stderr, /SCRIPT ERROR|Parse Error/);
});

test('The Godot UI layer exists only while a scene frame-generation row asks for it', t => {
  if (!fs.existsSync(godot)) { t.skip('A local Godot runtime is required for GDScript execution.'); return; }
  const directory = temporary(t);
  fs.copyFileSync(path.join(graphics, 'autoload.gd'), path.join(directory, 'autoload.gd'));
  fs.writeFileSync(path.join(directory, 'project.godot'), '[application]\nconfig/name="GodotUILayer"\n');
  fs.writeFileSync(path.join(directory, 'verify.gd'), String.raw`extends SceneTree
class FakeBridge extends RefCounted:
	var demand := 0
	func ui_layer_demand() -> int:
		return demand
var ui: Node
var hud: CanvasLayer
func _init() -> void:
	var source = load("res://autoload.gd")
	ui = Control.new()
	ui.name = "GameUI"
	root.add_child.call_deferred(ui)
	hud = CanvasLayer.new()
	hud.layer = 3
	root.add_child.call_deferred(hud)
	process_frame.connect(_check.bind(source), CONNECT_ONE_SHOT)
func _check(source) -> void:
	var bridge := FakeBridge.new()
	var layers: Array[WeakRef] = [weakref(hud)]
	var layer = source.UILayer.new(root)
	layer.update(bridge, layers)
	assert(layer.viewport == null, "no layer without demand")
	assert(root.get_node_or_null("MacLauncherUILayer") == null)
	assert(root.get_child_count(true) == 2, "no node added without demand")
	bridge.demand = 1
	layer.update(bridge, layers)
	assert(root.get_child_count() == 2, "the layer is internal to the window")
	assert(layer.viewport != null, "layer while demanded")
	assert(layer.viewport.transparent_bg and layer.viewport.disable_3d and layer.viewport.gui_disable_input)
	assert(layer.viewport.world_2d == root.world_2d)
	assert(layer.viewport.size == Vector2i(root.get_texture().get_size()))
	assert(layer.canvases.has(hud.get_canvas()), "canvas layers attached")
	assert(not layer.canvases.has(root.world_2d.canvas), "the shared world canvas is drawn by the shared world")
	bridge.demand = 0
	layer.update(bridge, layers)
	assert(layer.viewport == null, "layer detached when demand ends")
	assert(root.get_node_or_null("MacLauncherUILayer") == null)
	assert(ui.get_parent() == root and hud.get_parent() == root, "game nodes untouched")
	print("GODOT_UI_LAYER_OK")
	quit(0)
`);
  const result = spawnSync(godot, ['--headless', '--path', directory, '--script', 'res://verify.gd'], { encoding: 'utf8', timeout: 30000, env: { ...process.env, HOME: directory } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /GODOT_UI_LAYER_OK/);
  assert.doesNotMatch(result.stderr, /SCRIPT ERROR|Parse Error/);
});
