import { useEffect, useId, useState } from "react";
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
        <button className="copy-icon-button" type="button" title={`复制${title}地址`} onClick={() => onCopy(url, title)} disabled={!url}>
          <Copy size={18} strokeWidth={2.25} />
        </button>
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
      </div>
    </section>
  );
}

function ChromeIcon() {
  return (
    <svg className="browser-icon" viewBox="0 0 256 256" aria-hidden="true" focusable="false">
      <path fill="#fff" d="M128.003 199.216c39.335 0 71.221-31.888 71.221-71.223S167.338 56.77 128.003 56.77S56.78 88.658 56.78 127.993s31.887 71.223 71.222 71.223" />
      <path fill="#229342" d="M35.89 92.997Q27.92 79.192 17.154 64.02a127.98 127.98 0 0 0 110.857 191.981q17.671-24.785 23.996-35.74q12.148-21.042 31.423-60.251v-.015a63.993 63.993 0 0 1-110.857.017Q46.395 111.19 35.89 92.998" />
      <path fill="#fbc116" d="M128.008 255.996A127.97 127.97 0 0 0 256 127.997A128 128 0 0 0 238.837 64q-36.372-3.585-53.686-3.585q-19.632 0-57.152 3.585l-.014.01a63.99 63.99 0 0 1 55.444 31.987a63.99 63.99 0 0 1-.001 64.01z" />
      <path fill="#1a73e8" d="M128.003 178.677c27.984 0 50.669-22.685 50.669-50.67s-22.685-50.67-50.67-50.67c-27.983 0-50.669 22.686-50.669 50.67s22.686 50.67 50.67 50.67" />
      <path fill="#e33b2e" d="M128.003 64.004H238.84a127.973 127.973 0 0 0-221.685.015l55.419 95.99l.015.008a63.993 63.993 0 0 1 55.415-96.014z" />
    </svg>
  );
}

