const fs = require('node:fs');
const path = require('node:path');
const B = require('../../shared/runtime/bundled-native');

const OPTIONAL_TESTS = Object.freeze([
  'Contents/Resources/GUIScripts/test/Start.py',
  'Contents/Resources/GUIScripts/test/Autodetect.py',
  'Contents/Resources/GUIScripts/demo/Tests.py'
]);
// Called only on a disposable build/export, before the bundle is signed.
function omitOptionalTests(appRoot) {
  if (!B.realDirectory(appRoot)) throw new Error('GemRB bundle is missing.');
  const entries = OPTIONAL_TESTS.flatMap(relative => {
    const file = path.join(appRoot, relative);
    if (!B.realDirectory(path.dirname(file))) return [];
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat) return [];
    const record = B.readRegular(file, 1024 * 1024);
    return [{ path: relative, sha256: record.sha256, size: record.size }];
  });
  for (const entry of entries) fs.unlinkSync(path.join(appRoot, entry.path));
  const testDirectory = path.join(appRoot, 'Contents/Resources/GUIScripts/test');
  if (fs.existsSync(testDirectory) && fs.readdirSync(testDirectory).length === 0) fs.rmdirSync(testDirectory);
  return entries;
}
module.exports = { OPTIONAL_TESTS, omitOptionalTests };
