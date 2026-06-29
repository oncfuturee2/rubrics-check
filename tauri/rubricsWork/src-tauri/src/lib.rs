use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    env,
    ffi::OsStr,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

mod embedded_workbench {
    include!(concat!(env!("OUT_DIR"), "/embedded_workbench.rs"));
}

const BUNDLED_QC_PROMPT: &str = include_str!("../../../../prompt.md");
const BUNDLED_LABEL_PROMPT: &str = include_str!("../../../../prompt-label.md");
const DB_FILE_NAME: &str = "rubrics-workbench.db";
const AI_SETTINGS_KEY: &str = "ai_settings";
const UI_PREFERENCES_KEY: &str = "ui_preferences";

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
    open_browser(url, "chrome", chrome_candidates(), "Chrome")
}

#[tauri::command]
fn open_in_edge(url: String) -> Result<(), String> {
    open_browser(url, "msedge", edge_candidates(), "Edge")
}

fn open_browser(url: String, command_name: &str, candidates: Vec<PathBuf>, browser_label: &str) -> Result<(), String> {
    for candidate in candidates {
        if candidate.exists() && Command::new(&candidate).arg(&url).spawn().is_ok() {
            return Ok(());
        }
    }

    if Command::new(command_name).arg(&url).spawn().is_ok() {
        return Ok(());
    }

    Command::new("cmd")
        .args(["/C", "start", "", command_name, &url])
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("无法打开 {browser_label}：{error}"))
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
            thread::spawn(|| {
                let _ = sync_prompt_defaults(false);
            });

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
        .invoke_handler(tauri::generate_handler![launcher_info, open_in_chrome, open_in_edge, copy_to_clipboard])
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
    let Ok((method, target, body)) = read_http_request(&mut stream) else {
        return;
    };
    let request = format!("{method} {target} HTTP/1.1");
    let first_line = request.lines().next().unwrap_or_default();
    let mut parts = first_line.split_whitespace();
    let method = parts.next().unwrap_or_default();
    let target = parts.next().unwrap_or("/");

    if target.starts_with("/api/ai/proxy") {
        if method == "OPTIONS" {
            write_response(&mut stream, 204, "text/plain; charset=utf-8", b"", false);
            return;
        }
        if method != "POST" {
            write_response(&mut stream, 405, "application/json; charset=utf-8", br#"{"error":"method not allowed"}"#, false);
            return;
        }
        let (status, response_body) = ai_proxy_response(&body);
        write_response(
            &mut stream,
            status,
            "application/json; charset=utf-8",
            response_body.as_bytes(),
            false,
        );
        return;
    }

    if target.starts_with("/api/ai/settings") {
        if method == "OPTIONS" {
            write_response(&mut stream, 204, "text/plain; charset=utf-8", b"", false);
            return;
        }

        let response = match method {
            "GET" => ai_settings_response(),
            "POST" => save_ai_settings_response(&body),
            _ => (405, r#"{"error":"method not allowed"}"#.to_string()),
        };
        write_response(
            &mut stream,
            response.0,
            "application/json; charset=utf-8",
            response.1.as_bytes(),
            false,
        );
        return;
    }

    if target.starts_with("/api/ai/sync-prompts") {
        if method == "OPTIONS" {
            write_response(&mut stream, 204, "text/plain; charset=utf-8", b"", false);
            return;
        }
        if method != "POST" {
            write_response(&mut stream, 405, "application/json; charset=utf-8", br#"{"error":"method not allowed"}"#, false);
            return;
        }

        let force = serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|value| value.get("force").and_then(Value::as_bool))
            .unwrap_or(true);
        let response = sync_prompts_response(force);
        write_response(
            &mut stream,
            response.0,
            "application/json; charset=utf-8",
            response.1.as_bytes(),
            false,
        );
        return;
    }

    if target.starts_with("/api/ui/preferences") {
        if method == "OPTIONS" {
            write_response(&mut stream, 204, "text/plain; charset=utf-8", b"", false);
            return;
        }

        let response = match method {
            "GET" => ui_preferences_response(),
            "POST" => save_ui_preferences_response(&body),
            _ => (405, r#"{"error":"method not allowed"}"#.to_string()),
        };
        write_response(
            &mut stream,
            response.0,
            "application/json; charset=utf-8",
            response.1.as_bytes(),
            false,
        );
        return;
    }

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

fn read_http_request(stream: &mut TcpStream) -> Result<(String, String, String), ()> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 8192];
    let mut header_end = None;
    let mut content_length = 0_usize;

    loop {
        let bytes_read = stream.read(&mut chunk).map_err(|_| ())?;
        if bytes_read == 0 {
            return Err(());
        }
        buffer.extend_from_slice(&chunk[..bytes_read]);

        if header_end.is_none() {
            header_end = find_header_end(&buffer);
            if let Some(end) = header_end {
                let header_text = String::from_utf8_lossy(&buffer[..end]);
                content_length = parse_content_length(&header_text);
            }
        }

        if let Some(end) = header_end {
            let body_start = end + 4;
            if buffer.len() >= body_start + content_length {
                let header_text = String::from_utf8_lossy(&buffer[..end]);
                let first_line = header_text.lines().next().unwrap_or_default();
                let mut parts = first_line.split_whitespace();
                let method = parts.next().unwrap_or_default().to_string();
                let target = parts.next().unwrap_or("/").to_string();
                let body = String::from_utf8_lossy(&buffer[body_start..body_start + content_length]).into_owned();
                return Ok((method, target, body));
            }
        }

        if buffer.len() > 8 * 1024 * 1024 {
            return Err(());
        }
    }
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

fn parse_content_length(headers: &str) -> usize {
    headers
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().ok())
                .flatten()
        })
        .unwrap_or(0)
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