function EdgeIcon() {
  const rawId = useId().replace(/:/g, "");
  const ids = {
    glow: `${rawId}-edge-glow`,
    shade: `${rawId}-edge-shade`,
    swirl: `${rawId}-edge-swirl`,
    light: `${rawId}-edge-light`,
    base: `${rawId}-edge-base`,
    blue: `${rawId}-edge-blue`,
  };

  return (
    <svg className="browser-icon" viewBox="0 0 256 256" aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id={ids.glow} cx="161.83" cy="788.401" r="95.38" gradientTransform="matrix(.9999 0 0 .9498 -4.622 -570.387)" gradientUnits="userSpaceOnUse">
          <stop offset=".72" stopOpacity="0" />
          <stop offset=".95" stopOpacity=".53" />
          <stop offset="1" />
        </radialGradient>
        <radialGradient id={ids.shade} cx="-773.636" cy="746.715" r="143.24" gradientTransform="matrix(.15 -.9898 .8 .12 -410.718 -656.341)" gradientUnits="userSpaceOnUse">
          <stop offset=".76" stopOpacity="0" />
          <stop offset=".95" stopOpacity=".5" />
          <stop offset="1" />
        </radialGradient>
        <radialGradient id={ids.swirl} cx="230.593" cy="-106.038" r="202.43" gradientTransform="matrix(-.04 .9998 -2.1299 -.07998 -190.775 -191.635)" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#35c1f1" />
          <stop offset=".11" stopColor="#34c1ed" />
          <stop offset=".23" stopColor="#2fc2df" />
          <stop offset=".31" stopColor="#2bc3d2" />
          <stop offset=".67" stopColor="#36c752" />
        </radialGradient>
        <radialGradient id={ids.light} cx="536.357" cy="-117.703" r="97.34" gradientTransform="matrix(.28 .9598 -.78 .23 -1.928 -410.318)" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#66eb6e" />
          <stop offset="1" stopColor="#66eb6e" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={ids.base} x1="63.334" x2="241.617" y1="757.83" y2="757.83" gradientTransform="translate(-4.63 -580.81)" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#0c59a4" />
          <stop offset="1" stopColor="#114a8b" />
        </linearGradient>
        <linearGradient id={ids.blue} x1="157.401" x2="46.028" y1="680.556" y2="801.868" gradientTransform="translate(-4.63 -580.81)" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#1b9de2" />
          <stop offset=".16" stopColor="#1595df" />
          <stop offset=".67" stopColor="#0680d7" />
          <stop offset="1" stopColor="#0078d4" />
        </linearGradient>
      </defs>
      <path fill={`url(#${ids.base})`} d="M231 190.5c-3.4 1.8-6.9 3.4-10.5 4.7c-11.5 4.3-23.6 6.5-35.9 6.5c-47.3 0-88.5-32.5-88.5-74.3c.1-11.4 6.4-21.9 16.4-27.3c-42.8 1.8-53.8 46.4-53.8 72.5c0 73.9 68.1 81.4 82.8 81.4c7.9 0 19.8-2.3 27-4.6l1.3-.4c27.6-9.5 51-28.1 66.6-52.8c1.2-1.9.6-4.3-1.2-5.5c-1.3-.8-2.9-.9-4.2-.2" />
      <path fill={`url(#${ids.glow})`} d="M231 190.5c-3.4 1.8-6.9 3.4-10.5 4.7c-11.5 4.3-23.6 6.5-35.9 6.5c-47.3 0-88.5-32.5-88.5-74.3c.1-11.4 6.4-21.9 16.4-27.3c-42.8 1.8-53.8 46.4-53.8 72.5c0 73.9 68.1 81.4 82.8 81.4c7.9 0 19.8-2.3 27-4.6l1.3-.4c27.6-9.5 51-28.1 66.6-52.8c1.2-1.9.6-4.3-1.2-5.5c-1.3-.8-2.9-.9-4.2-.2" opacity=".35" />
      <path fill={`url(#${ids.blue})`} d="M105.7 241.4c-8.9-5.5-16.6-12.8-22.7-21.3c-26.3-36-18.4-86.5 17.6-112.8c3.8-2.7 7.7-5.2 11.9-7.2c3.1-1.5 8.4-4.1 15.5-4c10.1.1 19.6 4.9 25.7 13c4 5.4 6.3 11.9 6.4 18.7c0-.2 24.5-79.6-80-79.6c-43.9 0-80 41.7-80 78.2c-.2 19.3 4 38.5 12.1 56c27.6 58.8 94.8 87.6 156.4 67.1c-21.1 6.6-44.1 3.7-62.9-8.1" />
      <path fill={`url(#${ids.shade})`} d="M105.7 241.4c-8.9-5.5-16.6-12.8-22.7-21.3c-26.3-36-18.4-86.5 17.6-112.8c3.8-2.7 7.7-5.2 11.9-7.2c3.1-1.5 8.4-4.1 15.5-4c10.1.1 19.6 4.9 25.7 13c4 5.4 6.3 11.9 6.4 18.7c0-.2 24.5-79.6-80-79.6c-43.9 0-80 41.7-80 78.2c-.2 19.3 4 38.5 12.1 56c27.6 58.8 94.8 87.6 156.4 67.1c-21.1 6.6-44.1 3.7-62.9-8.1" opacity=".41" />
      <path fill={`url(#${ids.swirl})`} d="M152.3 148.9c-.8 1-3.3 2.5-3.3 5.7c0 2.6 1.7 5.1 4.7 7.2c14.4 10 41.5 8.7 41.6 8.7c10.7 0 21.1-2.9 30.3-8.3c18.8-11 30.4-31.1 30.4-52.9c.3-22.4-8-37.3-11.3-43.9C223.5 23.9 177.7 0 128 0C58 0 1 56.2 0 126.2c.5-36.5 36.8-66 80-66c3.5 0 23.5.3 42 10.1c16.3 8.6 24.9 18.9 30.8 29.2c6.2 10.7 7.3 24.1 7.3 29.5c0 5.3-2.7 13.3-7.8 19.9" />
      <path fill={`url(#${ids.light})`} d="M152.3 148.9c-.8 1-3.3 2.5-3.3 5.7c0 2.6 1.7 5.1 4.7 7.2c14.4 10 41.5 8.7 41.6 8.7c10.7 0 21.1-2.9 30.3-8.3c18.8-11 30.4-31.1 30.4-52.9c.3-22.4-8-37.3-11.3-43.9C223.5 23.9 177.7 0 128 0C58 0 1 56.2 0 126.2c.5-36.5 36.8-66 80-66c3.5 0 23.5.3 42 10.1c16.3 8.6 24.9 18.9 30.8 29.2c6.2 10.7 7.3 24.1 7.3 29.5c0 5.3-2.7 13.3-7.8 19.9" />
    </svg>
  );
}

export default App;
