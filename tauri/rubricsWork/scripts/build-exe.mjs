import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { run, npmCommand } from "./run-command.mjs";

const npm = npmCommand();
const tauriCli = resolve(process.cwd(), "node_modules/@tauri-apps/cli/tauri.js");
const releaseExe = resolve(process.cwd(), "src-tauri/target/release/rubricswork.exe");
const outputDir = resolve(process.cwd(), "dist-launchers");
const outputExe = resolve(outputDir, "rubrics-workbench.exe");
const lockErrorCodes = new Set(["EBUSY", "EPERM", "EACCES"]);

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function copyFileWithRetry(source, target) {
  let lastError;
  for (let attempt = 1; attempt <= 16; attempt += 1) {
    try {
      copyFileSync(source, target);
      return;
    } catch (error) {
      if (!lockErrorCodes.has(error?.code)) {
        throw error;
      }
      lastError = error;
      sleep(350);
    }
  }
  throw lastError;
}

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

mkdirSync(outputDir, { recursive: true });
let createdExe = outputExe;
try {
  copyFileWithRetry(releaseExe, outputExe);
} catch (error) {
  if (!lockErrorCodes.has(error?.code)) {
    throw error;
  }
  createdExe = resolve(outputDir, `rubrics-workbench-${Date.now()}.exe`);
  console.warn(`目标 exe 被占用，已改为输出：${createdExe}`);
  copyFileWithRetry(releaseExe, createdExe);
}

console.log(`Created ${createdExe}`);
console.log(`\n完成：${createdExe} 已生成。`);
