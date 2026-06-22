import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Copy } from "lucide-react";
import "./App.css";

type LauncherInfo = {
  title: string;
  label_url: string;
  qc_url: string;
};

type WorkbenchPanelProps = {
  title: string;
  description: string;
  url: string;
  onCopy: (url: string, title: string) => void;
  onOpen: (url: string, title: string) => void;
};

function App() {
  const [info, setInfo] = useState<LauncherInfo | null>(null);
  const [message, setMessage] = useState("正在启动本地服务器...");

  useEffect(() => {
    invoke<LauncherInfo>("launcher_info")
      .then((nextInfo) => {
        setInfo(nextInfo);
        setMessage("服务器已启动，可以打开工作台。");
      })
      .catch((error) => {
        setMessage(`启动失败：${String(error)}`);
      });
  }, []);

  async function copyAddress(url: string, title: string) {
    if (!url) return;
    try {
      await invoke("copy_to_clipboard", { text: url });
      setMessage(`${title}地址已复制。`);
    } catch (error) {
      setMessage(`复制失败：${String(error)}`);
    }
  }

  async function openChrome(url: string, title: string) {
    if (!url) return;
    try {
      await invoke("open_in_chrome", { url });
      setMessage(`已请求 Chrome 打开${title}。`);
    } catch (error) {
      setMessage(String(error));
    }
  }

  return (
    <main className="launcher-shell">
      <section className="launcher-card">
        <header className="launcher-head">
          <img className="app-icon" src="/tomato.svg" alt="" aria-hidden="true" />
          <div>
            <h1>{info?.title || "Rubrics 工作台启动器"}</h1>
            <p>{message}</p>
          </div>
          <span className={`status-dot ${info ? "ready" : ""}`} />
        </header>

        <div className="panel-stack">
          <WorkbenchPanel
            title="标注工作台"
            description="编写 rubrics、测试页面、输出评分和备注"
            url={info?.label_url || ""}
            onCopy={copyAddress}
            onOpen={openChrome}
          />
          <WorkbenchPanel
            title="质检工作台"
            description="核对 prompt/rubrics/评分，输出质检评论"
            url={info?.qc_url || ""}
            onCopy={copyAddress}
            onOpen={openChrome}
          />
        </div>
      </section>
    </main>
  );
}

function WorkbenchPanel({ title, description, url, onCopy, onOpen }: WorkbenchPanelProps) {
  return (
    <section className="workbench-panel">
      <div className="panel-title">
        <h2>{title}</h2>
        <p>{description}</p>
      </div>

      <div className="url-row">
        <input value={url} readOnly placeholder="等待服务器启动" />
        <button className="copy-icon-button" type="button" title={`复制${title}地址`} onClick={() => onCopy(url, title)} disabled={!url}>
          <Copy size={18} strokeWidth={2.25} />
        </button>
        <button className="primary-button" type="button" onClick={() => onOpen(url, title)} disabled={!url}>
          在 Chrome 中打开
        </button>
      </div>
    </section>
  );
}

export default App;
