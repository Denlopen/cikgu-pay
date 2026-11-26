// Tauri version of the Electron main.js.
// Owns the data file, daily backups and PDF export. The page (ui/index.html) can only
// reach the computer through the #[tauri::command] functions below, via bridge.js.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")] // no console window on Windows

mod pdf;

use serde::Serialize;
use serde_json::Value;
use std::{
    fs,
    path::{Component, Path, PathBuf},
    sync::Mutex,
};
use tauri::{webview::PageLoadEvent, AppHandle, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

// ---------- where things live (same layout as the Electron app) ----------
// Documents/Tuition Invoices/
//   invoice-data.json        <- all students / invoices / settings
//   backups/                 <- one copy per day, last 30 kept
//   2026-08/<name>.pdf       <- exported documents, one folder per month
fn root_dir(app: &AppHandle) -> PathBuf {
    if let Some(dir) = std::env::var_os("INVOICE_DATA_DIR") {
        return PathBuf::from(dir);
    }
    app.path()
        .document_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("Tuition Invoices")
}
fn data_file(app: &AppHandle) -> PathBuf {
    root_dir(app).join("invoice-data.json")
}
fn backup_dir(app: &AppHandle) -> PathBuf {
    root_dir(app).join("backups")
}
fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}
fn selftest_mode() -> bool {
    std::env::var_os("INVOICE_SELFTEST").is_some()
}
fn path_string(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// Write to a temp file first, then swap it in, so a crash or power cut
/// can never leave a half-written data file behind.
fn write_atomic(file: &Path, text: &str) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = file.with_extension("json.tmp");
    fs::write(&tmp, text)?;
    if fs::rename(&tmp, file).is_err() {
        fs::write(file, text)?;
        let _ = fs::remove_file(&tmp);
    }
    Ok(())
}

/// Backup file names, newest first: invoice-data-YYYY-MM-DD.json
fn list_backups(app: &AppHandle) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(backup_dir(app))
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| n.len() == 28 && n.starts_with("invoice-data-") && n.ends_with(".json"))
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names.reverse();
    names
}

/// Once a day, copy the (valid) data file into backups/ and keep the newest 30.
fn daily_backup(app: &AppHandle) -> Result<(), String> {
    let f = data_file(app);
    if !f.exists() {
        return Ok(());
    }
    let text = fs::read_to_string(&f).map_err(|e| e.to_string())?;
    serde_json::from_str::<Value>(&text).map_err(|e| format!("not backing up a damaged file: {e}"))?;
    fs::create_dir_all(backup_dir(app)).map_err(|e| e.to_string())?;
    let target = backup_dir(app).join(format!("invoice-data-{}.json", today()));
    if !target.exists() {
        fs::write(&target, &text).map_err(|e| e.to_string())?;
    }
    for old in list_backups(app).into_iter().skip(30) {
        let _ = fs::remove_file(backup_dir(app).join(old));
    }
    Ok(())
}

fn clean_name(s: &str) -> String {
    let replaced: String = s
        .chars()
        .map(|c| if "\\/:*?\"<>|".contains(c) || c.is_control() { '-' } else { c })
        .collect();
    let trimmed = replaced.trim().trim_end_matches(['.', ' ']);
    let short: String = trimmed.chars().take(150).collect();
    if short.is_empty() { "Invoice".into() } else { short }
}
fn valid_month(m: &str) -> bool {
    m.len() == 7 && m.chars().enumerate().all(|(i, c)| if i == 4 { c == '-' } else { c.is_ascii_digit() })
}
/// The page may only open/reveal files inside Documents/Tuition Invoices.
fn is_inside(app: &AppHandle, p: &str) -> bool {
    let p = Path::new(p);
    p.starts_with(root_dir(app)) && !p.components().any(|c| matches!(c, Component::ParentDir))
}

// ---------- commands the page can call (see bridge.js) ----------
#[derive(Serialize, Default)]
struct Loaded {
    data: Option<Value>,
    path: String,
    recovered: Option<String>,
    damaged: Option<String>,
}

