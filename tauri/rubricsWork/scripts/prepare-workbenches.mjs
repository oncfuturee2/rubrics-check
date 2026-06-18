import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const projectRoot = resolve(process.cwd(), "../..");
const sourceDist = resolve(process.cwd(), ".workbench-build");
const targetDist = resolve(process.cwd(), "src-tauri/resources/workbench-dist");
const npmExecPath = process.env.npm_execpath;
const npmCommand = npmExecPath ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
const buildArgs = ["run", "build", "--", "--outDir", sourceDist, "--emptyOutDir=true"];
const npmArgs = npmExecPath ? [npmExecPath, ...buildArgs] : buildArgs;

const build = spawnSync(npmCommand, npmArgs, {
  cwd: projectRoot,
  stdio: "inherit",
});

if (build.error) {
  console.error(build.error);
  process.exit(1);
}

if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

if (!existsSync(sourceDist)) {
  console.error(`Root dist not found: ${sourceDist}`);
  process.exit(1);
}

rmSync(targetDist, { recursive: true, force: true });
mkdirSync(targetDist, { recursive: true });
cpSync(sourceDist, targetDist, { recursive: true });

console.log(`质检/标注前端 dist 已复制到 ${targetDist}`);
