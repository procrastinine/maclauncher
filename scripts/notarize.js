const path = require("node:path");
const { notarize } = require("@electron/notarize");

module.exports = async function notarizeApp(context) {
  const { electronPlatformName, appOutDir, packager } = context;
  if (electronPlatformName !== "darwin") return;

  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;

  if (!appleId || !appleIdPassword || !teamId) {
    // Skip notarization when credentials are not configured.
    // eslint-disable-next-line no-console
    console.log(
      "[notarize] Skipping. Set APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID to enable."
    );
    return;
  }

  const appName = packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  await notarize({
    appBundleId: packager.appInfo.id,
    appPath,
    appleId,
    appleIdPassword,
    teamId
  });
};
