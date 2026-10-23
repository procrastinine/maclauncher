const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const Native = require("../../shared/runtime/local-native");
const Build = require("../../shared/runtime/pinned-native-build");
const { throwIfAborted } = require("../../shared/runtime/download-utils");

const VERSION = "0.5.3-macos-v7";
const LEGACY_VERSION = "0.5.3-macos-v1";
const V2_VERSION = "0.5.3-macos-v2";
const V3_VERSION = "0.5.3-macos-v3";
const V4_VERSION = "0.5.3-macos-v4";
const V5_VERSION = "0.5.3-macos-v5";
const PREVIOUS_VERSION = "0.5.3-macos-v6";
const SUPPORTED_VERSIONS = Object.freeze([VERSION, PREVIOUS_VERSION, V5_VERSION, V4_VERSION, V3_VERSION, V2_VERSION, LEGACY_VERSION]);
const PROFILE_REVISION = "macos-npa-nss-private-v7";
const REVISION = "da1a175e6b497c37f9714b77510cb47c0930cd42";
const NPA_REVISION = "5bdf666155d828d9ef4003fd9dc39e154aa4b0f1";
const sourcePath = path.resolve(__dirname, "../../../external/libnpengine");
const npaSourcePath = path.resolve(__dirname, "../../../external/libnpa");
const ChoiceOverlay = require("./choice-overlay");
const building = new Set();
const PLUGINS = ["app", "audioconvert", "audioresample", "autodetect", "avi", "coreelements", "jpeg", "libav",
  "ogg", "osxaudio", "playback", "png", "typefindfunctions", "videoconvertscale", "volume", "vorbis", "wavparse"];

function sourcePathFlags(directory) {
  const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
  const mappings = [[directory, `maclauncher-build/npengine/${VERSION}`],
    [path.join(directory, "build-source"), "src/modules/nitroplus/native-stage"],
    [path.join(directory, "build-source/libnpengine"), "src/external/libnpengine"],
    [path.join(directory, "build-source/libnpa"), "src/external/libnpa"]];
  return mappings.flatMap(([from, to]) => ["file", "debug", "macro"].map(kind => `-f${kind}-prefix-map=${quote(from + "=" + to)}`)).join(" ");
}

function replace(file, before, after) {
  const text = fs.readFileSync(file, "utf8");
  if (!text.includes(before) || text.indexOf(before) !== text.lastIndexOf(before)) throw new Error(`Pinned libnpengine overlay differs in ${path.basename(file)}.`);
  fs.writeFileSync(file, text.replace(before, () => after));
}

function adaptObjectSources(engine) {
  // NSS choice callbacks can attach below MouseLeave just as they do below
  // MouseOver. Upstream omitted that event namespace and dereferenced null.
  replace(path.join(engine, "src/Choice.cpp"), '    Write("MouseOver", new Name);',
    '    Write("MouseOver", new Name);\n    Write("MouseLeave", new Name);');
  replace(path.join(engine, "include/Object.hpp"), '#include <regex>', '#include <regex>\n#include <stdexcept>');
  replace(path.join(engine, "include/Object.hpp"), '        return GetHolder(ObjHandle)->Read(Leftover);',
    '        auto holder = GetHolder(ObjHandle);\n        return holder ? holder->Read(Leftover) : nullptr;');
  replace(path.join(engine, "include/Object.hpp"), '        else\n            GetHolder(ObjHandle)->Write(Leftover, pObject);',
    '        else {\n            auto holder = GetHolder(ObjHandle);\n            if (!holder) throw std::runtime_error("Missing NSS object namespace: " + Handle);\n            holder->Write(Leftover, pObject);\n        }');
  replace(path.join(engine, "include/Object.hpp"), '    string ExtractObjHandle(string& Handle)\n    {',
    '    string ExtractObjHandle(string& Handle, unsigned int AliasDepth = 0)\n    {\n        if (AliasDepth > 32) throw std::runtime_error("NSS object aliases exceed their nesting limit");');
  replace(path.join(engine, "include/Object.hpp"), "        if (ObjHandle.front() == '@' && ObjHandle.back() != '*')",
    "        if (!ObjHandle.empty() && ObjHandle.front() == '@' && ObjHandle.back() != '*')");
  replace(path.join(engine, "include/Object.hpp"), '            Handle = Aliases[ObjHandle.substr(1)] + "/" + Handle;\n            ObjHandle = ExtractObjHandle(Handle);',
    '            auto alias = Aliases.find(ObjHandle.substr(1));\n            if (alias == Aliases.end()) return ObjHandle;\n            Handle = alias->second + "/" + Handle;\n            ObjHandle = ExtractObjHandle(Handle, AliasDepth + 1);');
  replace(path.join(engine, "include/Object.hpp"), "        if (ObjHandle.back() == '*')",
    "        if (!ObjHandle.empty() && ObjHandle.back() == '*')");
}