#[derive(Deserialize)]
struct GitHubCommitItem {
    sha: String,
    commit: GitHubCommitDetail,
}

#[derive(Deserialize)]
struct GitHubCommitDetail {
    committer: Option<GitHubCommitPerson>,
    author: Option<GitHubCommitPerson>,
}

#[derive(Deserialize)]
struct GitHubCommitPerson {
    date: Option<String>,
}

fn ai_settings_response() -> (u16, String) {
    match get_ai_settings() {
        Ok(settings) => (200, settings.to_string()),
        Err(error) => (502, json!({ "error": error }).to_string()),
    }
}

fn save_ai_settings_response(body: &str) -> (u16, String) {
    let parsed: Value = match serde_json::from_str(body) {
        Ok(value) => value,
        Err(error) => return (400, json!({ "error": error.to_string() }).to_string()),
    };
    let settings = normalize_ai_settings(parsed);
    match save_ai_settings(&settings) {
        Ok(()) => (200, settings.to_string()),
        Err(error) => (502, json!({ "error": error }).to_string()),
    }
}

fn sync_prompts_response(force: bool) -> (u16, String) {
    match sync_prompt_defaults(force) {
        Ok(result) => (200, result.to_string()),
        Err(error) => (502, json!({ "error": error }).to_string()),
    }
}

fn ui_preferences_response() -> (u16, String) {
    match kv_get(UI_PREFERENCES_KEY) {
        Ok(Some(value)) => (200, normalize_ui_preferences(value).to_string()),
        Ok(None) => (200, default_ui_preferences().to_string()),
        Err(error) => (502, json!({ "error": error }).to_string()),
    }
}

fn save_ui_preferences_response(body: &str) -> (u16, String) {
    let parsed: Value = match serde_json::from_str(body) {
        Ok(value) => value,
        Err(error) => return (400, json!({ "error": error.to_string() }).to_string()),
    };
    let preferences = normalize_ui_preferences(parsed);
    match kv_set(UI_PREFERENCES_KEY, &preferences) {
        Ok(()) => (200, preferences.to_string()),
        Err(error) => (502, json!({ "error": error }).to_string()),
    }
}

fn default_ui_preferences() -> Value {
    json!({
        "cardHeights": {}
    })
}

