// Complete NR metadata for package/path lifecycle checks. These fixtures do
// not execute inference and their small payload is deliberately not a model.
const NR = require('../../src/modules/shared/reshade/neural/nr-models');
const nrTensors = () => Object.values(NR.shapes(NR.topology([2, 2, 2, 2, 2])));
module.exports = {nrTensors};
