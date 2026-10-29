const { writeRuntimeCatalog } = require('../../src/modules/shared/runtime/runtime-catalog');
const revision = 'c'.repeat(40);
const argsVersion = '8.1.0', legacyVersion = '8.0.0', umtVersion = '0.10.1.0-native-macos', gm8Version = '3.1.0-macos';
const sourceUrls = { butterscotch:'https://github.com/ButterscotchRunner/Butterscotch/actions/workflows/build.yml',
  'undertale-mod-cli':'https://github.com/UnderminersTeam/UndertaleModTool/releases',
  'gm8-decompiler':'https://github.com/OpenGMK/GM8Decompiler/releases', opengmk:'https://github.com/OpenGMK/OpenGMK/releases' };
const asset = version => ({ url:'https://github.com/example/runtime/releases/download/'+version+'/runtime.zip', filename:'runtime.zip', sha256:'b'.repeat(64) });
const rows = () => ({ butterscotch:[{version:legacyVersion,upstreamRevision:revision,minimumMacOS:'13.0',backend:'appkit',asset:asset(legacyVersion)},
  {version:argsVersion,upstreamRevision:revision,minimumMacOS:'13.0',backend:'appkit',capabilities:{gameArguments:'repeat-game-arg-v1'},asset:asset(argsVersion)}],
  'undertale-mod-cli':[{version:umtVersion,upstreamRevision:revision,cliVersion:'0.10.1.0',asset:asset(umtVersion)}],
  'gm8-decompiler':[{version:gm8Version,upstreamRevision:revision,toolVersion:'3.1.0',asset:asset(gm8Version)}] });
function cache(userDataDir, entries = rows()) {
  for (const [managerId, values] of Object.entries(entries)) writeRuntimeCatalog({ userDataDir,managerId,entries:values,source:sourceUrls[managerId] });
}
function source(architecture='arm64') {
  const label=architecture==='x64'?'x86_64':'arm64';
  return {args:'{"save-folder",required_argument,nullptr,1},{"renderer",required_argument,nullptr,2}; "legacy-gl"; case \'H\': printUsage(argv[0]); exit(0);',
    entry:'parseCommandLineArgs(&args, argc, argv);',
    cmake:['14','16','17'].map(v=>`option(ENABLE_WAD${v} "support" ON)`).join('\n')+'\noption(ENABLE_LEGACY_GL "renderer" ON)',
    workflow:`  build-appkit-macos:\n    - label: ${label}\n      runner: macos-26\n    -DBACKEND=appkit \\\n`};
}
function sourceBody(url,architecture='arm64') {
  if (!url.startsWith('https://raw.githubusercontent.com/')) return null;
  const value=source(architecture), key=url.endsWith('/args.c')?'args':url.endsWith('/main.c')?'entry':url.endsWith('/CMakeLists.txt')?'cmake':'workflow';
  return Buffer.from(value[key]);
}
module.exports={revision,argsVersion,legacyVersion,umtVersion,gm8Version,rows,cache,source,sourceBody};
