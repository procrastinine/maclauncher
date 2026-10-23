const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const test = require("node:test");
const Build = require("../src/modules/nitroplus/runtime/build");
const Pinned = require("../src/modules/shared/runtime/pinned-native-build");

const prefix = ["/opt/homebrew", "/usr/local"].find(root => fs.existsSync(path.join(root, "include/boost/locale.hpp")));
const flex = prefix && path.join(prefix, "opt/flex/bin/flex");
const bison = prefix && path.join(prefix, "opt/bison/bin/bison");
const available = process.platform === "darwin" && prefix && fs.existsSync(flex) && fs.existsSync(bison) &&
  fs.existsSync(path.join(Build.sourcePath, "include/Object.hpp")) && fs.existsSync(path.join(Build.npaSourcePath, "src/parser.y"));

test("the pinned Nitroplus native compiler and object overlay preserve semantics and reject incomplete inputs", {
  skip: available ? false : "Requires macOS, initialized pinned sources, and local Boost/Flex/Bison development dependencies"
}, async t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "nitroplus-native-regression-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stage = path.join(root, "source"), generated = path.join(root, "generated");
  for (const [source, revision, relative] of [[Build.sourcePath, Build.REVISION, "libnpengine"], [Build.npaSourcePath, Build.NPA_REVISION, "libnpa"]]) {
    const verified = await Pinned.validatePinnedSource(source, revision);
    Pinned.stagePinnedFiles(source, verified.files, path.join(stage, relative));
  }
  Build.adaptSource(stage);
  fs.mkdirSync(generated);
  const npa = path.join(stage, "libnpa"), engine = path.join(stage, "libnpengine");
  execFileSync(bison, ["--defines=" + path.join(generated, "parser.hpp"), "-o", path.join(generated, "parser.cpp"), path.join(npa, "src/parser.y")], { stdio: ["ignore", "pipe", "pipe"] });
  execFileSync(flex, ["-o", path.join(generated, "lexer.cpp"), path.join(npa, "src/lexer.l")], { stdio: ["ignore", "pipe", "pipe"] });
  const driver = path.join(root, "driver.cpp"), executable = path.join(root, "driver");
  fs.writeFileSync(driver, `#include "Name.hpp"
#include "scriptfile.hpp"
#include <cassert>
#include <fstream>
#include <iostream>
#include <iterator>
#include <stdexcept>
int main(int argc, char** argv) {
  try {
    if (argc == 1) {
      ObjectHolder_t objects;
      assert(objects.Read("missing/child") == nullptr);
      assert(objects.Read("@missing/child") == nullptr);
      assert(objects.Read("") == nullptr);
      objects.Execute("", [](Object**) { assert(false); });
      objects.Execute("missing/*", [](Object**) { assert(false); });
      objects.Write("menu", new Name);
      objects.Write("menu/MouseLeave", new Name);
      auto child = new Name;
      objects.Write("menu/MouseLeave/process", child);
      objects.WriteAlias("menu", "button");
      assert(objects.Read("@button/MouseLeave/process") == child);
      bool refused = false;
      try { objects.Write("missing/process", nullptr); }
      catch (const std::runtime_error&) { refused = true; }
      assert(refused);
      objects.WriteAlias("@cycle", "cycle");
      refused = false;
      try { objects.Read("@cycle"); }
      catch (const std::runtime_error&) { refused = true; }
      assert(refused);
      objects.Delete("menu/MouseLeave/process");
      assert(objects.Read("menu/MouseLeave/process") == nullptr);
      std::cout << "object guards passed\\n";
      return 0;
    }
    std::ifstream file(argv[1], std::ios::binary);
    std::string input((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
    NpaFile::SetLocale("ja_JP.CP932");
    ScriptFile script("fixture.nss", input.data(), input.size());
    for (uint32_t line = 0; auto item = script.GetLine(line); ++line)
      std::cout << item->Stringify() << '\\n';
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\\n';
    return 1;
  }
}
`);
  const sources = ["npafile.cpp", "inpafile.cpp", "nsbmagic.cpp", "scriptfile.cpp", "nsbconstants.cpp", "nsscompiler.cpp", "buffer.cpp"];
  execFileSync("/usr/bin/clang++", ["-std=c++17", "-mmacosx-version-min=13.0", "-DFLEX_VERSION_MAJOR=2", "-DFLEX_VERSION_MINOR=6", "-DFLEX_VERSION_PATCH=4",
    ...[path.join(npa, "include"), path.join(npa, "src"), path.join(engine, "include"), generated, path.join(prefix, "include")].map(root => "-I" + root),
    driver, ...sources.map(file => path.join(npa, "src", file)), path.join(stage, "private-files.cpp"), path.join(generated, "lexer.cpp"), path.join(generated, "parser.cpp"),
    "-L" + path.join(prefix, "lib"), "-lboost_locale", "-lz", "-o", executable], { timeout: 60000, stdio: ["ignore", "pipe", "pipe"] });
  let index = 0;
  const compile = input => {
    const file = path.join(root, "fixture-" + index++ + ".nss");
    fs.writeFileSync(file, input);
    return spawnSync(executable, [file], { encoding: "utf8", timeout: 10000 });
  };
  const successful = input => {
    const result = compile(input);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };

  await t.test("native object lookups, nested aliases and missing writes are bounded", () => {
    assert.equal(execFileSync(executable, [], { encoding: "utf8", timeout: 10000 }).trim(), "object guards passed");
  });
  await t.test("grouped arithmetic, variable division and array indices emit the expected operations", () => {
    const output = successful("chapter main { $a=8; $b=2; $x=($a+$b)*3/$b; $v=$array[$a+1]; $a*=2; $a/=2; }");
    const names = output.split("\n").map(line => line.slice(0, line.indexOf("(")));
    assert.ok(names.indexOf("AddExpression") < names.indexOf("MulExpression"));
    assert.ok(names.indexOf("MulExpression") < names.indexOf("DivExpression"));
    assert.equal(names.filter(name => name === "SubScript").length, 1);
    assert.equal(names.filter(name => name === "MulExpression").length, 2);
    assert.equal(names.filter(name => name === "DivExpression").length, 2);
  });
  await t.test("comparison and logical precedence agrees with explicit grouping", () => {
    const automatic = successful("chapter main { if($a==1 && $b==2 || $c==3){ WaitKey(); } }");
    const explicit = successful("chapter main { if((($a==1) && ($b==2)) || ($c==3)){ WaitKey(); } }");
    assert.equal(automatic, explicit);
  });
  await t.test("legacy else bracket blocks retain ordinary else bytecode", () => {
    const ordinary = successful("chapter main { if($a){ WaitKey(); }else{ Wait(10); } }");
    assert.equal(successful("chapter main { if($a){ WaitKey(); }else[ Wait(10); } }"), ordinary);
    assert.equal(successful("chapter main { if($a){}else[} }"), successful("chapter main { if($a){}else{} }"));
  });
  await t.test("separate text blocks and literal choice handles are retained", () => {
    const output = successful('chapter main { <PRE box>[alpha]alpha</PRE> <PRE box>[beta]beta</PRE> select { case @button { WaitKey(); } } }');
    assert.equal(output.split("\n").filter(line => line.startsWith("ParseText(")).length, 2);
    assert.match(output, /Case\(@button,/);
  });
  await t.test("Japanese choice cases retain the exact created handle through CP932 bytecode", () => {
    const output = successful('chapter main { CreateChoice("選択肢"); select { case 選択肢: { WaitKey(); } case @タイトル_スタート { Wait(10); } } }');
    assert.match(output, /CreateChoice\(選択肢\)/);
    assert.match(output, /Case\(選択肢,/);
    assert.match(output, /CaseEnd\(選択肢\)/);
    assert.match(output, /Case\(@タイトル_スタート,/);
    assert.match(output, /CaseEnd\(@タイトル_スタート\)/);
  });
  await t.test("unsupported tokens and unterminated text cannot produce partial success", () => {
    const unknown = compile("chapter main { WaitKey(); }\n?unfinished");
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /Unknown NSS token at line 2/);
    const unterminated = compile("chapter main { WaitKey(); }\n<PRE box>unfinished");
    assert.equal(unterminated.status, 1);
    assert.match(unterminated.stderr, /Unterminated NSS text block/);
  });
  for (const [source, revision] of [[Build.sourcePath, Build.REVISION], [Build.npaSourcePath, Build.NPA_REVISION]])
    await Pinned.validatePinnedSource(source, revision);
});
