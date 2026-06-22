import { run, npmCommand } from "./run-command.mjs";

if (process.env.RUBRICS_SKIP_TAURI_BEFORE_BUILD === "1") {
  console.log("Skipping Tauri beforeBuildCommand because build:exe already prepared resources.");
  process.exit(0);
}

const npm = npmCommand();

console.log("Preparing workbench resources before Tauri build...");
run(npm, ["run", "prepare-workbenches"]);
run(npm, ["run", "build"]);
run(process.execPath, ["scripts/generate-app-icons.mjs", "../../tomato.svg"], { shell: false });
