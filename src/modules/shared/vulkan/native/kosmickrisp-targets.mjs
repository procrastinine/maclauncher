import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {adaptedKosmicSources} from './kosmickrisp-source.mjs';
import {prepareSourceTree, writeChanged} from './source-files.mjs';

const pin = JSON.parse(fs.readFileSync(new URL('./kosmickrisp-source.json', import.meta.url)));
const targets = JSON.parse(fs.readFileSync(new URL('./kosmickrisp-targets.json', import.meta.url)));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const read = (tool, args, options = {}) => execFileSync(tool, args, {encoding: 'utf8', ...options}).trim();
const run = (tool, args, options = {}) => execFileSync(tool, args, {stdio: 'inherit', ...options});
const toolFiles = {
    mesa_clc: 'src/compiler/clc/mesa_clc',
    vtn_bindgen2: 'src/compiler/spirv/vtn_bindgen2',
    kk_clc: 'src/kosmickrisp/clc/kk_clc',
};

function verifySource(source, input) {
    if (read('git', ['-C', source, 'rev-parse', 'HEAD']) !== input.revision) throw Error('Vulkan source revision differs from its pin');
}

export function describeNativeTools({source, build}) {
    verifySource(source, pin);
    const files = Object.fromEntries(Object.entries(toolFiles).map(([name, relative]) => [name, {
        path: relative, sha256: sha(path.join(build, relative)),
    }]));
    const record = {schemaVersion: 1, repository: pin.repository, revision: pin.revision, files};
    writeChanged(path.join(build, 'native-tools.json'), JSON.stringify(record, null, 2) + '\n');
    return build;
}

export function buildKosmicTargets(options, buildNative) {
    const {source, work, meson, ninja} = options;
    verifySource(source, pin);
    const architectures = options.architecture === 'universal' ? ['x64', 'arm64'] : [options.architecture];
    if (architectures.some(architecture => !['arm64', 'x64'].includes(architecture))) throw Error('Kosmic targets are arm64, x64 or universal');
    let nativeBuild = options.nativeBuild || options['native-build'];
    if (!nativeBuild) {
        const native = buildNative({...options, architecture: 'arm64', work: path.join(work, 'native')});
        nativeBuild = native.nativeBuild;
    }
    const native = JSON.parse(fs.readFileSync(path.join(nativeBuild, 'native-tools.json')));
    if (native.revision !== pin.revision || native.repository !== pin.repository) throw Error('Kosmic native compilers differ from their source pin');
    if (JSON.stringify(Object.keys(native.files).sort()) !== JSON.stringify(Object.keys(toolFiles).sort())) throw Error('Kosmic native compilers are incomplete');
    for (const [name, file] of Object.entries(native.files)) {
        if (file.path !== toolFiles[name] || file.sha256 !== sha(path.join(nativeBuild, file.path))) throw Error('Kosmic native compiler differs from its metadata');
    }
    const projected = path.join(work, 'source');
    prepareSourceTree(projected, temporary => {
        fs.cpSync(source, temporary, {recursive: true, filter: file => path.basename(file) !== '.git'});
        for (const [file, content] of Object.entries(adaptedKosmicSources(source))) writeChanged(path.join(temporary, file), content);
    });
    const environment = {...process.env, MACOSX_DEPLOYMENT_TARGET: pin.minimumMacOS,
        MESA_GIT_SHA1_OVERRIDE: pin.revision,
        PATH: [path.dirname(meson), ...Object.values(toolFiles).map(file => path.dirname(path.join(nativeBuild, file))), process.env.PATH].join(path.delimiter)};
    const outputs = [];
    const jobs = Number(options.jobs || 2);
    if (!Number.isInteger(jobs) || jobs < 1 || jobs > 4) throw Error('Kosmic builds use one to four compiler jobs');
    for (const architecture of architectures) {
        const cpu = architecture === 'x64' ? 'x86_64' : 'arm64';
        const cross = path.join(work, architecture === 'x64' ? 'cross.ini' : 'cross-arm64.ini');
        writeChanged(cross, `[binaries]
c = ['/usr/bin/clang', '-arch', '${cpu}']
cpp = ['/usr/bin/clang++', '-arch', '${cpu}']
objc = ['/usr/bin/clang', '-arch', '${cpu}']
objcpp = ['/usr/bin/clang++', '-arch', '${cpu}']
ar = '/usr/bin/ar'
strip = '/usr/bin/strip'
pkg-config = '/usr/bin/false'
[host_machine]
system = 'darwin'
cpu_family = '${architecture === 'x64' ? 'x86_64' : 'aarch64'}'
cpu = '${cpu}'
endian = 'little'
[properties]
needs_exe_wrapper = false
[built-in options]
c_link_args = ['-arch', '${cpu}']
cpp_link_args = ['-arch', '${cpu}']
objc_link_args = ['-arch', '${cpu}']
`);
        const build = path.join(work, architecture === 'x64' ? 'build' : 'build-arm64');
        const args = ['setup', ...(fs.existsSync(path.join(build, 'build.ninja')) ? ['--reconfigure'] : []), build, projected,
            '--cross-file', cross, '--buildtype=release', '--wrap-mode=nofallback', '-Dvulkan-drivers=kosmickrisp',
            '-Dgallium-drivers=[]', '-Dplatforms=macos', '-Dopengl=false', '-Dgles1=disabled', '-Dgles2=disabled',
            '-Degl=disabled', '-Dglx=disabled', '-Dgbm=disabled', '-Dllvm=disabled', '-Dmesa-clc=system',
            '-Dprecomp-compiler=system', '-Dspirv-tools=disabled', '-Dzstd=disabled', '-Dxmlconfig=disabled',
            '-Dbuild-tests=false', '-Dvideo-codecs=[]'];
        run(meson, args, {env: environment});
        run(ninja, ['-C', build, '-j', String(jobs), 'src/kosmickrisp/vulkan/' + pin.library], {env: environment});
        outputs.push(path.join(build, 'src/kosmickrisp/vulkan', pin.library));
    }
    const library = outputs.length === 1 ? outputs[0] : path.join(work, pin.library);
    if (outputs.length > 1) run('/usr/bin/lipo', ['-create', ...outputs, '-output', library]);
    return {library, projected, nativeBuild, architecture: options.architecture};
}

