const fs = require('node:fs'), path = require('node:path');
const { resourceFixture } = require('./pe-resources-fixture');
const { versionResource } = require('./pe-fixture');
function bootstrap(file, target = 'Project\\Binaries\\Win64\\Game.exe', args = 'Project', product = 'BootstrapPackagedGame') {
  const fixture = resourceFixture([
    { type: 16, name: 1, data: versionResource({ strings: { ProductName: product } }) },
    { type: 10, name: 201, data: Buffer.from(target + '\0', 'utf16le') },
    { type: 10, name: 202, data: Buffer.from(args + '\0', 'utf16le') }
  ], { is64: true });
  fixture.bytes.writeUInt16LE(2, fixture.peOffset + 22);
  fixture.bytes.writeUInt16LE(2, fixture.optional + 68);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, fixture.bytes);
}
module.exports = { bootstrap };
