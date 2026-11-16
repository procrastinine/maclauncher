# Copyright (c) MacLauncher contributors. MIT license.
"""Prepare user-owned Lite model data as portable MSL and native coefficients.

The included interpreter runs only source transformations. Metal compiles these
sources during the provider's bounded resource preparation; no SDK is required.
"""
import contextlib, hashlib, importlib.util, io, itertools, json, pathlib, sys

root=pathlib.Path(sys.argv[1]).resolve()
provider=pathlib.Path(sys.argv[2]).resolve()
profiles=sys.argv[3:]
tools=root/'tools'
sys.path.insert(0,str(tools))

def load(name,file):
    spec=importlib.util.spec_from_file_location(name,file)
    module=importlib.util.module_from_spec(spec)
    sys.modules[name]=module
    spec.loader.exec_module(module)
    return module

file=tools/'fsr412/compile_fsr412.py'
source=file.read_text()
# Upstream's generated Metal is the payload; omit only its SDK compilation.
lines=[]
for line in source.splitlines():
    if 'run(["xcrun"' in line and not 'digest.update' in line:
        continue
    lines.append(line)
source='\n'.join(lines).replace('.metallib','.metal')
source=source.replace('digest.update(run(["xcrun","metal","--version"]))','digest.update(b"maclauncher-portable-lite-v1")')
module=type(sys)('fsr412_compile_owned');module.__file__=str(file)
exec(compile(source,str(file),'exec'),module.__dict__)
# The immutable provider already carries the independently compiled support
# graph. Flatten its paths before upstream copies it into the model closure.
def support_bundle(_root,_build,colorspace,auto_exposure):
    for manifest_file in sorted((provider/'build').glob('fsr411_1080_*/bindings.json')):
        manifest=json.loads(manifest_file.read_text())
        if manifest.get('colorspace')!=colorspace or manifest.get('auto_exposure')!=auto_exposure or manifest.get('auto_exposure_dispatches')!=2:
            continue
        folder=root/'support'/str(auto_exposure);folder.mkdir(parents=True,exist_ok=True)
        import shutil
        for name in ('ae','ae_finalize','rcas'):
            entry=manifest['kernels'][name]
            for field in ('library','literal_tables'):
                if entry.get(field):
                    original=(manifest_file.parent/entry[field]).resolve()
                    relative_path=str(original.relative_to(provider))
                    original=provider/_aliases.get('files',{}).get(relative_path,relative_path)
                    relative=name+original.suffix
                    shutil.copyfile(original,folder/relative)
                    entry[field]=relative
        return folder,manifest
    raise ValueError('The installed FSR 4 provider has no matching exposure support graph')
module.support_bundle=support_bundle
native=load('fsr412_native_owned',tools/'fsr412/native_model.py')
from fsr412.model_data import initializer_for
# Decode flat payload aliases without materializing duplicated resources.
_alias_file=provider/'payload-aliases.json'
_aliases=json.loads(_alias_file.read_text()) if _alias_file.exists() else {}

for profile in profiles:
    if profile not in ('int8-lite','int8-lite-lossy'):raise ValueError('Unknown Lite profile')
    for tier,ultra in itertools.product((1080,2160,4320),(0,1)):
        preset='ultraperformance' if ultra else 'normal'
        _,data,_=initializer_for(root,tier,preset,profile)
        folder=root/'build'/('fsr412_native_'+str(tier)+('_ultraperformance' if ultra else '')+('_lossy' if profile=='int8-lite-lossy' else ''))
        native.pack(tier,preset,data,folder,profile)
        for depth,low,jitter,exposure in itertools.product((0,1),repeat=4):
            sys.argv=[str(file),'--root',str(root),'--builddir',str(root/'build'),'--res',str(tier),'--optimize','1','--external-post-cnb','1',
                '--depth-inverted',str(depth),'--low-res-mv',str(low),'--jittered-mv',str(jitter),'--auto-exposure',str(exposure),
                '--ultra-performance',str(ultra),'--lossy','1' if profile=='int8-lite-lossy' else '0']
            with contextlib.redirect_stdout(io.StringIO()):module.main()
            # Identical generated programs are stored once across permutations.
            key=f"fsr412_{tier}_di{depth}_lm{low}_jm{jitter}_cs0_ae{exposure}_o1_up{ultra}_pc1"+('_lossy2' if profile=='int8-lite-lossy' else '')+'_v3'
            manifest_file=root/'build'/key/'bindings.json'
            manifest=json.loads(manifest_file.read_text())
            shared=root/'build/libraries';shared.mkdir(exist_ok=True)
            for entry in manifest['kernels'].values():
                for field in ('library','literal_tables'):
                    if not entry.get(field):continue
                    item=manifest_file.parent/entry[field]
                    data=item.read_bytes();name=hashlib.sha256(data).hexdigest()+item.suffix
                    destination=shared/name
                    if not destination.exists():destination.write_bytes(data)
                    entry[field]='../libraries/'+name
            manifest_file.write_text(json.dumps(manifest,separators=(',',':'))+'\n')
            for item in manifest_file.parent.iterdir():
                if item.suffix in ('.metal','.air','.metallib'):item.unlink()
print(json.dumps({'profiles':profiles,'complete':True}))
