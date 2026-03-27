import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktopDir = path.join(rootDir, "desktop");
const distInstallersDir = path.join(desktopDir, "dist-installers");
const releaseDir = path.join(rootDir, "release");
const version = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8")).version;
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

const target = process.argv[2];

const platformConfig = {
  linux: {
    builderArgs: ["--linux", "AppImage", "deb"],
    outputs: [
      { ext: ".AppImage", required: true },
      { ext: ".deb", required: true },
    ],
  },
  windows: {
    builderArgs: ["--win", "nsis"],
    outputs: [{ ext: ".exe", required: true }],
  },
  macos: {
    builderArgs: ["--mac", "dmg"],
    outputs: [{ ext: ".dmg", required: true }],
  },
};

if (!target || !(target in platformConfig)) {
  console.error("Usage: node scripts/release-build.mjs <linux|windows|macos>");
  process.exit(1);
}

function run(cmd, args, cwd = rootDir) {
  console.log(`[release] ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, {
    cwd,
    stdio: "inherit",
    env: {
      ...process.env,
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
    },
  });
}

function listTopLevelFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(dir, entry.name));
}

function stageArtifacts(platform) {
  mkdirSync(releaseDir, { recursive: true });
  const files = listTopLevelFiles(distInstallersDir);
  const staged = [];

  for (const output of platformConfig[platform].outputs) {
    const match = files.find((file) => file.endsWith(output.ext));
    if (!match) {
      if (output.required) {
        throw new Error(`Missing expected ${platform} artifact with extension ${output.ext}`);
      }
      continue;
    }

    const destination = path.join(releaseDir, `proworkbench-v${version}-${platform}${output.ext}`);
    rmSync(destination, { force: true });
    copyFileSync(match, destination);
    staged.push(destination);
  }

  if (!staged.length) {
    throw new Error(`No artifacts were staged for ${platform}`);
  }

  return staged;
}

function smokeCheck(platform, staged) {
  if (platform === "linux") {
    const appImage = staged.find((file) => file.endsWith(".AppImage"));
    const deb = staged.find((file) => file.endsWith(".deb"));
    if (appImage) run("file", [appImage]);
    if (deb) run("dpkg-deb", ["--info", deb]);
    return;
  }

  if (platform === "windows") {
    for (const file of staged) {
      const size = statSync(file).size;
      if (size <= 0) throw new Error(`Windows artifact is empty: ${file}`);
      console.log(`[release] verified ${path.basename(file)} (${size} bytes)`);
    }
    return;
  }

  if (platform === "macos") {
    const dmg = staged.find((file) => file.endsWith(".dmg"));
    if (!dmg) throw new Error("Missing macOS DMG artifact");
    const size = statSync(dmg).size;
    if (size <= 0) throw new Error(`macOS artifact is empty: ${dmg}`);
    console.log(`[release] verified ${path.basename(dmg)} (${size} bytes)`);

    if (process.platform === "darwin") {
      run("hdiutil", ["verify", dmg]);
    } else {
      console.log("[release] macOS DMG produced on a non-macOS host; notarization and launch verification must run on macOS.");
    }
  }
}

rmSync(distInstallersDir, { recursive: true, force: true });
mkdirSync(distInstallersDir, { recursive: true });

run(npmCmd, ["run", "build"]);
run(npmCmd, ["run", "build"], desktopDir);
run(npmCmd, ["run", "dist", "--", ...platformConfig[target].builderArgs], desktopDir);

const staged = stageArtifacts(target);
smokeCheck(target, staged);

console.log("[release] staged artifacts:");
for (const file of staged) {
  console.log(`- ${path.relative(rootDir, file)}`);
}