fn normalize_ui_preferences(mut value: Value) -> Value {
    if !value.is_object() {
        value = default_ui_preferences();
    }
    if !value.get("cardHeights").map(Value::is_object).unwrap_or(false) {
        value["cardHeights"] = json!({});
    }
    value
}

fn get_ai_settings() -> Result<Value, String> {
    let settings = match kv_get(AI_SETTINGS_KEY)? {
        Some(value) => normalize_ai_settings(value),
        None => normalize_ai_settings(default_ai_settings()),
    };
    save_ai_settings(&settings)?;
    Ok(settings)
}

fn save_ai_settings(settings: &Value) -> Result<(), String> {
    kv_set(AI_SETTINGS_KEY, settings)
}

fn default_ai_settings() -> Value {
    json!({
        "activeProfileId": "openai-compatible",
        "profiles": [],
        "prompts": {
            "precheck": BUNDLED_QC_PROMPT.trim(),
            "generate": BUNDLED_LABEL_PROMPT.trim()
        },
        "github": default_github_config(),
        "promptVersions": {
            "precheck": [default_prompt_version("precheck", BUNDLED_QC_PROMPT.trim(), "bundled", None, None)],
            "generate": [default_prompt_version("generate", BUNDLED_LABEL_PROMPT.trim(), "bundled", None, None)]
        },
        "activePromptVersionIds": {
            "precheck": "default",
            "generate": "default"
        }
    })
}

fn default_github_config() -> Value {
    json!({
        "enabled": true,
        "owner": "oncfuturee2",
        "repo": "rubrics-check",
        "branch": "main",
        "precheckPath": "prompt.md",
        "generatePath": "prompt-label.md",
        "token": ""
    })
}

fn default_prompt_version(kind: &str, content: &str, source: &str, commit_sha: Option<String>, committed_at: Option<String>) -> Value {
    let name = if kind == "generate" {
        "默认标注提示词"
    } else {
        "默认质检提示词"
    };
    json!({
        "id": "default",
        "name": name,
        "content": content,
        "locked": true,
        "source": source,
        "commitSha": commit_sha,
        "committedAt": committed_at,
        "fetchedAt": now_unix_ms()
    })
}

fn normalize_ai_settings(mut settings: Value) -> Value {
    if !settings.is_object() {
        settings = default_ai_settings();
    }

    if !settings.get("activeProfileId").is_some() {
        settings["activeProfileId"] = json!("openai-compatible");
    }
    if !settings.get("profiles").map(Value::is_array).unwrap_or(false) {
        settings["profiles"] = json!([]);
    }
    if !settings.get("github").map(Value::is_object).unwrap_or(false) {
        settings["github"] = default_github_config();
    } else {
        let defaults = default_github_config();
        for key in ["enabled", "owner", "repo", "branch", "precheckPath", "generatePath", "token"] {
            if !settings["github"].get(key).is_some() {
                settings["github"][key] = defaults.get(key).cloned().unwrap_or(Value::Null);
            }
        }
    }
    if !settings.get("promptVersions").map(Value::is_object).unwrap_or(false) {
        settings["promptVersions"] = json!({});
    }
    if !settings.get("activePromptVersionIds").map(Value::is_object).unwrap_or(false) {
        settings["activePromptVersionIds"] = json!({});
    }

    ensure_prompt_versions(&mut settings, "precheck", BUNDLED_QC_PROMPT.trim());
    ensure_prompt_versions(&mut settings, "generate", BUNDLED_LABEL_PROMPT.trim());

    migrate_legacy_prompt(&mut settings, "precheck", BUNDLED_QC_PROMPT.trim());
    migrate_legacy_prompt(&mut settings, "generate", BUNDLED_LABEL_PROMPT.trim());

    if !settings["activePromptVersionIds"].get("precheck").and_then(Value::as_str).is_some() {
        settings["activePromptVersionIds"]["precheck"] = json!("default");
    }
    if !settings["activePromptVersionIds"].get("generate").and_then(Value::as_str).is_some() {
        settings["activePromptVersionIds"]["generate"] = json!("default");
    }

    sync_legacy_prompts(&mut settings);
    settings
}

