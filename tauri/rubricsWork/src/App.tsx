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

  const appIcon = info?.mode === "label" ? "/tomato.svg" : "/cabbage.svg";

  return (
    <main className="launcher-shell">
      <section className="launcher-panel">
        <div className="title-row">
          <img className="app-icon" src={appIcon} alt="" aria-hidden="true" />
          <div>
            <h1>{info?.title || "Rubrics 工作台"}</h1>
            <p>{info?.mode === "label" ? "标注工作台" : "质检工作台"}</p>
          </div>
        </div>

        <div className="settings-group">
          <div className="settings-row">
            <div className="row-copy">
              <strong>本地服务</strong>
              <span>{message}</span>
            </div>
            <span className={`status-dot ${info?.url ? "ready" : ""}`} />
          </div>

          <label className="settings-row address-row">
            <div className="row-copy">
              <strong>服务器地址</strong>
              <input value={info?.url || ""} readOnly placeholder="等待服务器启动" />
            </div>
          </label>
        </div>

        <div className="command-bar">
          <button type="button" className="secondary-button" onClick={copyAddress} disabled={!info?.url}>
            复制地址
          </button>
          <button type="button" className="primary-button" onClick={openChrome} disabled={!info?.url}>
            在 Chrome 中打开
          </button>
        </div>
      </section>
    </main>
  );
}

export default App;
