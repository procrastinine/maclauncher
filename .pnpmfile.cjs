module.exports = {
  hooks: {
    readPackage(pkg) {
      // MacLauncher uses only rpgrt's compiled JavaScript library API, tested
      // on Node 22.12. Its upstream TypeScript CLI still requires Node 24.
      // Keep this exception scoped to the exact tested publisher package.
      if (pkg.name === "rpgrt" && pkg.version === "0.2.0") {
        return { ...pkg, engines: { ...pkg.engines, node: ">=22.12.0" } };
      }
      return pkg;
    }
  }
};
