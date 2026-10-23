import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url), root = path.dirname(fileURLToPath(import.meta.url));
// Developer build of the small owned control overlay. Account operations use
// the included JAR and the selected Java runtime without requiring a compiler.
const payload = await require("../runtime").resolveForLaunch();
const javaHome = process.env.MACLAUNCHER_ACCOUNT_CONTROL_JDK || "/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home";
const source = path.join(root, "java/maclauncher/android/AccountControl.java");
const policySource = path.join(root, "java/maclauncher/android/framework/HostAccountAccess.java");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "google-account-control-build-"));
try {
  const classes = path.join(temporary, "classes"); fs.mkdirSync(classes);
  execFileSync(path.join(javaHome, "bin/javac"), ["--release", "21", "-proc:none", "-encoding", "UTF-8",
    "-classpath", [path.join(payload.root, "android-host.jar"), path.join(payload.root, "android-framework.jar")].join(path.delimiter),
    "-d", classes, source, policySource], { stdio: "inherit" });
  const resources = path.join(root, "resources"); fs.mkdirSync(resources, { recursive: true });
  const metadata = path.join(classes, "META-INF"); fs.mkdirSync(metadata); fs.copyFileSync(path.join(resources, "account-control.LICENSE"), path.join(metadata, "LICENSE"));
  const output = path.join(resources, "account-control.jar");
  execFileSync(path.join(javaHome, "bin/jar"), ["--create", "--file", output, "--date=2026-10-21T00:00:00Z", "-C", classes, "."], { stdio: "inherit" });
  const digest = value => crypto.createHash("sha256").update(value).digest("hex");
  fs.writeFileSync(path.join(resources, "account-control.json"), JSON.stringify({ schema: 1, sourceSha256: digest(fs.readFileSync(source)), policySourceSha256: digest(fs.readFileSync(policySource)), sha256: digest(fs.readFileSync(output)) }, null, 2) + "\n");
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
