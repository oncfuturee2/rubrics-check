import { resolve } from "node:path";
import { run } from "./run-command.mjs";

const [svgInput] = process.argv.slice(2);

if (!svgInput) {
  console.error("Usage: node scripts/generate-app-icons.mjs <svg>");
  process.exit(1);
}

const tauriCli = resolve(process.cwd(), "node_modules/@tauri-apps/cli/tauri.js");
const svgPath = resolve(process.cwd(), svgInput);
const outputDir = resolve(process.cwd(), "src-tauri/icons");

run(process.execPath, [tauriCli, "icon", svgPath, "--output", outputDir], { shell: false });
console.log(`Tauri 图标资源已生成：${svgInput}`);
