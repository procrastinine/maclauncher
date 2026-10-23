const fs = require("node:fs"), crypto = require("node:crypto");
const Zip = require("../../shared/runtime/zip");
const { inspectApk } = require("../apk");
const SIGNATURE_IDS = [0x1b93ad61, 0xf05368c0, 0x7109871a];

function prefix(bytes, at = 0) {
  if (bytes.length - at < 4) throw new Error("The APK signing record is incomplete.");
  const length = bytes.readUInt32LE(at); at += 4;
  if (length > bytes.length - at) throw new Error("The APK signing record is invalid.");
  return { bytes: bytes.subarray(at, at + length), next: at + length };
}
function sequence(bytes) {
  const values = [];
  for (let at = 0; at < bytes.length;) {
    if (bytes.length - at < 4) throw new Error("The APK signing record is incomplete.");
    const length = bytes.readUInt32LE(at); at += 4;
    if (!length || length > bytes.length - at) throw new Error("The APK signing record is invalid.");
    values.push(bytes.subarray(at, at + length)); at += length;
  }
  return values;
}

// The publisher's SHA-256 authenticates the complete APK, including this signer
// block. Arbitrary game APKs need the provider's real package signature verifier;
// this reader alone never treats an unverified certificate as trusted identity.
function signingCertificates(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const eocd = Zip.findZipEocd(fd);
    if (!eocd || eocd.cdOffset < 32) throw new Error("The APK signing block is missing.");
    const footer = Buffer.alloc(24); fs.readSync(fd, footer, 0, 24, eocd.cdOffset - 24);
    if (!footer.subarray(8).equals(Buffer.from("APK Sig Block 42"))) throw new Error("The APK signing block is missing.");
    const size = Number(footer.readBigUInt64LE(0));
    if (!Number.isSafeInteger(size) || size < 24 || size > 16 * 1024 * 1024 || size + 8 > eocd.cdOffset)
      throw new Error("The APK signing block is invalid.");
    const block = Buffer.alloc(size + 8); fs.readSync(fd, block, 0, block.length, eocd.cdOffset - block.length);
    if (Number(block.readBigUInt64LE(0)) !== size) throw new Error("The APK signing block length differs.");
    const certificates = new Set(), schemes = new Map();
    for (let at = 8; at < block.length - 24;) {
      const length = Number(block.readBigUInt64LE(at)); at += 8;
      if (!Number.isSafeInteger(length) || length < 4 || length > block.length - 24 - at)
        throw new Error("The APK signer length is invalid.");
      const id = block.readUInt32LE(at), value = block.subarray(at + 4, at + length); at += length;
      if (!SIGNATURE_IDS.includes(id)) continue;
      if (schemes.has(id)) throw new Error("The APK signing scheme is ambiguous.");
      schemes.set(id, value);
    }
    const value = schemes.get(SIGNATURE_IDS.find(id => schemes.has(id)));
    if (value) {
      for (const signer of sequence(prefix(value).bytes)) {
        const signed = prefix(signer).bytes, digests = prefix(signed), certificatesField = prefix(signed, digests.next);
        // Android identifies each signer by its leaf, rather than by additional
        // CA-chain certificates or an older signing scheme's rotation fallback.
        const certificate = new crypto.X509Certificate(sequence(certificatesField.bytes)[0]);
        certificates.add(crypto.createHash("sha256").update(certificate.raw).digest("hex"));
      }
    }
    if (!certificates.size) throw new Error("The APK has no supported signing certificate.");
    return [...certificates].sort();
  } finally { fs.closeSync(fd); }
}

function verifyPublishedApk(file, pin) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let digest;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size !== pin.bytes) throw new Error("The microG package size differs from its release.");
    const hash = crypto.createHash("sha256"), buffer = Buffer.alloc(1024 * 1024);
    for (;;) { const count = fs.readSync(fd, buffer, 0, buffer.length); if (!count) break; hash.update(buffer.subarray(0, count)); }
    digest = hash.digest("hex");
    if (digest !== pin.sha256) throw new Error("The microG package checksum differs from its release.");
  } finally { fs.closeSync(fd); }
  const metadata = inspectApk(file, { requireLauncher: false });
  if (metadata.packageName !== pin.packageName || metadata.versionCode !== pin.versionCode || metadata.split !== null)
    throw new Error("The microG package identity differs from its release.");
  const signers = signingCertificates(file);
  if (pin.signers && JSON.stringify(signers) !== JSON.stringify([...pin.signers].sort()))
    throw new Error("The microG signing certificate differs from its selected release.");
  return { packageName: metadata.packageName, versionCode: metadata.versionCode, sha256: digest, signers };
}
module.exports = { signingCertificates, verifyPublishedApk };