#[tauri::command]
fn load_data(app: AppHandle) -> Loaded {
    let f = data_file(&app);
    let path = path_string(&f);
    if !f.exists() {
        return Loaded { path, ..Default::default() };
    }
    let parsed = fs::read_to_string(&f)
        .map_err(|e| e.to_string())
        .and_then(|t| serde_json::from_str::<Value>(&t).map_err(|e| e.to_string()));
    if let Ok(data) = parsed {
        return Loaded { data: Some(data), path, ..Default::default() };
    }
    // Damaged file: keep it aside and fall back to the newest good backup.
    let damaged = f.with_file_name(format!("invoice-data.damaged-{}.json", chrono::Local::now().timestamp_millis()));
    let _ = fs::rename(&f, &damaged);
    let damaged = Some(path_string(&damaged));
    for name in list_backups(&app) {
        if let Ok(text) = fs::read_to_string(backup_dir(&app).join(&name)) {
            if let Ok(data) = serde_json::from_str::<Value>(&text) {
                let _ = write_atomic(&f, &text);
                return Loaded { data: Some(data), path, recovered: Some(name), damaged };
            }
        }
    }
    Loaded { path, damaged, ..Default::default() }
}

#[tauri::command]
fn save_data(app: AppHandle, text: String) -> Result<(), String> {
    serde_json::from_str::<Value>(&text).map_err(|e| format!("refusing to save invalid data: {e}"))?;
    write_atomic(&data_file(&app), &text).map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct PdfResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}
impl PdfResult {
    fn err(msg: impl Into<String>) -> Self {
        PdfResult { path: None, error: Some(msg.into()) }
    }
}

#[tauri::command]
async fn save_pdf(app: AppHandle, window: WebviewWindow, month: String, file_name: String) -> PdfResult {
    let folder = if valid_month(&month) { month } else { "Other".into() };
    let dir = root_dir(&app).join(folder);
    if let Err(e) = fs::create_dir_all(&dir) {
        return PdfResult::err(format!("Could not create the folder: {e}"));
    }
    let file = dir.join(format!("{}.pdf", clean_name(&file_name)));
    // Windows locks a PDF that is open in a reader; find out before rendering.
    if file.exists() && fs::OpenOptions::new().write(true).open(&file).is_err() {
        return PdfResult::err("That PDF is open in another program. Close it and try again.");
    }
    match pdf::print_to_pdf(&window, &file).await {
        Ok(()) if file.exists() => PdfResult { path: Some(path_string(&file)), error: None },
        Ok(()) => PdfResult::err("The PDF was not created."),
        Err(e) => PdfResult::err(format!("Could not save the PDF: {e}")),
    }
}

