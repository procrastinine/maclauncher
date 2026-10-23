const crypto = require("node:crypto");

// This is the existing profile directory identity. Moving the system service
// process must not move or duplicate its account databases.
function dataId(provider = "com.google.android.gms") {
  return "account-service-" + crypto.createHash("sha256").update(provider).digest("hex").slice(0, 40);
}

module.exports = { dataId };
