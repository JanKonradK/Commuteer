// Build the signed release APK and its checksum, ready for a GitHub release:
//   dist/release/Commuteer-android.apk
//   dist/release/SHA256SUMS.txt   (the in-app updater refuses an APK that doesn't match)
//
// Signed with ~/.android/debug.keystore (or $COMMUTEER_KEYSTORE): the same key as the
// app already installed on phones, which Android requires for an update.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const run = (cmd, args, cwd = ".") => execFileSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });

run("npm", ["run", "build"]);
run("npx", ["cap", "sync", "android"]);
const gradlew = resolve("android", process.platform === "win32" ? "gradlew.bat" : "gradlew");
run(gradlew, ["assembleRelease", "--no-daemon"], "android");

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const releaseDir = join("dist", "release");
mkdirSync(releaseDir, { recursive: true });
const artifact = join(releaseDir, "Commuteer-android.apk");
copyFileSync(join("android", "app", "build", "outputs", "apk", "release", "app-release.apk"), artifact);
const digest = createHash("sha256").update(readFileSync(artifact)).digest("hex");
writeFileSync(join(releaseDir, "SHA256SUMS.txt"), `${digest}  Commuteer-android.apk\n`);
console.log(`\nCommuteer ${version}: ${artifact}\nsha256 ${digest}`);