#[tauri::command]
fn open_path(app: AppHandle, path: String) -> Result<(), String> {
    if !is_inside(&app, &path) {
        return Err("not allowed".into());
    }
    app.opener().open_path(path, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn show_in_folder(app: AppHandle, path: String) -> Result<(), String> {
    if !is_inside(&app, &path) {
        return Err("not allowed".into());
    }
    app.opener().reveal_item_in_dir(path).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_folder(app: AppHandle) -> Result<(), String> {
    let dir = root_dir(&app);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    app.opener().open_path(path_string(&dir), None::<&str>).map_err(|e| e.to_string())
}

// Dialogs block until the user picks a file, so these run as async commands (off the UI thread).
#[tauri::command]
async fn export_backup(app: AppHandle, text: String) -> Result<Option<String>, String> {
    let docs = app.path().document_dir().unwrap_or_else(|_| root_dir(&app));
    let picked = app
        .dialog()
        .file()
        .set_title("Save a backup copy")
        .set_directory(docs)
        .set_file_name(format!("cikgu-pay-backup-{}.json", today()))
        .add_filter("Backup file", &["json"])
        .blocking_save_file();
    let Some(picked) = picked else { return Ok(None) };
    let p = picked.into_path().map_err(|e| e.to_string())?;
    fs::write(&p, text).map_err(|e| e.to_string())?;
    Ok(Some(path_string(&p)))
}

#[tauri::command]
async fn import_backup(app: AppHandle) -> Result<Option<String>, String> {
    let start = if backup_dir(&app).exists() { backup_dir(&app) } else { app.path().document_dir().unwrap_or_else(|_| root_dir(&app)) };
    let picked = app
        .dialog()
        .file()
        .set_title("Restore from a backup")
        .set_directory(start)
        .add_filter("Backup file", &["json"])
        .blocking_pick_file();
    let Some(picked) = picked else { return Ok(None) };
    let p = picked.into_path().map_err(|e| e.to_string())?;
    fs::read_to_string(p).map(Some).map_err(|e| e.to_string())
}

// ---------- self-test (only active when INVOICE_SELFTEST is set) ----------
#[derive(Default)]
struct Selftest {
    phase: Mutex<u32>,
    report: Mutex<serde_json::Map<String, Value>>,
}

fn write_selftest_result(app: &AppHandle, report: &serde_json::Map<String, Value>, extra_error: Option<&str>) -> bool {
    let root = root_dir(app);
    let mut out = report.clone();
    if let Some(e) = extra_error {
        out.insert("error".into(), e.into());
    }
    // Every PDF that was written, with its size.
    let mut pdfs = vec![];
    if let Ok(rd) = fs::read_dir(&root) {
        for month in rd.flatten().filter(|e| e.path().is_dir()) {
            if let Ok(files) = fs::read_dir(month.path()) {
                for f in files.flatten().filter(|f| f.path().extension().is_some_and(|x| x == "pdf")) {
                    let size = f.metadata().map(|m| m.len()).unwrap_or(0);
                    pdfs.push(serde_json::json!([format!("{}/{}", month.file_name().to_string_lossy(), f.file_name().to_string_lossy()), size]));
                }
            }
        }
    }
    out.insert("pdfs".into(), Value::Array(pdfs));
    out.insert("dataFileBytes".into(), fs::metadata(data_file(app)).map(|m| m.len()).unwrap_or(0).into());
    out.insert("backups".into(), list_backups(app).into());
    let no_js_errors = out.get("run").and_then(|r| r.get("errors")).and_then(|e| e.as_array()).is_some_and(|a| a.is_empty());
    let ok = !out.contains_key("error") && no_js_errors;
    out.insert("ok".into(), ok.into());
    let _ = fs::create_dir_all(&root);
    let _ = fs::write(root.join("selftest-result.json"), serde_json::to_string_pretty(&out).unwrap_or_default());
    ok
}

#[tauri::command]
fn selftest_phase(st: State<Selftest>) -> Result<u32, String> {
    if !selftest_mode() {
        return Err("not in selftest mode".into());
    }
    let mut p = st.phase.lock().unwrap();
    *p += 1;
    Ok(*p)
}

#[tauri::command]
fn selftest_report(st: State<Selftest>, key: String, value: Value) -> Result<(), String> {
    if !selftest_mode() {
        return Err("not in selftest mode".into());
    }
    st.report.lock().unwrap().insert(key, value);
    Ok(())
}

#[tauri::command]
fn selftest_finish(app: AppHandle, st: State<Selftest>) -> Result<(), String> {
    if !selftest_mode() {
        return Err("not in selftest mode".into());
    }
    let ok = write_selftest_result(&app, &st.report.lock().unwrap(), None);
    app.exit(if ok { 0 } else { 1 });
    Ok(())
}

// ---------- window ----------
/// Pages the window may show: the packaged app (tauri://localhost on Linux/macOS,
/// http(s)://tauri.localhost on Windows) and, in `npm start` dev builds, the dev server.
fn is_app_url(url: &tauri::Url, dev_url: Option<&tauri::Url>) -> bool {
    url.scheme() == "tauri"
        || url.host_str() == Some("tauri.localhost")
        || dev_url.is_some_and(|d| d.origin() == url.origin())
}

fn main() {
    let mut builder = tauri::Builder::default();
    if !selftest_mode() {
        // Only one copy at a time, so two windows can't overwrite each other's data.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }));
    }
    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Selftest::default())
        .invoke_handler(tauri::generate_handler![
            load_data, save_data, save_pdf, open_path, show_in_folder, open_folder, export_backup, import_backup,
            selftest_phase, selftest_report, selftest_finish
        ])
        .setup(|app| {
            if let Err(e) = daily_backup(app.handle()) {
                eprintln!("backup skipped: {e}");
            }
            if selftest_mode() {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(240));
                    let report = handle.state::<Selftest>().report.lock().unwrap().clone();
                    write_selftest_result(&handle, &report, Some("timeout"));
                    std::process::exit(1);
                });
            }
            // `tauri dev` serves the page from a local dev server; release builds never have one.
            let dev_url = if cfg!(debug_assertions) { app.config().build.dev_url.clone() } else { None };
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Cikgu Pay")
                .inner_size(1300.0, 900.0)
                .min_inner_size(900.0, 600.0)
                // Show the window straight away (hidden only for the self-test), so a page
                // that fails to load can never leave an invisible app running.
                .visible(!selftest_mode())
                .maximized(!selftest_mode())
                .on_navigation(move |url| is_app_url(url, dev_url.as_ref())) // stay on our page
                .on_page_load(|w, payload| {
                    if selftest_mode() && payload.event() == PageLoadEvent::Finished {
                        let _ = w.eval(include_str!("../selftest.js"));
                    }
                })
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Cikgu Pay");
}
