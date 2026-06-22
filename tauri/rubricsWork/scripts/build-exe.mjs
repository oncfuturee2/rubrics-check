import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { run, npmCommand } from "./run-command.mjs";

const npm = npmCommand();
const tauriCli = resolve(process.cwd(), "node_modules/@tauri-apps/cli/tauri.js");
const releaseExe = resolve(process.cwd(), "src-tauri/target/release/rubricswork.exe");
const outputDir = resolve(process.cwd(), "dist-launchers");
const outputExe = resolve(outputDir, "rubrics-workbench.exe");

console.log("\n[1/4] 构建质检/标注前端，并复制 dist 到 Tauri resources");
run(npm, ["run", "prepare-workbenches"]);

console.log("\n[2/4] 构建 Tauri 启动器前端");
run(npm, ["run", "build"]);

console.log("\n[3/4] 生成番茄应用图标，并使用 Tauri 构建单个 exe");
run(process.execPath, ["scripts/generate-app-icons.mjs", "../../tomato.svg"], { shell: false });
run(process.execPath, [tauriCli, "build", "--no-bundle"], {
  shell: false,
  env: {
    ...process.env,
    RUBRICS_SKIP_TAURI_BEFORE_BUILD: "1",
  },
});

console.log("\n[4/4] 输出单个可执行文件");
if (!existsSync(releaseExe)) {
  console.error(`Tauri executable not found: ${releaseExe}`);
  process.exit(1);
}

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });
copyFileSync(releaseExe, outputExe);
console.log(`Created ${outputExe}`);
console.log("\n完成：dist-launchers/rubrics-workbench.exe 已生成。");
