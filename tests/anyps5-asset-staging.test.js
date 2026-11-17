const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture } = require('./helpers/anyps5-preparation-fixture.cjs');
const Prepare = require('../src/modules/anyps5/prepare');

test('staged PS5 assets retain game changes across a later source update', async t => {
  const f = fixture(t);
  const directory = path.join(Prepare.gameDirectory(f.entry, f.context), 'fex');
  const program = Prepare.resolveProgram(f.entry);
  const source = path.join(f.assets, 'assets', 'data.bin');
  const output = path.join(directory, 'app0', 'assets', 'data.bin');
  await Prepare.stageFexApp0(program, directory, f.context);
  fs.writeFileSync(output, 'a change made by the game');
  await Prepare.stageFexApp0(program, directory, f.context);
  fs.writeFileSync(source, 'an updated imported asset');
  await Prepare.stageFexApp0(program, directory, f.context);
  assert.equal(fs.readFileSync(output, 'utf8'), 'a change made by the game');
  assert.equal(fs.readFileSync(source, 'utf8'), 'an updated imported asset');
});

test('unchanged staged assets follow source updates and new files are staged', async t => {
  const f = fixture(t);
  const directory = path.join(Prepare.gameDirectory(f.entry, f.context), 'fex');
  const program = Prepare.resolveProgram(f.entry);
  const source = path.join(f.assets, 'assets', 'data.bin');
  await Prepare.stageFexApp0(program, directory, f.context);
  fs.writeFileSync(source, 'an updated imported asset');
  fs.writeFileSync(path.join(f.assets, 'assets', 'added.bin'), 'new asset');
  await Prepare.stageFexApp0(program, directory, f.context);
  assert.equal(fs.readFileSync(path.join(directory, 'app0', 'assets', 'data.bin'), 'utf8'), 'an updated imported asset');
  assert.equal(fs.readFileSync(path.join(directory, 'app0', 'assets', 'added.bin'), 'utf8'), 'new asset');
});

test('a legacy staging receipt cannot promote game-written bytes into source ownership', async t => {
  const f = fixture(t);
  const directory = path.join(Prepare.gameDirectory(f.entry, f.context), 'fex');
  const program = Prepare.resolveProgram(f.entry);
  await Prepare.stageFexApp0(program, directory, f.context);
  const output = path.join(directory, 'app0', 'assets', 'data.bin');
  fs.writeFileSync(output, 'a change made by the game');
  const receipt = JSON.parse(fs.readFileSync(path.join(directory, 'app0.json'), 'utf8'));
  receipt.schemaVersion = 1;
  const stat = fs.statSync(output);
  receipt.files['assets/data.bin'] = {stamp: receipt.files['assets/data.bin'].stamp,
    staged: `${stat.size}:${stat.mtimeMs}:${stat.ino}`};
  fs.writeFileSync(path.join(directory, 'app0.json'), JSON.stringify(receipt));
  await Prepare.stageFexApp0(program, directory, f.context);
  fs.writeFileSync(path.join(f.assets, 'assets', 'data.bin'), 'an updated imported asset');
  await Prepare.stageFexApp0(program, directory, f.context);
  assert.equal(fs.readFileSync(output, 'utf8'), 'a change made by the game');
});

test('removed source assets retire only unchanged owned copies', async t => {
  const f=fixture(t),directory=path.join(Prepare.gameDirectory(f.entry,f.context),'fex');
  const program=Prepare.resolveProgram(f.entry),asset=path.join(f.assets,'assets');
  fs.writeFileSync(path.join(asset,'removed.bin'),'unchanged source');
  fs.writeFileSync(path.join(asset,'edited.bin'),'source before game change');
  await Prepare.stageFexApp0(program,directory,f.context);
  const staged=path.join(directory,'app0','assets');
  fs.writeFileSync(path.join(staged,'edited.bin'),'game change');
  fs.writeFileSync(path.join(staged,'game-created.bin'),'game-created data');
  fs.unlinkSync(path.join(asset,'removed.bin'));fs.unlinkSync(path.join(asset,'edited.bin'));
  await Prepare.stageFexApp0(program,directory,f.context);
  assert.equal(fs.existsSync(path.join(staged,'removed.bin')),false);
  assert.equal(fs.readFileSync(path.join(staged,'edited.bin'),'utf8'),'game change');
  assert.equal(fs.readFileSync(path.join(staged,'game-created.bin'),'utf8'),'game-created data');
});
