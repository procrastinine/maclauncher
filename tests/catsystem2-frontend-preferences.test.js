const test = require("node:test"), assert = require("node:assert/strict");
const { parseXml } = require("../src/modules/catsystem2/startup"), { defaultRecords } = require("../src/modules/catsystem2/runtime/preferences");
const { createFrontEndPreferences } = require("../src/modules/catsystem2/runtime/frontend-preferences");
const bytes = Buffer.from("<document><language><default>0</default><L00><prefix>en</prefix><code>1033</code></L00><L01><prefix>jp</prefix><code>1041</code></L01></language></document>");
test("FES language preferences use native fresh defaults, exact authored locale IDs and isolated real changes", async () => {
  const originals = Buffer.from(bytes), events = [], records = defaultRecords({ engineVersion: "2.6.1.76" });
  const prefs = createFrontEndPreferences({ engineVersion: "2.6.1.76", records, document: parseXml(bytes), onLanguageChange: event => events.push(event) });
  assert.equal(prefs.get("lang_ui"), 0); assert.equal(prefs.get("lang_text_main"), 0); assert.equal(prefs.get("lang_text_sub"), -1); assert.equal(prefs.language, "en");
  await prefs.set("lang_ui",1); assert.equal(prefs.language,"jp"); assert.equal(prefs.get("lang_text_main"),0); assert.deepEqual(events,[{field:"lang_ui",index:1,prefix:"jp"}]);
  assert.equal(prefs.get("stillread"),1); await prefs.set("stillread",0); assert.equal(records.records[1].bytes.readUInt32LE(20),0); assert.equal(prefs.get("stillread"),0); assert.equal(records.records[1].bytes.readUInt32LE(8),0);
  assert.equal(prefs.get("dragwnd"),0); assert.equal(prefs.get("wndframe"),1); await prefs.set("dragwnd",1);
  assert.equal(records.records[2].bytes.readInt32LE(4),1); assert.equal(records.records[2].bytes.readInt32LE(8),1);
  assert.equal(prefs.get("wndcolor"),0); await prefs.set("wndcolor",0x64aabbcc);
  assert.equal(prefs.get("wndcolor"),0x64aabbcc); assert.equal(records.records[2].bytes.readInt32LE(4),1); assert.equal(records.records[2].bytes.readInt32LE(8),1);
  const localized = createFrontEndPreferences({ engineVersion: "2.6.1.76", records: defaultRecords({ engineVersion: "2.6.1.76" }), document: parseXml(bytes), userLanguageCode:1041 });
  assert.equal(localized.get("lang_ui"),1); assert.equal(localized.get("lang_text_sub"),-1); assert.deepEqual(bytes,originals);
  for (const [name,value,args] of [["lang_ui",-1,[]],["lang_text_sub",2,[]],["stillread",2,[]],["dragwnd",2,[]],["wndcolor",0x65000000,[]],["lang_ui",0,[1]]]) await assert.rejects(prefs.set(name,value,args),/range|table|unsupported/);
  assert.throws(()=>prefs.get("unknown"),/unsupported/); assert.throws(()=>createFrontEndPreferences({ engineVersion:"2.6.1.77",records,document:parseXml(bytes)}),/version/);
});
