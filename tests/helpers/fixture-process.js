// Fixture processes stand in for games and servers that run until they are
// stopped. Each also ends once the test process is gone, so a test that fails,
// times out or is killed before its cleanup leaves nothing running.
// `untilTestEnds` is code for a `node -e` script, or for the end of one, that a
// test writes itself. A fixture file started as its own process calls
// `waitForTestEnd()` instead; the test passes its ID to it in the environment
// through `testEnvironment`.
const TEST_PID = "MACLAUNCHER_TEST_PID";
const owner = Number(process.env[TEST_PID]) || process.pid;
const untilTestEnds = `setInterval(()=>{try{process.kill(${owner},0)}catch{process.exit()}},200);`;
const testEnvironment = { [TEST_PID]: String(owner) };
function waitForTestEnd() {
  setInterval(() => { try { process.kill(owner, 0); } catch { process.exit(); } }, 200);
}

module.exports = { untilTestEnds, testEnvironment, waitForTestEnd };
