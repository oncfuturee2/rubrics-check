# Rubrics 工作台可执行文件构建

# 预览
标注工作台:
<img width="1954" height="1062" alt="20260630105922_rec_" src="https://github.com/user-attachments/assets/a5ad5eaa-7681-423b-8077-d5c3e6ce3b16" />


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

产物输出到：

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
