import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

type LauncherInfo = {
  mode: "qc" | "label";
  title: string;
  url: string;
};

function App() {
  const [info, setInfo] = useState<LauncherInfo | null>(null);
  const [message, setMessage] = useState("正在启动本地服务器...");

  useEffect(() => {
    invoke<LauncherInfo>("launcher_info")
      .then((nextInfo) => {
        setInfo(nextInfo);
        setMessage("服务器已启动，可以在 Chrome 中开始作业。");
      })
      .catch((error) => {
        setMessage(`启动失败：${String(error)}`);
      });
  }, []);

  async function copyAddress() {
    if (!info?.url) return;
    try {
      await invoke("copy_to_clipboard", { text: info.url });
      setMessage("服务器地址已复制。");
    } catch (error) {
      setMessage(`复制失败：${String(error)}`);
    }
  }

  async function openChrome() {
    if (!info?.url) return;
    try {
      await invoke("open_in_chrome", { url: info.url });
      setMessage("已请求 Chrome 打开工作台。");
    } catch (error) {
      setMessage(String(error));
    }
  }

  return (
    <main className="launcher-shell">
      <section className="launcher-card">
        <div className="eyebrow">{info?.mode === "label" ? "Label Workbench" : "QC Workbench"}</div>
        <h1>{info?.title || "Rubrics 工作台"}</h1>
        <p className="description">
          双击运行后会在本机启动一个临时服务器。复制地址或直接用 Chrome 打开，即可访问对应工作台页面。
        </p>

        <label className="address-field">
          <span>服务器地址</span>
          <input value={info?.url || ""} readOnly placeholder="等待服务器启动" />
        </label>

        <div className="actions">
          <button type="button" className="secondary-button" onClick={copyAddress} disabled={!info?.url}>
            复制地址
          </button>
          <button type="button" className="primary-button" onClick={openChrome} disabled={!info?.url}>
            在 Chrome 浏览器中打开
          </button>
        </div>

        <div className="status-line">{message}</div>
      </section>
    </main>
  );
}

export default App;
