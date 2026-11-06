'use strict';
const path = require('node:path');

// Android native sources are pinned submodules of the Android repository, which
// the app checks out at src/external/maclauncher-android.
const androidSources = path.resolve(__dirname, '../../src/external/maclauncher-android/src/external');
const androidSource = name => path.join(androidSources, name);

module.exports = { androidSource };