fn ensure_prompt_versions(settings: &mut Value, kind: &str, bundled_content: &str) {
    if !settings["promptVersions"].get(kind).map(Value::is_array).unwrap_or(false) {
        settings["promptVersions"][kind] = json!([]);
    }

    let versions = settings["promptVersions"][kind].as_array_mut().unwrap();
    if let Some(index) = versions
        .iter()
        .position(|version| version.get("id").and_then(Value::as_str) == Some("default"))
    {
        let source = versions[index]
            .get("source")
            .and_then(Value::as_str)
            .unwrap_or("bundled")
            .to_string();
        versions[index]["locked"] = json!(true);
        if source != "github" {
            versions[index] = default_prompt_version(kind, bundled_content, "bundled", None, None);
        }
    } else {
        versions.insert(0, default_prompt_version(kind, bundled_content, "bundled", None, None));
    }
}

fn migrate_legacy_prompt(settings: &mut Value, kind: &str, bundled_content: &str) {
    let Some(legacy_content) = settings
        .get("prompts")
        .and_then(|prompts| prompts.get(kind))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|content| !content.is_empty() && *content != bundled_content)
        .map(str::to_string)
    else {
        return;
    };

    let versions = settings["promptVersions"][kind].as_array_mut().unwrap();
    let already_saved = versions
        .iter()
        .any(|version| version.get("content").and_then(Value::as_str) == Some(legacy_content.as_str()));
    if already_saved {
        return;
    }

    let id = format!("local-{}", now_unix_ms());
    versions.push(json!({
        "id": id,
        "name": "本地旧版提示词",
        "content": legacy_content,
        "locked": false,
        "source": "local",
        "createdAt": now_unix_ms(),
        "updatedAt": now_unix_ms()
    }));
}

fn sync_legacy_prompts(settings: &mut Value) {
    let precheck = active_prompt_content(settings, "precheck", BUNDLED_QC_PROMPT.trim());
    let generate = active_prompt_content(settings, "generate", BUNDLED_LABEL_PROMPT.trim());
    settings["prompts"] = json!({
        "precheck": precheck,
        "generate": generate
    });
}

fn active_prompt_content(settings: &Value, kind: &str, fallback: &str) -> String {
    let active_id = settings
        .get("activePromptVersionIds")
        .and_then(|value| value.get(kind))
        .and_then(Value::as_str)
        .unwrap_or("default");
    prompt_content_by_id(settings, kind, active_id)
        .or_else(|| prompt_content_by_id(settings, kind, "default"))
        .unwrap_or_else(|| fallback.to_string())
}

fn prompt_content_by_id(settings: &Value, kind: &str, id: &str) -> Option<String> {
    settings
        .get("promptVersions")
        .and_then(|value| value.get(kind))
        .and_then(Value::as_array)?
        .iter()
        .find(|version| version.get("id").and_then(Value::as_str) == Some(id))
        .and_then(|version| version.get("content").and_then(Value::as_str))
        .map(str::to_string)
}

fn sync_prompt_defaults(force: bool) -> Result<Value, String> {
    let mut settings = get_ai_settings()?;
    let github = settings.get("github").cloned().unwrap_or_else(default_github_config);
    if github.get("enabled").and_then(Value::as_bool) == Some(false) {
        return Ok(json!({ "settings": settings, "results": [] }));
    }

    let owner = github_string(&github, "owner", "oncfuturee2");
    let repo = github_string(&github, "repo", "rubrics-check");
    let branch = github_string(&github, "branch", "main");
    let token = github_string(&github, "token", "");
    let items = [
        ("precheck", github_string(&github, "precheckPath", "prompt.md"), BUNDLED_QC_PROMPT.trim()),
        ("generate", github_string(&github, "generatePath", "prompt-label.md"), BUNDLED_LABEL_PROMPT.trim()),
    ];
    let mut results = Vec::new();

    for (kind, path, fallback) in items {
        let result = match sync_one_prompt_default(&mut settings, kind, &path, fallback, &owner, &repo, &branch, &token, force) {
            Ok(result) => result,
            Err(error) => json!({ "kind": kind, "path": path, "updated": false, "error": error }),
        };
        results.push(result);
    }

    sync_legacy_prompts(&mut settings);
    save_ai_settings(&settings)?;
    Ok(json!({ "settings": settings, "results": results }))
}