function adaptSource(root) {
  const engine = path.join(root, "libnpengine"), npa = path.join(root, "libnpa");
  replace(path.join(npa, "include/buffer.hpp"), "#include <vector>", "#include <vector>\n#include <type_traits>\n#include <memory>\n#include <stdexcept>");
  replace(path.join(npa, "src/buffer.cpp"), "    memcpy(pDest, pData + Offset, Size);",
    '    if (Offset > this->Size || Size > this->Size - Offset) throw std::runtime_error("NSB buffer read escapes its data");\n    memcpy(pDest, pData + Offset, Size);');
  replace(path.join(npa, "src/lexer.l"), '"BezierMove".*', '"$Revision:"[^\\n]*        ;\n"BezierMove".*');
  replace(path.join(npa, "src/lexer.l"), '%option noyywrap', '%option noyywrap yylineno');
  replace(path.join(npa, "src/lexer.l"), '%%\n\n"/*"', '%x VARIABLE_NAME\n\n%%\n\n<VARIABLE_NAME>[a-zA-Zａ-ｚＡ-Ｚあ-ゖァ-ヺ一-龯_][.a-zA-Zａ-ｚＡ-Ｚあ-ゖァ-ヺ一-龯０-９0-9_]* { BEGIN(INITIAL); SAVE_TOKEN; return TIDENTIFIER; }\n<VARIABLE_NAME>[ \\t] ;\n<VARIABLE_NAME>[,)] { BEGIN(INITIAL); yyless(0); }\n<VARIABLE_NAME>. { BEGIN(INITIAL); throw std::runtime_error(std::string("Invalid NSS variable name at line ") + std::to_string(yylineno) + ": " + yytext); }\n"/*"');
  replace(path.join(npa, "src/lexer.l"), '"$"                     return TOKEN(TDOLLAR);', '"$"                     { BEGIN(VARIABLE_NAME); return TOKEN(TDOLLAR); }');
  replace(path.join(npa, "src/lexer.l"), '"#"                     return TOKEN(THASH);', '"#"                     { BEGIN(VARIABLE_NAME); return TOKEN(THASH); }');
  replace(path.join(npa, "src/lexer.l"), '#include <string>', '#include <string>\n#include <stdexcept>');
  replace(path.join(npa, "src/lexer.l"), '%x VARIABLE_NAME', '%x VARIABLE_NAME PRE_TEXT');
  replace(path.join(npa, "src/lexer.l"), '"<PRE"(.|[ \\t\\v\\n])*"</PRE>" SAVE_TOKEN; return TXML;',
    '"<PRE"                  { BEGIN(PRE_TEXT); yymore(); }\n<PRE_TEXT>"</PRE>"       { BEGIN(INITIAL); SAVE_TOKEN; return TXML; }\n<PRE_TEXT>(.|\\n)         { yymore(); }\n<PRE_TEXT><<EOF>>        { throw std::runtime_error("Unterminated NSS text block at line " + std::to_string(yylineno)); }');
  replace(path.join(npa, "src/lexer.l"), '.                       printf("Unknown token!\\n"); yyterminate();',
    '.                       { throw std::runtime_error(std::string("Unknown NSS token at line ") + std::to_string(yylineno) + ": " + yytext); }');
  replace(path.join(npa, "src/lexer.l"), '[0-9]+\\.[0-9]*          SAVE_TOKEN; return TFLOAT;',
    '0[xX][0-9A-Fa-f]+       SAVE_TOKEN; return TINTEGER;\n[0-9]+\\.[0-9]*          SAVE_TOKEN; return TFLOAT;');
  replace(path.join(npa, "src/lexer.l"), '"#"[0-9A-Fa-f]{6}       SAVE_TOKEN; return THEX;',
    '("#"[0-9A-Fa-f]{6}|"#"[0-9][0-9A-Fa-f]{0,5})/[,); \\t\\r\\n] SAVE_TOKEN; return THEX;');
  replace(path.join(npa, "src/parser.y"), '    void yyerror(const char* s) { std::printf("Error: %s\\n", s); std::abort(); }',
    '    extern int yylineno;\n    extern char* yytext;\n    void yyerror(const char* s) { throw std::runtime_error(std::string(s) + " at NSS line " + std::to_string(yylineno) + ": " + yytext); }');
  replace(path.join(npa, "src/parser.y"), '#include <cstdlib>', '#include <cstdlib>\n    #include <stdexcept>');
  replace(path.join(npa, "src/parser.y"), '%nonassoc TLESS TGREATER TEQUALEQUAL TNEQUAL TGEQUAL TLEQUAL\n%left TOR\n%left TAND',
    '%left TOR\n%left TAND\n%nonassoc TLESS TGREATER TEQUALEQUAL TNEQUAL TGEQUAL TLEQUAL');
  replace(path.join(npa, "src/parser.y"), 'arg : TDOLLAR TIDENTIFIER',
    'arg : TDOLLAR { $$ = new Argument("$", ARG_STRING); }\n      | THASH { $$ = new Argument("#", ARG_STRING); }\n      | TDOLLAR TIDENTIFIER');
  replace(path.join(npa, "src/parser.y"), 'expr : arg { $<arg>$ = $1; }',
    'expr : arg { $<arg>$ = $1; }\n     | TLPAREN expr TRPAREN { $$ = $2; }');
  replace(path.join(npa, "src/parser.y"), 'array : TDOLLAR TIDENTIFIER TLABRACE arg TRABRACE',
    'array : TDOLLAR TIDENTIFIER TLABRACE expr TRABRACE');
  replace(path.join(npa, "src/parser.y"), '| THASH TIDENTIFIER TLABRACE arg TRABRACE',
    '| THASH TIDENTIFIER TLABRACE expr TRABRACE');
  replace(path.join(npa, "src/parser.y"), '| array TLABRACE arg TRABRACE',
    '| array TLABRACE expr TRABRACE');
  replace(path.join(npa, "src/nsscompiler.hpp"), '    string ArrayData;\n    ArgumentList Arguments;',
    '    string ArrayData;\n    ExpressionList Arguments;');
  // Older NSS spells literal choice handles with an optional colon. The @
  // belongs to the stored object name here, rather than a numeric expression.
  replace(path.join(npa, "src/parser.y"), '     | TCASE TIDENTIFIER TCOLON block { $$ = new Case(*$2, $4); delete $2; }',
    '     | TCASE TIDENTIFIER TCOLON block { $$ = new Case(*$2, $4); delete $2; }\n     | TCASE TIDENTIFIER block { $$ = new Case(*$2, $3); delete $2; }\n     | TCASE TAT TIDENTIFIER TCOLON block { $$ = new Case("@" + *$3, $5); delete $3; }\n     | TCASE TAT TIDENTIFIER block { $$ = new Case("@" + *$3, $4); delete $3; }');
  replace(path.join(npa, "src/parser.y"), 'call : arg TLPAREN func_exps TRPAREN TSEMICOLON { $$ = new CallStatement($1, *$3, MAGIC_CALL_FUNCTION); delete $3; }',
    'call : arg TLPAREN func_exps TRPAREN TSEMICOLON { $$ = new CallStatement($1, *$3, MAGIC_CALL_FUNCTION); delete $3; }\n     | arg TLPAREN func_exps TRPAREN TCOLON { $$ = new CallStatement($1, *$3, MAGIC_CALL_FUNCTION); delete $3; }');
  // Case::Compile constructs an Argument, which performs the CP932 conversion.
  // Converting here as well corrupts Japanese choice handles before lookup.
  replace(path.join(npa, "src/nsscompiler.hpp"),
    'Case(const string& Name, Block* CaseBlock) : Name(NpaFile::FromUtf8(Name)), CaseBlock(CaseBlock) {}',
    'Case(const string& Name, Block* CaseBlock) : Name(Name), CaseBlock(CaseBlock) {}');
  // Older authored sources contain else[ ... } blocks. Accept that spelling
  // only in an else clause; array brackets retain their expression meaning.
  replace(path.join(npa, "src/parser.y"), '     | TIF TLPAREN expr TRPAREN block TELSE block { $$ = new If($5, $3, $7); }',
    '     | TIF TLPAREN expr TRPAREN block TELSE block { $$ = new If($5, $3, $7); }\n     | TIF TLPAREN expr TRPAREN block TELSE TLABRACE stmts TRBRACE { $$ = new If($5, $3, $8); }\n     | TIF TLPAREN expr TRPAREN block TELSE TLABRACE TRBRACE { $$ = new If($5, $3, new Block()); }');
  replace(path.join(npa, "src/parser.y"), 'stmt : call | cond',
    'stmt : call | cond\n     | arg TEQUAL expr { $$ = new Assignment($1, $3, MAGIC_ASSIGN); }\n     | arg TMUL TEQUAL expr TSEMICOLON { if ($1->Type == ARG_ARRAY) throw std::runtime_error("Compound NSS array multiplication is unimplemented"); $$ = new Assignment($1, new BinaryOperator(new Argument(*$1), MAGIC_MUL_EXPRESSION, $4), MAGIC_ASSIGN); }\n     | arg TDIV TEQUAL expr TSEMICOLON { if ($1->Type == ARG_ARRAY) throw std::runtime_error("Compound NSS array division is unimplemented"); $$ = new Assignment($1, new BinaryOperator(new Argument(*$1), MAGIC_DIV_EXPRESSION, $4), MAGIC_ASSIGN); }');
  replace(path.join(npa, "src/nsscompiler.cpp"), '    YY_BUFFER_STATE buffer = yy_scan_bytes(pBuffer, Length);',
    '    extern int yylineno;\n    ::yylineno = 1;\n    YY_BUFFER_STATE buffer = yy_scan_bytes(pBuffer, Length);');
  replace(path.join(npa, "src/nsscompiler.cpp"), 'extern Program* pRoot;', 'extern Program* pRoot;\nextern int yylineno;');
  const interpreter = path.join(engine, "src/NSBInterpreter.cpp");
  replace(interpreter, 'Fmt % GetString("#SYSTEM_save_path");', 'Fmt % std::string(std::getenv("MACLAUNCHER_NPENGINE_SAVE_DIR"));');
  replace(interpreter, '#include <algorithm>', '#include <algorithm>\n#include <cstdlib>\n#include <stdexcept>');
  replace(interpreter, '        NSB_ERROR("Failed to call function", Symbol);',
    '        throw std::runtime_error("Unimplemented native NSS function: " + Symbol);');
  replace(interpreter, '    CallFunction_(pContext, pContext->GetParam(0));',
    '    /* Direct3D is absent on this native OpenGL host. Report the actual\n     * capability rather than invoking a missing Windows helper. */\n    if (pContext->GetParam(0) == "EnableDirect3DHAL") { PushInt(0); return; }\n    CallFunction_(pContext, pContext->GetParam(0));');
  // Authored text helpers select LoadText and its window using the PRE box.
  // Keep that context alongside the text handle before those helpers execute.
  replace(interpreter, '    SetString("$SYSTEM_present_text", Handle);',
    '    SetString("$SYSTEM_present_preprocess", Box);\n    SetString("$SYSTEM_present_text", Handle);');
  replace(interpreter, '        PushInt(stoi(Val));', '        PushInt(stoi(Val, nullptr, Val.size() > 2 && Val[0] == \'0\' && (Val[1] == \'x\' || Val[1] == \'X\') ? 16 : 10));');
  replace(interpreter, '        Color = stoi(to_string(pVar->ToInt()), nullptr, 16) | (0xFF << 24);',
    '        Color = static_cast<uint32_t>(pVar->ToInt()) | 0xff000000u;');
  // Missing portable files are ordinary on first launch. Original ReadFile
  // passed an uninitialized size into the XOR decoder in that case.
  replace(interpreter, '    NpaFile::Decrypt(pData, Size);', '    if (!pData) { PushString(""); return; }\n    NpaFile::Decrypt(pData, Size);');
  replace(interpreter, '    Npa::Buffer SaveData(NpaFile::Decrypt(pData, Size), Size);',
    '    if (!pData) throw std::runtime_error("Nitroplus save slot is missing");\n    Npa::Buffer SaveData(NpaFile::Decrypt(pData, Size), Size);');
  replace(path.join(engine, "src/ResourceMgr.cpp"), '    for (const string& i : pScript->GetIncludes())\n        GetScriptFile(i);\n\n    CacheHolder.Write(Path, pScript);',
    '    if (!pScript) return nullptr;\n    CacheHolder.Write(Path, pScript);\n    for (const string& i : pScript->GetIncludes())\n        GetScriptFile(i);');
  replace(path.join(engine, "src/ResourceMgr.cpp"), '#include <glib.h>', '#include <glib.h>\n#include <iostream>');
  replace(path.join(engine, "src/Playable.cpp"), '#include <thread>', '#include <thread>\n#include <iostream>');
  replace(path.join(engine, "src/Image.cpp"), '#include "Image.hpp"', '#include "Image.hpp"\n#include <iostream>');
  // libjpeg fixes output_components during start_decompress, so choose the
  // four-byte pixel format before that call rather than uploading RGB rows as RGBA.
  replace(path.join(engine, "src/Image.cpp"), '    jpeg_start_decompress(&jpeg);',
    '    jpeg.out_color_space = JCS_EXT_RGBA;\n    jpeg_start_decompress(&jpeg);');
  replace(path.join(engine, "src/Image.cpp"), '    Height = jpeg.output_height;\n    jpeg.out_color_space = JCS_EXT_RGBX;',
    '    Height = jpeg.output_height;');
  const text = path.join(engine, "src/Text.cpp");
  replace(text, '#include "Text.hpp"', '#include "Text.hpp"\n#include "text-markup.hpp"');
  replace(text, '    ::pText = this;\n    YY_BUFFER_STATE buffer = yy_scan_bytes(XML.c_str(), XML.size());\n    yyparse();\n    yy_delete_buffer(buffer);',
    '    Lines = NativeText::parse(XML).Lines;\n    Index = 0;');
  replace(text, 'Color(dInColor)', 'Color(dInColor | 0xff000000u)');
  replace(text, '    this->Color = Color;', '    this->Color = Color | 0xff000000u;');
  replace(text, '    pango_layout_set_width(Layout, LayoutWidth * PANGO_SCALE);',
    '    pango_layout_set_width(Layout, LayoutWidth == size_t(-1) ? -1 : static_cast<int>(LayoutWidth) * PANGO_SCALE);');
  replace(text, '    PangoFontDescription* Desc = pango_font_description_from_string("Sans 18");',
    '    PangoFontDescription* Desc = pango_font_description_from_string(dFont.empty() ? "Sans" : dFont.c_str());');
  replace(text, '    pango_font_description_set_weight(Desc, PANGO_WEIGHT_MEDIUM);',
    '    pango_font_description_set_weight(Desc, static_cast<PangoWeight>(dWeight));');
  replace(text, '    cairo_set_source_rgba(RenderContext, Color & 0xFF, (Color >> 8) & 0xFF, (Color >> 16) & 0xFF, Color >> 24);',
    '    cairo_set_source_rgba(RenderContext, (Color & 0xFF) / 255.0, ((Color >> 8) & 0xFF) / 255.0, ((Color >> 16) & 0xFF) / 255.0, (Color >> 24) / 255.0);');
  replace(text, '    Create(pData, GL_RGBA, Width, Height);', '    Create(pData, GL_BGRA, Width, Height);');
  replace(path.join(engine, "src/NSBDebugger.cpp"), '#include "NSBInterpreter.hpp"', '#include "NSBInterpreter.hpp"\n#include <iostream>');
  adaptObjectSources(engine);
  replace(path.join(engine, "src/Window.cpp"), '    SDL_Init(SDL_INIT_VIDEO);',
    '    if (SDL_Init(SDL_INIT_VIDEO) != 0) throw std::runtime_error(SDL_GetError());');
  replace(path.join(engine, "src/Window.cpp"), '    GLContext = SDL_GL_CreateContext(SDLWindow);',
    '    if (!SDLWindow) throw std::runtime_error(SDL_GetError());\n    GLContext = SDL_GL_CreateContext(SDLWindow);\n    if (!GLContext) throw std::runtime_error(SDL_GetError());');
  replace(path.join(engine, "src/Window.cpp"), '#include <iostream>', '#include <iostream>\n#include <stdexcept>');
  replace(path.join(engine, "src/Window.cpp"), '    if (Event.type == SDL_NSB_MOVECURSOR)',
    '    if (Event.type == SDL_QUIT || (Event.type == SDL_KEYDOWN && (Event.key.keysym.mod & KMOD_GUI) && Event.key.keysym.sym == SDLK_q)) { Exit(); return; }\n    if (Event.type == SDL_NSB_MOVECURSOR)');
  ChoiceOverlay.adaptChoiceObjects(engine);
  ChoiceOverlay.adaptChoiceFocus(engine);
  fs.copyFileSync(path.join(__dirname, "native/CMakeLists.txt"), path.join(root, "CMakeLists.txt"));
  for (const file of ["main.cpp", "private-files.cpp", "text-markup.cpp", "text-markup.hpp"]) fs.copyFileSync(path.join(__dirname, "native", file), path.join(root, file));
}

