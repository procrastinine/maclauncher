const { createManager } = require("../../runtime/translator-managers");
module.exports = ["dxvk", "vkd3d", "vkd3d-proton", "d3dmetal", "gstreamer"].map(engine => createManager(engine));
