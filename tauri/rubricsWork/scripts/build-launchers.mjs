import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { run, npmCommand } from "./run-command.mjs";

const npm = npmCommand();
const releaseExe = resolve(process.cwd(), "src-tauri/target/release/rubricswork.exe");
const outputDir = resolve(process.cwd(), "dist-launchers");

console.log("\n[1/5] 构建质检/标注前端，并复制 dist 到 Tauri resources");
run(npm, ["run", "prepare-workbenches"]);

console.log("\n[2/5] 构建 Tauri 启动器前端");
run(npm, ["run", "build"]);

console.log("\n[3/5] 生成圆白菜图标并构建质检 exe");
buildLauncher("../../cabbage.svg", "rubrics-qc.exe");

console.log("\n[4/5] 生成番茄图标并构建标注 exe");
buildLauncher("../../tomato.svg", "rubrics-label.exe");

console.log("\n[5/5] 完成");
console.log("dist-launchers/rubrics-qc.exe 与 dist-launchers/rubrics-label.exe 已生成。");

function buildLauncher(iconSvg, targetName) {
  run(process.execPath, ["scripts/generate-app-icons.mjs", iconSvg], { shell: false });
  runCargoBuild();
  copyLauncher(targetName);
}

function runCargoBuild() {
  if (process.platform === "win32") {
    run("cmd.exe", ["/C", "cargo build --release --manifest-path src-tauri/Cargo.toml 2>&1"], { shell: false });
  } else {
    run("cargo", ["build", "--release", "--manifest-path", "src-tauri/Cargo.toml"], { shell: false });
  }
}

function copyLauncher(targetName) {
  if (!existsSync(releaseExe)) {
    console.error(`Tauri executable not found: ${releaseExe}`);
    process.exit(1);
  }

  mkdirSync(outputDir, { recursive: true });
  const target = resolve(outputDir, targetName);
  copyFileSync(releaseExe, target);
  console.log(`Created ${target}`);
}