async function buildRuntime({ manager, version = VERSION, sourceDir = sourcePath, npaSourceDir = npaSourcePath, userDataDir,
  signal, logger, onProgress, dependencies = {} } = {}) {
  throwIfAborted(signal);
  if (process.platform !== "darwin") throw new Error("libnpengine source builds require macOS.");
  const normalized = manager.core.normalizeVersion(version);
  if (normalized !== VERSION) throw new Error("Choose libnpengine 0.5.3 Mac v7 for the current reviewed source-build adapter; older registered versions remain separate.");
  const directory = manager.core.getInstallDir({ userDataDir, version: normalized });
  if (building.has(directory)) throw new Error("This libnpengine version is already building.");
  if (fs.existsSync(path.join(directory, "runtime.json"))) throw new Error("Remove the current runtime registration before rebuilding.");
  for (const source of [sourceDir, npaSourceDir]) {
    if (!path.isAbsolute(source) || source === directory || source.startsWith(directory + path.sep) || directory.startsWith(source + path.sep)) throw new Error("Nitroplus source and runtime directories must be separate.");
  }
  building.add(directory); let lock;
  try {
    const [engineSource, npaSource] = await Promise.all([Build.validatePinnedSource(sourceDir, REVISION, { signal }), Build.validatePinnedSource(npaSourceDir, NPA_REVISION, { signal })]);
    const tool = dependencies.findBuildTool || Build.findBuildTool, cmake = tool("cmake"), ninja = tool("ninja"), pkg = tool("pkg-config");
    const flex = ["/opt/homebrew/opt/flex/bin/flex", "/usr/local/opt/flex/bin/flex"].find(file => fs.existsSync(file)) || tool("flex");
    const bison = ["/opt/homebrew/opt/bison/bin/bison", "/usr/local/opt/bison/bin/bison"].find(file => fs.existsSync(file)) || tool("bison");
    fs.mkdirSync(directory, { recursive: true }); lock = fs.openSync(path.join(directory, "build.lock"), "wx");
    const staged = path.join(directory, "build-source"), output = path.join(directory, "build-output"), payload = path.join(directory, "payload");
    for (const folder of [staged, output, payload]) fs.rmSync(folder, { recursive: true, force: true });
    const engineTreeSha256 = Build.stagePinnedFiles(sourceDir, engineSource.files, path.join(staged, "libnpengine"));
    const npaTreeSha256 = Build.stagePinnedFiles(npaSourceDir, npaSource.files, path.join(staged, "libnpa"));
    const sourceTreeSha256 = crypto.createHash("sha256").update(engineTreeSha256).update(npaTreeSha256).digest("hex");
    adaptSource(staged);
    const overlaySha256 = crypto.createHash("sha256").update(fs.readFileSync(__filename))
      .update(fs.readFileSync(path.join(__dirname, "native/CMakeLists.txt")))
      .update(fs.readFileSync(path.join(__dirname, "native/main.cpp")))
      .update(fs.readFileSync(path.join(__dirname, "native/private-files.cpp")))
      .update(fs.readFileSync(path.join(__dirname, "native/text-markup.cpp")))
      .update(fs.readFileSync(path.join(__dirname, "native/text-markup.hpp")))
      .update(fs.readFileSync(path.join(__dirname, "native/fontconfig.conf")))
      .update(fs.readFileSync(path.join(__dirname, "choice-overlay.js")))
      .update(fs.readFileSync(path.join(__dirname, "native/choice-state.hpp"))).digest("hex");
    const options = ["-DCMAKE_BUILD_TYPE=Release", "-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0", `-DCMAKE_CXX_FLAGS=${sourcePathFlags(directory)}`, "-DFETCHCONTENT_FULLY_DISCONNECTED=ON", "-DFETCHCONTENT_UPDATES_DISCONNECTED=ON",
      `-DCMAKE_INSTALL_PREFIX=${payload}`, `-DFLEX_EXECUTABLE=${flex}`, `-DBISON_EXECUTABLE=${bison}`, `-DCMAKE_MAKE_PROGRAM=${ninja}`];
    const logPath = path.join(directory, "build.log");
    fs.writeFileSync(logPath, `libnpengine ${VERSION}\nEngine ${REVISION}\nlibnpa ${NPA_REVISION}\nSource tree ${sourceTreeSha256}\nOverlay ${overlaySha256}\n`);
    const env = { ...process.env, MACOSX_DEPLOYMENT_TARGET: "13.0", HOMEBREW_NO_AUTO_UPDATE: "1",
      PATH: [...new Set([path.dirname(cmake), path.dirname(ninja), path.dirname(pkg), "/opt/homebrew/bin", "/usr/local/bin", ...String(process.env.PATH || "").split(path.delimiter)])].join(path.delimiter) };
    const run = dependencies.runBuildCommand || Build.runBuildCommand;
    logger?.info?.(`[runtime] build libnpengine ${normalized}; ${logPath}`); onProgress?.({ downloaded: 1, total: 4 });
    await run(cmake, ["-S", staged, "-B", output, "-G", "Ninja", ...options], { cwd: directory, env, logPath, signal });
    onProgress?.({ downloaded: 2, total: 4 });
    await run(cmake, ["--build", output, "--parallel", "6"], { cwd: directory, env, logPath, signal });
    await run(cmake, ["--install", output], { cwd: directory, env, logPath, signal });
    const pluginRoot = execFileSync(pkg, ["--variable=pluginsdir", "gstreamer-1.0"], { encoding: "utf8", timeout: 10000, env }).trim();
    if (!path.isAbsolute(pluginRoot)) throw new Error("GStreamer did not declare its native plugin directory.");
    const plugins = path.join(payload, "lib/gstreamer-1.0"); fs.mkdirSync(plugins, { recursive: true });
    for (const plugin of PLUGINS) fs.copyFileSync(fs.realpathSync(path.join(pluginRoot, `libgst${plugin}.dylib`)), path.join(plugins, `libgst${plugin}.dylib`));
    const profile = { version: VERSION, profileRevision: PROFILE_REVISION, upstreamRevision: REVISION, npaRevision: NPA_REVISION,
      sourceTreeSha256, overlaySha256, plugins: PLUGINS, formats: ["NPA v1 unencrypted", "NSS source"] };
    fs.writeFileSync(path.join(payload, "profile.json"), JSON.stringify(profile, null, 2) + "\n");
    fs.copyFileSync(path.join(__dirname, "native/fontconfig.conf"), path.join(payload, "fontconfig.conf"));
    throwIfAborted(signal); onProgress?.({ downloaded: 3, total: 4 });
    await Promise.all([Build.validatePinnedSource(sourceDir, REVISION, { signal }), Build.validatePinnedSource(npaSourceDir, NPA_REVISION, { signal })]);
    const installed = manager.core.registerLocal({ userDataDir, version: normalized, runtimePath: path.join(payload, "bin/npengine-runner"), verifiedBuild: {
      sourceRevision: REVISION, sourceTreeSha256, overlaySha256, profileRevision: PROFILE_REVISION, configureOptions: options, hostPlatform: "darwin", hostArch: process.arch,
      deploymentTarget: "13.0", logPath, npaRevision: NPA_REVISION, engineTreeSha256, npaTreeSha256 } });
    onProgress?.({ downloaded: 4, total: 4 }); return installed;
  } finally {
    if (lock !== undefined) { fs.closeSync(lock); fs.rmSync(path.join(directory, "build.lock"), { force: true }); }
    building.delete(directory);
  }
}

module.exports = { VERSION, LEGACY_VERSION, V2_VERSION, V3_VERSION, V4_VERSION, V5_VERSION, PREVIOUS_VERSION, SUPPORTED_VERSIONS, PROFILE_REVISION, REVISION, NPA_REVISION, sourcePath, npaSourcePath, PLUGINS, sourcePathFlags, adaptObjectSources, adaptSource, buildRuntime };