fn sync_one_prompt_default(
    settings: &mut Value,
    kind: &str,
    path: &str,
    fallback: &str,
    owner: &str,
    repo: &str,
    branch: &str,
    token: &str,
    force: bool,
) -> Result<Value, String> {
    let (sha, committed_at) = latest_github_file_commit(owner, repo, branch, path, token)?;
    let existing_sha = default_prompt_field(settings, kind, "commitSha").unwrap_or_default();
    let existing_at = default_prompt_field(settings, kind, "committedAt").unwrap_or_default();
    let should_update = force
        || existing_sha != sha
        || (!committed_at.is_empty() && (existing_at.is_empty() || committed_at.as_str() > existing_at.as_str()));

    if !should_update {
        return Ok(json!({ "kind": kind, "path": path, "updated": false, "commitSha": sha, "committedAt": committed_at }));
    }

    let content = fetch_github_raw_file(owner, repo, &sha, path, token).unwrap_or_else(|_| fallback.to_string());
    set_default_prompt_version(settings, kind, content.trim(), "github", Some(sha.clone()), Some(committed_at.clone()));
    Ok(json!({ "kind": kind, "path": path, "updated": true, "commitSha": sha, "committedAt": committed_at }))
}

fn default_prompt_field(settings: &Value, kind: &str, field: &str) -> Option<String> {
    settings
        .get("promptVersions")
        .and_then(|value| value.get(kind))
        .and_then(Value::as_array)?
        .iter()
        .find(|version| version.get("id").and_then(Value::as_str) == Some("default"))
        .and_then(|version| version.get(field).and_then(Value::as_str))
        .map(str::to_string)
}

fn set_default_prompt_version(
    settings: &mut Value,
    kind: &str,
    content: &str,
    source: &str,
    commit_sha: Option<String>,
    committed_at: Option<String>,
) {
    ensure_prompt_versions(settings, kind, content);
    let versions = settings["promptVersions"][kind].as_array_mut().unwrap();
    let next = default_prompt_version(kind, content, source, commit_sha, committed_at);
    if let Some(index) = versions
        .iter()
        .position(|version| version.get("id").and_then(Value::as_str) == Some("default"))
    {
        versions[index] = next;
    } else {
        versions.insert(0, next);
    }
}

fn latest_github_file_commit(owner: &str, repo: &str, branch: &str, path: &str, token: &str) -> Result<(String, String), String> {
    let encoded_path: String = url::form_urlencoded::byte_serialize(path.as_bytes()).collect();
    let encoded_branch: String = url::form_urlencoded::byte_serialize(branch.as_bytes()).collect();
    let url = format!(
        "https://api.github.com/repos/{owner}/{repo}/commits?path={encoded_path}&sha={encoded_branch}&per_page=1"
    );
    let client = github_client()?;
    let mut request = client.get(url).header("Accept", "application/vnd.github+json");
    if !token.trim().is_empty() {
        request = request.bearer_auth(token.trim());
    }
    let commits = request
        .send()
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?
        .json::<Vec<GitHubCommitItem>>()
        .map_err(|error| error.to_string())?;
    let commit = commits.into_iter().next().ok_or_else(|| "no commit found".to_string())?;
    let committed_at = commit
        .commit
        .committer
        .and_then(|person| person.date)
        .or_else(|| commit.commit.author.and_then(|person| person.date))
        .unwrap_or_default();
    Ok((commit.sha, committed_at))
}

fn fetch_github_raw_file(owner: &str, repo: &str, sha: &str, path: &str, token: &str) -> Result<String, String> {
    let url = format!(
        "https://raw.githubusercontent.com/{owner}/{repo}/{sha}/{}",
        path.trim_start_matches('/')
    );
    let client = github_client()?;
    let mut request = client.get(url);
    if !token.trim().is_empty() {
        request = request.bearer_auth(token.trim());
    }
    request
        .send()
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?
        .text()
        .map_err(|error| error.to_string())
}

