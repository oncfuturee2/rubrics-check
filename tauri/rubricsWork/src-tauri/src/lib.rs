use serde::Serialize;
use std::{
    env,
    ffi::OsStr,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::Duration,
};
use tauri::Manager;

mod embedded_workbench {
    include!(concat!(env!("OUT_DIR"), "/embedded_workbench.rs"));
}

#[derive(Clone, Serialize)]
struct LauncherInfo {
    title: String,
    label_url: String,
    qc_url: String,
}

#[derive(Clone)]
struct LauncherState {
    info: LauncherInfo,
}

#[tauri::command]
fn launcher_info(state: tauri::State<'_, LauncherState>) -> LauncherInfo {
    state.info.clone()
}

#[tauri::command]
fn open_in_chrome(url: String) -> Result<(), String> {
    for candidate in chrome_candidates() {
        if candidate.exists() && Command::new(&candidate).arg(&url).spawn().is_ok() {
            return Ok(());
        }
    }

    if Command::new("chrome").arg(&url).spawn().is_ok() {
        return Ok(());
    }

    Command::new("cmd")
        .args(["/C", "start", "", "chrome", &url])
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("无法打开 Chrome：{error}"))
}

#[tauri::command]
fn copy_to_clipboard(text: String) -> Result<(), String> {
    let mut command = Command::new("powershell");
    command
        .args(["-NoProfile", "-Command", "Set-Clipboard -Value $input"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    apply_no_window(&mut command);

    let mut child = command
        .spawn()
        .map_err(|error| format!("无法访问系统剪贴板：{error}"))?;
    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(text.as_bytes())
            .map_err(|error| format!("无法写入剪贴板：{error}"))?;
    }

    let status = child
        .wait()
        .map_err(|error| format!("剪贴板命令执行失败：{error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("剪贴板命令执行失败".to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let listener = TcpListener::bind(("127.0.0.1", 0))
                .map_err(|error| format!("无法启动本地服务器：{error}"))?;
            let port = listener
                .local_addr()
                .map_err(|error| format!("无法读取本地服务器端口：{error}"))?
                .port();
            thread::spawn(move || run_server(listener));

            let title = "Rubrics 工作台启动器".to_string();
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title(&title);
            }

            app.manage(LauncherState {
                info: LauncherInfo {
                    title,
                    label_url: format!("http://127.0.0.1:{port}/label/"),
                    qc_url: format!("http://127.0.0.1:{port}/"),
                },
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![launcher_info, open_in_chrome, copy_to_clipboard])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn run_server(listener: TcpListener) {
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                thread::spawn(move || handle_client(stream));
            }
            Err(_) => thread::sleep(Duration::from_millis(30)),
        }
    }
}

fn handle_client(mut stream: TcpStream) {
    let mut buffer = [0_u8; 8192];
    let bytes_read = match stream.read(&mut buffer) {
        Ok(0) | Err(_) => return,
        Ok(size) => size,
    };
    let request = String::from_utf8_lossy(&buffer[..bytes_read]);
    let first_line = request.lines().next().unwrap_or_default();
    let mut parts = first_line.split_whitespace();
    let method = parts.next().unwrap_or_default();
    let target = parts.next().unwrap_or("/");

    if method != "GET" && method != "HEAD" {
        write_response(&mut stream, 405, "text/plain; charset=utf-8", b"Method Not Allowed", method == "HEAD");
        return;
    }

    if target.starts_with("/api/page-title") {
        let body = page_title_response(target);
        write_response(
            &mut stream,
            200,
            "application/json; charset=utf-8",
            body.as_bytes(),
            method == "HEAD",
        );
        return;
    }

    match resolve_static_key(target).and_then(|key| embedded_asset(&key).map(|body| (key, body))) {
        Some((key, body)) => write_response(&mut stream, 200, mime_for_key(&key), body, method == "HEAD"),
        None => write_response(&mut stream, 404, "text/plain; charset=utf-8", b"Not Found", method == "HEAD"),
    }
}

fn resolve_static_key(target: &str) -> Option<String> {
    let path_part = target.split('?').next().unwrap_or("/");
    let decoded = percent_decode(path_part).ok()?;
    let normalized = if decoded == "/" {
        "index.html".to_string()
    } else if decoded == "/label" || decoded == "/label/" {
        "label/index.html".to_string()
    } else {
        decoded.trim_start_matches('/').to_string()
    };

    let mut safe_path = PathBuf::new();
    for component in Path::new(&normalized).components() {
        match component {
            Component::Normal(part) => safe_path.push(part),
            _ => return None,
        }
    }

    let key = safe_path.to_string_lossy().replace('\\', "/");
    if embedded_asset(&key).is_some() {
        Some(key)
    } else {
        let index_key = format!("{key}/index.html");
        embedded_asset(&index_key).map(|_| index_key)
    }
}

fn embedded_asset(path: &str) -> Option<&'static [u8]> {
    embedded_workbench::WORKBENCH_ASSETS
        .iter()
        .find_map(|(asset_path, body)| (*asset_path == path).then_some(*body))
}