export function buildKosmicLoader({source, headersSource, work, architecture = 'universal', jobs = 2}) {
    verifySource(source, targets.vulkanLoader);
    verifySource(headersSource, targets.vulkanHeaders);
    const headersBuild = path.join(work, 'headers-build'), headers = path.join(work, 'headers');
    run('cmake', ['-S', headersSource, '-B', headersBuild, '-DCMAKE_INSTALL_PREFIX=' + headers,
        '-DVULKAN_HEADERS_ENABLE_TESTS=OFF', '-DVULKAN_HEADERS_ENABLE_MODULE=OFF']);
    run('cmake', ['--install', headersBuild]);
    const build = path.join(work, 'loader-build');
    const architectures = architecture === 'universal' ? 'arm64;x86_64' : architecture === 'x64' ? 'x86_64' : 'arm64';
    run('cmake', ['-S', source, '-B', build, '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_OSX_ARCHITECTURES=' + architectures,
        '-DCMAKE_OSX_DEPLOYMENT_TARGET=' + pin.minimumMacOS,
        '-DCMAKE_C_FLAGS=-ffile-prefix-map=' + source + '=/Vulkan-Loader -ffile-prefix-map=' + work + '=/build',
        '-DVulkanHeaders_DIR=' + path.join(headers, 'share/cmake/VulkanHeaders'), '-DBUILD_TESTS=OFF']);
    run('cmake', ['--build', build, '--target', 'vulkan', '--parallel', String(jobs)]);
    return {loader: fs.realpathSync(path.join(build, 'loader/libvulkan.1.dylib')), loaderNotice: path.join(source, 'LICENSE.txt')};
}