fn github_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent("Rubrics Workbench Prompt Sync")
        .build()
        .map_err(|error| error.to_string())
}

fn github_string(config: &Value, key: &str, fallback: &str) -> String {
    config
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(fallback)
        .trim()
        .to_string()
}

fn kv_get(key: &str) -> Result<Option<Value>, String> {
    let conn = open_settings_db()?;
    let result: Result<String, rusqlite::Error> =
        conn.query_row("SELECT value FROM app_kv WHERE key = ?1", [key], |row| row.get(0));
    match result {
        Ok(text) => serde_json::from_str(&text)
            .map(Some)
            .map_err(|error| error.to_string()),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn kv_set(key: &str, value: &Value) -> Result<(), String> {
    let conn = open_settings_db()?;
    conn.execute(
        "INSERT INTO app_kv (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        rusqlite::params![key, value.to_string(), now_unix_ms()],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn open_settings_db() -> Result<rusqlite::Connection, String> {
    let path = executable_dir().join(DB_FILE_NAME);
    let conn = rusqlite::Connection::open(path).map_err(|error| error.to_string())?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS app_kv (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        )",
        [],
    )
    .map_err(|error| error.to_string())?;
    Ok(conn)
}

fn executable_dir() -> PathBuf {
    env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .or_else(|| env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."))
}

fn now_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn ai_proxy_response(body: &str) -> (u16, String) {
    let payload: Value = match serde_json::from_str(body) {
        Ok(value) => value,
        Err(error) => return (400, format!(r#"{{"error":"{}"}}"#, json_escape(&error.to_string()))),
    };

    let url = payload
        .get("url")
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return (400, r#"{"error":"invalid url"}"#.to_string());
    }

    let method = payload
        .get("method")
        .and_then(|value| value.as_str())
        .unwrap_or("GET")
        .to_ascii_uppercase();
    let reqwest_method = reqwest::Method::from_bytes(method.as_bytes()).unwrap_or(reqwest::Method::GET);

    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(120))
        .user_agent("Rubrics Workbench AI Proxy")
        .build()
    {
        Ok(client) => client,
        Err(error) => return (502, format!(r#"{{"error":"{}"}}"#, json_escape(&error.to_string()))),
    };

    let mut request = client.request(reqwest_method, url);
    if let Some(headers) = payload.get("headers").and_then(|value| value.as_object()) {
        for (name, value) in headers {
            let lower_name = name.to_ascii_lowercase();
            if lower_name == "host" || lower_name == "content-length" {
                continue;
            }
            if let Some(header_value) = value.as_str() {
                request = request.header(name, header_value);
            }
        }
    }

    if let Some(request_body) = payload.get("body") {
        if !request_body.is_null() {
            request = request.body(request_body.to_string());
        }
    }

    match request.send() {
        Ok(response) => {
            let status = response.status().as_u16();
            match response.text() {
                Ok(text) => (status, text),
                Err(error) => (502, format!(r#"{{"error":"{}"}}"#, json_escape(&error.to_string()))),
            }
        }
        Err(error) => (502, format!(r#"{{"error":"{}"}}"#, json_escape(&error.to_string()))),
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
        204 => "No Content",
        400 => "Bad Request",
        404 => "Not Found",
        405 => "Method Not Allowed",
        502 => "Bad Gateway",
        _ => "OK",
    };
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: content-type, authorization, x-api-key, anthropic-version\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nConnection: close\r\n\r\n",
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

fn edge_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(path) = env::var("PROGRAMFILES") {
        candidates.push(PathBuf::from(path).join("Microsoft").join("Edge").join("Application").join("msedge.exe"));
    }
    if let Ok(path) = env::var("PROGRAMFILES(X86)") {
        candidates.push(PathBuf::from(path).join("Microsoft").join("Edge").join("Application").join("msedge.exe"));
    }
    if let Ok(path) = env::var("LOCALAPPDATA") {
        candidates.push(PathBuf::from(path).join("Microsoft").join("Edge").join("Application").join("msedge.exe"));
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
