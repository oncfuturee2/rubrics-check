import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Copy } from "lucide-react";
import "./App.css";

type LauncherInfo = {
  title: string;
  label_url: string;
  qc_url: string;
};

type BrowserType = "edge" | "chrome";

type WorkbenchPanelProps = {
  title: string;
  description: string;
  pageName: string;
  url: string;
  onCopy: (url: string, title: string) => void;
  onOpen: (browser: BrowserType, url: string, title: string, pageName: string) => void;
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

  async function openBrowser(browser: BrowserType, url: string, title: string, pageName: string) {
    if (!url) return;

    const browserLabel = browser === "edge" ? "Edge" : "Chrome";
    const command = browser === "edge" ? "open_in_edge" : "open_in_chrome";
    try {
      await invoke(command, { url });
      setMessage(`已请求 ${browserLabel} 打开${pageName}。`);
    } catch (error) {
      setMessage(`${browserLabel} 打开${title}失败：${String(error)}`);
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
            pageName="标注页面"
            url={info?.label_url || ""}
            onCopy={copyAddress}
            onOpen={openBrowser}
          />
          <WorkbenchPanel
            title="质检工作台"
            description="核对 prompt/rubrics/评分，输出质检评论"
            pageName="质检页面"
            url={info?.qc_url || ""}
            onCopy={copyAddress}
            onOpen={openBrowser}
          />
        </div>
      </section>
    </main>
  );
}

function WorkbenchPanel({ title, description, pageName, url, onCopy, onOpen }: WorkbenchPanelProps) {
  return (
    <section className="workbench-panel">
      <div className="panel-title">
        <h2>{title}</h2>
        <p>{description}</p>
      </div>

      <div className="url-row">
        <input value={url} readOnly placeholder="等待服务器启动" />
        <button
          className="browser-button edge-button"
          type="button"
          title={`在 Edge 中打开${pageName}`}
          onClick={() => onOpen("edge", url, title, pageName)}
          disabled={!url}
        >
          <EdgeIcon />
          <span>打开{pageName}</span>
        </button>
        <button
          className="browser-button chrome-button"
          type="button"
          title={`在 Chrome 中打开${pageName}`}
          onClick={() => onOpen("chrome", url, title, pageName)}
          disabled={!url}
        >
          <ChromeIcon />
          <span>打开{pageName}</span>
        </button>
        <button className="copy-icon-button" type="button" title={`复制${title}地址`} onClick={() => onCopy(url, title)} disabled={!url}>
          <Copy size={18} strokeWidth={2.25} />
        </button>
      </div>
    </section>
  );
}

function ChromeIcon() {
  return (
    <svg className="browser-icon" viewBox="0 0 256 256" aria-hidden="true" focusable="false">
      <path fill="#ea4335" d="M128 20c39.9 0 74.8 21.6 93.6 53.8H128c-26.7 0-49.9 15.2-61.3 37.4L34.5 55.5C54.3 33.7 82.9 20 128 20Z" />
      <path fill="#fbbc05" d="M221.6 73.8A107.5 107.5 0 0 1 128 236l46.9-81.3A54 54 0 0 0 128 73.8h93.6Z" />
      <path fill="#34a853" d="M81.1 154.7 34.5 55.5A107.5 107.5 0 0 0 128 236l46.9-81.3A54 54 0 0 1 81.1 154.7Z" />
      <circle cx="128" cy="128" r="52.5" fill="#fff" />
      <circle cx="128" cy="128" r="39.5" fill="#1a73e8" />
    </svg>
  );
}

function EdgeIcon() {
  return (
    <svg className="browser-icon" viewBox="0 0 256 256" aria-hidden="true" focusable="false">
      <path fill="#0c59a8" d="M222.7 164.1c-7.9 39.7-42.9 69.7-91.6 69.7-52.7 0-91.7-32.8-100.1-80.2 18.5 25.5 49.9 38.9 84.2 25.4 30.6-12.1 50.5-18.4 73.4-10.5 12.5 4.3 23.4 3.7 34.1-4.4Z" />
      <path fill="#17c3b2" d="M32.2 151.7c-2.9-39.4 19-72.6 52.9-88.3 42.6-19.7 91.1-6.8 113.8 25.1 16.3 22.9 18 52.9 7.6 76.3-11.1 8.7-23 9.6-37.3 3.7-25.5-10.6-48.2-5.1-76.9 7.4-26.7 11.7-48.2 1.5-60.1-24.2Z" />
      <path fill="#35a7ff" d="M218.4 88.5c-16.6-46.1-62.9-75-112.3-64.9C60.6 32.9 28.7 67.7 24.3 111c15.6-26.1 46.5-35.9 75.6-24.7 24.2 9.3 35.7 29.2 29.7 50.6-5 17.8-22.4 27.1-38.3 27.1 22.9 9.6 45.7-3.5 75.7-1.1 19.5 1.6 36.7 7.2 52.4-3.4 8.3-24.7 7.8-48.8-1-71Z" />
    </svg>
  );
}

export default App;
