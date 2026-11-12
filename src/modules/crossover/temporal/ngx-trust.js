const fs = require('node:fs'), path = require('node:path');
const { X509Certificate } = require('node:crypto');
const Bundled = require('../../shared/runtime/bundled-native');
const { readPeExports } = require('../../shared/runtime/pe-exports');

// This metadata belongs to the verified NGX package. The private key never
// leaves its build work directory; only the public certificate is installed.
function prepare(install, inspect = readPeExports) {
  const spec = install.manifest?.ngxTrust;
  if (spec === undefined) return null;
  const root = install.root;
  if (!path.isAbsolute(root || '') || !spec || typeof spec !== 'object') throw Error('Invalid NGX signing declaration.');
  const resolve = name => {
    Bundled.relativeFile(spec[name]);
    const file = path.join(root, spec[name]);
    if (!fs.lstatSync(file).isFile() || fs.realpathSync(file) !== file) throw Error('NGX signing files must be regular package files.');
    return file;
  };
  const certificate = resolve('certificate'), helper = resolve('helper');
  const cert = new X509Certificate(fs.readFileSync(certificate));
  if (!cert.verify(cert.publicKey)) throw Error('The NGX signing certificate must be self-issued.');
  if (inspect(helper)?.machine !== 0x8664) throw Error('The NGX trust helper requires x64.');
  return { certificate, helper, core: install.executablePath };
}
async function apply(trust, { assertWritable, run }) {
  if (!trust) return;
  await assertWritable();
  const windows = file => 'Z:' + file.replaceAll('/', '\\');
  // The helper adds this package's public certificate only to the selected
  // Wine prefix and verifies the actual core with WinVerifyTrust, without UI
  // or network retrieval. It removes a newly added certificate on failure.
  await run([windows(trust.helper), 'install', windows(trust.certificate), windows(trust.core)]);
}
module.exports = { prepare, apply };