fn page_title_response(target: &str) -> String {
    let query = target.split_once('?').map(|(_, query)| query).unwrap_or_default();
    let url = url::form_urlencoded::parse(query.as_bytes())
        .find(|(key, _)| key == "url")
        .map(|(_, value)| value.into_owned())
        .unwrap_or_default();

    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return r#"{"title":"","error":"invalid url"}"#.to_string();
    }

    let result = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(12))
        .user_agent("Mozilla/5.0 Rubrics Desktop Launcher")
        .build()
        .and_then(|client| client.get(&url).send())
        .and_then(|response| response.error_for_status())
        .and_then(|response| response.text());

    match result {
        Ok(html) => format!(r#"{{"title":"{}"}}"#, json_escape(&extract_title(&html))),
        Err(error) => format!(r#"{{"title":"","error":"{}"}}"#, json_escape(&error.to_string())),
    }
}

fn extract_title(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let Some(start_tag_start) = lower.find("<title") else {
        return String::new();
    };
    let Some(start_tag_end) = lower[start_tag_start..].find('>') else {
        return String::new();
    };
    let content_start = start_tag_start + start_tag_end + 1;
    let Some(end_tag_start) = lower[content_start..].find("</title>") else {
        return String::new();
    };

    html[content_start..content_start + end_tag_start]
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn write_response(stream: &mut TcpStream, status: u16, content_type: &str, body: &[u8], head_only: bool) {
    let reason = match status {
        200 => "OK",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "OK",
    };
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(header.as_bytes());
    if !head_only {
        let _ = stream.write_all(body);
    }
}

fn mime_for_key(path: &str) -> &'static str {
    match Path::new(path).extension().and_then(OsStr::to_str).unwrap_or_default() {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "ico" => "image/x-icon",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

fn percent_decode(value: &str) -> Result<String, ()> {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;

    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).map_err(|_| ())?;
            let byte = u8::from_str_radix(hex, 16).map_err(|_| ())?;
            output.push(byte);
            index += 3;
        } else {
            output.push(bytes[index]);
            index += 1;
        }
    }

    String::from_utf8(output).map_err(|_| ())
}

fn json_escape(value: &str) -> String {
    value
        .chars()
        .flat_map(|character| match character {
            '"' => "\\\"".chars().collect::<Vec<_>>(),
            '\\' => "\\\\".chars().collect::<Vec<_>>(),
            '\n' => "\\n".chars().collect::<Vec<_>>(),
            '\r' => "\\r".chars().collect::<Vec<_>>(),
            '\t' => "\\t".chars().collect::<Vec<_>>(),
            _ => vec![character],
        })
        .collect()
}

fn chrome_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(path) = env::var("PROGRAMFILES") {
        candidates.push(PathBuf::from(path).join("Google").join("Chrome").join("Application").join("chrome.exe"));
    }
    if let Ok(path) = env::var("PROGRAMFILES(X86)") {
        candidates.push(PathBuf::from(path).join("Google").join("Chrome").join("Application").join("chrome.exe"));
    }
    if let Ok(path) = env::var("LOCALAPPDATA") {
        candidates.push(PathBuf::from(path).join("Google").join("Chrome").join("Application").join("chrome.exe"));
    }
    candidates
}

#[cfg(windows)]
fn apply_no_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn apply_no_window(_command: &mut Command) {}
