const BinaryArch = require('../../../core/binary-arch');
const fs = require("node:fs"), path = require("node:path");
const Guards = require("./guards");

const LIMITS = Guards.limits({ sections: 96, exportNames: 8192, exportBytes: 1024 * 1024,
  readBytes: 2 * 1024 * 1024, nameBytes: 512, importDescriptors: 1024, importThunks: 16384 });

// IMAGE_EXPORT_DIRECTORY and file-backed RVAs, as defined by Microsoft's PE format.
// Export names alone are not executable-code evidence: forwarded and data exports
// remain distinct from targets in an executable section.
// importDetails adds normal/delay symbols with a separate completeness flag;
// peImports remains the direct DLL-name list. exportOrdinals adds nonzero EAT
// slots, their alias names and actual forwarder targets. API-set classification
// identifies a contract name, not a resolved implementation or availability.
function readPeExports(file, { detection, headersOnly = false, imports = false, importDetails = false, exportOrdinals = false } = {}) {
  let fd;
  try {
    const stat = detection?.stat ? detection.stat(file) : fs.statSync(file);
    if (!stat?.isFile() || stat.size < 64 || fs.lstatSync(file).isSymbolicLink()) return null;
    let bytesRead = 0;
    const ranges = [];
    function read(offset, size) {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset > stat.size - size)
        throw new Error("PE export range is outside the file.");
      const cached = ranges.find(range => offset >= range.offset && offset + size <= range.offset + range.bytes.length);
      if (cached) return cached.bytes.subarray(offset - cached.offset, offset - cached.offset + size);
      if ((bytesRead += size) > LIMITS.readBytes) throw new Error("PE export metadata exceeds its read limit.");
      let bytes;
      if (detection?.readBytes) bytes = detection.readBytes(file, offset, size);
      else {
        fd ??= fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        bytes = Buffer.alloc(size);
        if (fs.readSync(fd, bytes, 0, size, offset) !== size) throw new Error("Truncated PE export metadata.");
      }
      if (!Buffer.isBuffer(bytes) || bytes.length !== size) throw new Error("Truncated PE export metadata.");
      if (ranges.length < 64) ranges.push({ offset, bytes });
      return bytes;
    }
    const dos = read(0, 64);
    if (dos.readUInt16LE(0) !== 0x5a4d) return null;
    const peOffset = dos.readUInt32LE(60);
    if (peOffset < 64 || peOffset > Guards.limit(1024 * 1024)) return null;
    const coff = read(peOffset, 24);
    if (coff.readUInt32LE(0) !== 0x4550) return null;
    const facts = BinaryArch.peHeaderFacts(coff);
    const architecture = ["i386", "x86_64", "arm64"].includes(facts.declaredArchitecture) ? (facts.declaredArchitecture === "i386" ? "x86" : facts.declaredArchitecture) : null;
    const count = facts.sectionCount, optionalBytes = facts.optionalBytes;
    if (!architecture || !(facts.characteristics & 2) || !count || count > LIMITS.sections || optionalBytes < 104 || optionalBytes > Guards.limit(4096)) return null;
    const optional = read(peOffset + 24, optionalBytes), magic = optional.readUInt16LE(0);
    const directories = magic === 0x10b ? 96 : magic === 0x20b ? 112 : null;
    if (!directories || (architecture === "x86") !== (magic === 0x10b) || directories + 8 > optional.length) return null;
    const directoryCount = optional.readUInt32LE(directories - 4);
    if (!directoryCount || directoryCount > 64 || directories + directoryCount * 8 > optional.length) return null;
    const table = read(peOffset + 24 + optionalBytes, count * 40), sections = [];
    for (let i = 0; i < count; i++) {
      const start = i * 40, offset = table.readUInt32LE(start + 20), size = table.readUInt32LE(start + 16);
      if (offset > stat.size - size) return null;
      sections.push({ name: table.toString("ascii", start, start + 8).replace(/\0.*$/, ""),
        rva: table.readUInt32LE(start + 12), offset, size, executable: Boolean(table.readUInt32LE(start + 36) & 0x20000000) });
    }
    const builtin = peOffset >= 80 && read(64, Math.min(64, peOffset - 64)).includes(Buffer.from('Wine builtin DLL\0'));
    const header = { architecture, machine: facts.machineCode, format: 'pe', form: builtin ? 'builtin' : 'native',
      isDll: Boolean(facts.characteristics & 0x2000), sections };
    function fileOffset(rva, size) {
      if (!Number.isSafeInteger(rva) || !Number.isSafeInteger(size) || rva < 0 || rva > 0xffffffff || size < 0 || size > 0x100000000 - rva)
        throw new Error('PE metadata RVA range is invalid.');
      const section = sections.find(row => rva >= row.rva && rva - row.rva <= row.size && size <= row.size - (rva - row.rva));
      if (!section) throw new Error("PE export RVA is not file-backed.");
      return section.offset + rva - section.rva;
    }
    function nameAt(rva, maximum = LIMITS.nameBytes) {
      const offset = fileOffset(rva, 1), section = sections.find(row => offset >= row.offset && offset < row.offset + row.size);
      const bytes = read(offset, Math.min(maximum, LIMITS.nameBytes, section.offset + section.size - offset)), end = bytes.indexOf(0);
      if (end <= 0 || bytes.subarray(0, end).some(byte => byte < 0x20 || byte > 0x7e)) throw Error('Invalid PE metadata name.');
      return bytes.toString('ascii', 0, end);
    }
    const moduleClass = name => /^(?:api|ext)-ms-/i.test(name) ? 'api-set' : 'library';
    if (imports || importDetails) {
      // These facts cover declared direct imports, not dynamic library loading.
      header.peImports = []; header.importsComplete = true;
      const descriptors = [];
      try {
        const rva = directoryCount > 1 ? optional.readUInt32LE(directories + 8) : 0;
        const size = directoryCount > 1 ? optional.readUInt32LE(directories + 12) : 0;
        if (rva || size) {
          if (!rva || size < 20) throw Error('Invalid PE import directory.');
          let terminated = false;
          for (let offset = 0; offset + 20 <= size; offset += 20) {
            const descriptor = read(fileOffset(rva + offset, 20), 20);
            if (descriptor.every(byte => byte === 0)) { terminated = true; break; }
            const nameOffset = fileOffset(descriptor.readUInt32LE(12), 1);
            const section = sections.find(row => nameOffset >= row.offset && nameOffset < row.offset + row.size);
            const bytes = read(nameOffset, Math.min(LIMITS.nameBytes, section.offset + section.size - nameOffset)), end = bytes.indexOf(0);
            if (end <= 0 || bytes.subarray(0, end).some(byte => byte < 0x20 || byte > 0x7e)) throw Error('Invalid PE import name.');
            const name = path.win32.basename(bytes.toString('ascii', 0, end)).toLowerCase();
            if (!name) throw Error('Empty PE import module name.');
            if (!header.peImports.includes(name)) header.peImports.push(name);
            if (importDetails) descriptors.push({ descriptor, module: name });
          }
          if (!terminated) throw Error('PE import directory is incomplete.');
        }
      } catch (error) {
        if (error.code === 'DETECTION_LIMIT') throw error;
        header.importsComplete = false; header.importWarning = error.message;
      }
      const directComplete = header.importsComplete;
      const delayRva = directoryCount > 13 ? optional.readUInt32LE(directories + 13 * 8) : 0;
      const delayBytes = directoryCount > 13 ? optional.readUInt32LE(directories + 13 * 8 + 4) : 0;
      if (delayRva || delayBytes) {
        header.importsComplete = false;
        header.importWarning = [header.importWarning, 'Direct DLL-name inspection excludes the delay-import directory.'].filter(Boolean).join(' ');
      }
      if (importDetails) {
        header.peImportDetails = []; header.importDetailsComplete = true;
        try {
          if (!directComplete) throw Error('PE import descriptors are incomplete.');
          const width = magic === 0x20b ? 8 : 4, ordinalFlag = 1n << BigInt(width * 8 - 1);
          const imageBase = width === 8 ? optional.readBigUInt64LE(24) : BigInt(optional.readUInt32LE(28));
          let descriptorCount = 0, thunkCount = 0;
          function toRva(value, va) {
            const address = BigInt(value) - (va ? imageBase : 0n);
            if (address <= 0n || address > 0xffffffffn) throw Error('PE import address is not a valid RVA.');
            return Number(address);
          }
          function thunks(lookup, iat, va) {
            if (!lookup || !iat) throw Error('PE import thunk table is missing.');
            const symbols = [];
            for (let index = 0; ; index++) {
              const bytes = read(fileOffset(lookup + index * width, width), width);
              const value = width === 8 ? bytes.readBigUInt64LE() : BigInt(bytes.readUInt32LE());
              if (!value) {
                // A bound IAT may hold addresses, but its matching terminator and
                // complete file-backed range must still exist on disk.
                const end = read(fileOffset(iat, (index + 1) * width) + index * width, width);
                if (end.some(byte => byte !== 0)) throw Error('PE import address table has no matching terminator.');
                return symbols;
              }
              if (++thunkCount > LIMITS.importThunks) throw Error('PE import thunks exceed their limit.');
              if (value & ordinalFlag) {
                if (value & ~(ordinalFlag | 0xffffn)) throw Error('PE import ordinal has reserved bits set.');
                symbols.push({ ordinal: Number(value & 0xffffn) });
              } else {
                const rva = toRva(value, va), hint = read(fileOffset(rva, 2), 2).readUInt16LE();
                symbols.push({ name: nameAt(rva + 2), hint });
              }
            }
          }
          function add(module, kind, lookup, iat, va = false) {
            if (++descriptorCount > LIMITS.importDescriptors) throw Error('PE import descriptors exceed their limit.');
            header.peImportDetails.push({ module, kind, classification: moduleClass(module), symbols: thunks(lookup || iat, iat, va) });
          }
          for (const { descriptor, module } of descriptors) add(module, 'normal', descriptor.readUInt32LE(0), descriptor.readUInt32LE(16));
          if (delayRva || delayBytes) {
            if (!delayRva || delayBytes < 32) throw Error('Invalid PE delay-import directory.');
            let terminated = false;
            for (let offset = 0; offset + 32 <= delayBytes; offset += 32) {
              const descriptor = read(fileOffset(delayRva + offset, 32), 32);
              if (descriptor.every(byte => byte === 0)) { terminated = true; break; }
              const attributes = descriptor.readUInt32LE();
              if (attributes & ~1) throw Error('Unsupported PE delay-import attributes.');
              const va = !(attributes & 1), pointer = offset => {
                const value = descriptor.readUInt32LE(offset); return value ? toRva(value, va) : 0;
              };
              const module = path.win32.basename(nameAt(pointer(4))).toLowerCase();
              if (!module) throw Error('Empty PE delay-import module name.');
              add(module, 'delay', pointer(16), pointer(12), va);
            }
            if (!terminated) throw Error('PE delay-import directory is incomplete.');
          }
        } catch (error) {
          if (error.code === 'DETECTION_LIMIT') throw error;
          header.peImportDetails = []; header.importDetailsComplete = false;
          header.importDetailsWarning = error.message;
        }
      }
    }
    if (headersOnly) return { ...header, bytesRead };
    const exportRva = optional.readUInt32LE(directories), exportBytes = optional.readUInt32LE(directories + 4);
    const exports = new Map(), ordinalExports = exportOrdinals ? new Map() : null;
    if (exportRva || exportBytes) {
      if (!exportRva || exportBytes < 40 || exportBytes > LIMITS.exportBytes) return null;
      const blobOffset = fileOffset(exportRva, exportBytes), blob = read(blobOffset, exportBytes);
      const functions = blob.readUInt32LE(20), names = blob.readUInt32LE(24);
      if (functions > LIMITS.exportNames || names > LIMITS.exportNames || names && !functions) return null;
      const addresses = functions ? read(fileOffset(blob.readUInt32LE(28), functions * 4), functions * 4) : Buffer.alloc(0);
      const nameAddresses = names ? read(fileOffset(blob.readUInt32LE(32), names * 4), names * 4) : Buffer.alloc(0);
      const ordinals = names ? read(fileOffset(blob.readUInt32LE(36), names * 2), names * 2) : Buffer.alloc(0);
      const ordinalBase = blob.readUInt32LE(16);
      if (exportOrdinals) {
        if (ordinalBase + functions > 0x100000000) return null;
        for (let i = 0; i < functions; i++) {
          const address = addresses.readUInt32LE(i * 4);
          if (!address) continue;
          const forwarded = address >= exportRva && address - exportRva < exportBytes;
          const target = sections.find(row => address >= row.rva && address - row.rva < row.size);
          const entry = { ordinal: ordinalBase + i, names: [], rva: address, forwarded, executable: !forwarded && Boolean(target?.executable) };
          if (forwarded) {
            const value = nameAt(address, exportBytes - (address - exportRva)), separator = value.lastIndexOf('.');
            let module = value.slice(0, separator).toLowerCase();
            const symbol = value.slice(separator + 1);
            if (separator <= 0 || !symbol || module === '.' || module === '..' || /[\\/:]/.test(module)) return null;
            if (!/\.(?:dll|exe)$/i.test(module)) module += '.dll';
            const forwarder = { module, classification: moduleClass(module) };
            if (symbol.startsWith('#')) {
              if (!/^#\d+$/.test(symbol) || Number(symbol.slice(1)) > 0xffff) return null;
              forwarder.ordinal = Number(symbol.slice(1));
            } else forwarder.name = symbol;
            entry.forwarder = forwarder;
          }
          ordinalExports.set(entry.ordinal, entry);
        }
      }
      for (let i = 0; i < names; i++) {
        const rva = nameAddresses.readUInt32LE(i * 4), ordinal = ordinals.readUInt16LE(i * 2);
        if (ordinal >= functions) return null;
        const nameOffset = fileOffset(rva, 1), section = sections.find(row => nameOffset >= row.offset && nameOffset < row.offset + row.size);
        const maximum = Math.min(LIMITS.nameBytes, section.offset + section.size - nameOffset);
        const bytes = read(nameOffset, maximum), end = bytes.indexOf(0);
        if (end <= 0 || bytes.subarray(0, end).some(byte => byte < 0x20 || byte > 0x7e)) return null;
        const name = bytes.toString("ascii", 0, end), address = addresses.readUInt32LE(ordinal * 4);
        if (exports.has(name)) return null;
        const forwarded = address >= exportRva && address - exportRva < exportBytes;
        const target = sections.find(row => address >= row.rva && address - row.rva < row.size);
        exports.set(name, { rva: address, forwarded, executable: !forwarded && Boolean(target?.executable) });
        ordinalExports?.get(ordinalBase + ordinal)?.names.push(name);
      }
    }
    return { ...header, exports, ...(ordinalExports ? { exportOrdinals: ordinalExports } : {}), bytesRead };
  } catch (error) {
    if (error.code === "DETECTION_LIMIT") throw error;
    return null;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

module.exports = { LIMITS, readPeExports };
