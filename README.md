# Rubrics 工作台可执行文件构建

## 构建

在项目根目录执行：

```bash
npm install
cd 
npm run build:exe
```

这就是最终构建命令。

## 首次构建前

根目录安装依赖：

```bash
npm install
```

Tauri 工程安装依赖：

```bash
cd tauri/rubricsWork
npm install
cd ../..
```

然后回到项目根目录执行：

```bash
npm run build:exe
```

## 构建流程

`npm run build:exe` 会调用：

```bash
npm --prefix tauri/rubricsWork run build:exe
```

实际执行脚本：

```text
tauri/rubricsWork/scripts/build-launchers.mjs
```

该脚本会依次完成：

1. 构建根目录质检工作台和 `label/` 标注工作台前端。
2. 把前端静态资源复制到 Tauri 资源目录。
3. 构建 Tauri 启动器前端。
4. 用圆白菜图标构建并复制 `rubrics-qc.exe`。
5. 用番茄图标构建并复制 `rubrics-label.exe`。

脚本使用的是：

```bash
cargo build --release --manifest-path src-tauri/Cargo.toml
```

不是：

```bash
tauri build
```

所以不会生成安装包，只会复制最终 `.exe` 到：

```text
tauri/rubricsWork/dist-launchers/
```

## 环境要求

- Node.js 18 或更高版本
- npm
- Rust 工具链
- Windows 构建环境，例如 Microsoft C++ Build Tools
- WebView2 Runtime

检查 Node/npm：

```bash
node -v
npm -v
```

检查 Rust：

```bash
rustc -V
cargo -V
```

## 单独进入 Tauri 目录构建

也可以在 Tauri 工程目录执行：

```bash
cd tauri/rubricsWork
npm run build:exe
```

产物仍然输出到：

```text
tauri/rubricsWork/dist-launchers/
```

## Web 前端开发命令

仅开发浏览器版时使用：

```bash
npm run dev
```

浏览器访问：

```text
http://127.0.0.1:5173/
http://127.0.0.1:5173/label/
```

仅构建浏览器静态资源时使用：

```bash
npm run build
```

输出目录：

```text
dist/
```

注意：`npm run build` 只构建 Web 静态资源，不生成 `.exe`。

## 清理产物

删除两个 exe 产物：

```powershell
Remove-Item -Recurse -Force tauri\rubricsWork\dist-launchers
```

清理 Rust 构建缓存：

```bash
cd tauri/rubricsWork/src-tauri
cargo clean
```
