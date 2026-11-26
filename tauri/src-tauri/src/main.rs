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
// Documents/Tuition Invoices/   (default; the user can pick another folder in Settings)
//   invoice-data.json        <- all students / invoices / settings
//   backups/                 <- one copy per day, last 30 kept
//   2026-08/<name>.pdf       <- exported documents, one folder per month
fn default_dir(app: &AppHandle) -> PathBuf {
    if let Some(dir) = std::env::var_os("INVOICE_DATA_DIR") {
        return PathBuf::from(dir);
    }
    app.path()
        .document_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("Tuition Invoices")
}

/// The chosen folder is remembered in a tiny file in the app's own settings folder
/// (%APPDATA%\<identifier>\storage.json). It can't live inside the data folder: that's what it points to.
fn storage_config_file(app: &AppHandle) -> PathBuf {
    if let Some(dir) = std::env::var_os("INVOICE_DATA_DIR") {
        // tests: keep it next to the test data, never in the real settings folder
        let mut s = dir; s.push("-config"); return PathBuf::from(s).join("storage.json");
    }
    app.path().app_config_dir().unwrap_or_else(|_| std::env::temp_dir()).join("storage.json")
}
fn read_custom_dir(app: &AppHandle) -> Option<PathBuf> {
    let text = fs::read_to_string(storage_config_file(app)).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    v.get("dir").and_then(|d| d.as_str()).filter(|d| !d.is_empty()).map(PathBuf::from)
}
fn write_custom_dir(app: &AppHandle, dir: Option<&Path>) -> Result<(), String> {
    let f = storage_config_file(app);
    match dir {
        None => match fs::remove_file(&f) { Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()), _ => Ok(()) },
        Some(d) => write_atomic(&f, &serde_json::json!({ "dir": path_string(d) }).to_string()).map_err(|e| e.to_string()),
    }
}

/// Where the data is right now. The Mutex also makes saving and moving take turns,
/// so nothing is written into the old folder while it is being moved.
struct Storage {
    root: Mutex<PathBuf>,
    custom: Mutex<bool>,
}
fn root_dir(app: &AppHandle) -> PathBuf {
    app.state::<Storage>().root.lock().unwrap().clone()
}
/// A folder picked by the user that can't be found (USB drive unplugged, cloud drive not signed in…).
/// Nothing is saved while this is the case, so data never ends up in the wrong place.
fn missing_root(app: &AppHandle) -> Option<PathBuf> {
    let st = app.state::<Storage>();
    let root = st.root.lock().unwrap().clone();
    (*st.custom.lock().unwrap() && !root.is_dir()).then_some(root)
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
/// The page may only open/reveal files inside the invoices folder.
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
    missing: Option<String>,
}

#[tauri::command]
fn load_data(app: AppHandle) -> Loaded {
    if let Some(dir) = missing_root(&app) {
        return Loaded { path: path_string(&data_file(&app)), missing: Some(path_string(&dir)), ..Default::default() };
    }
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
                return Loaded { data: Some(data), path, recovered: Some(name), damaged, missing: None };
            }
        }
    }
    Loaded { path, damaged, ..Default::default() }
}

#[tauri::command]
fn save_data(app: AppHandle, text: String) -> Result<(), String> {
    serde_json::from_str::<Value>(&text).map_err(|e| format!("refusing to save invalid data: {e}"))?;
    if let Some(dir) = missing_root(&app) {
        return Err(format!("the invoices folder can't be found: {}", path_string(&dir)));
    }
    let st = app.state::<Storage>();
    let root = st.root.lock().unwrap();   // waits while a move is in progress
    write_atomic(&root.join("invoice-data.json"), &text).map_err(|e| e.to_string())
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


// ---------- choosing where the invoices are kept ----------
#[derive(Serialize)]
struct StorageInfo {
    dir: String,
    default_dir: String,
    is_default: bool,
    missing: bool,
}
#[tauri::command]
fn storage_info(app: AppHandle) -> StorageInfo {
    let dir = root_dir(&app);
    let def = default_dir(&app);
    StorageInfo { is_default: dir == def, missing: missing_root(&app).is_some(), dir: path_string(&dir), default_dir: path_string(&def) }
}

#[tauri::command]
async fn pick_folder(app: AppHandle) -> Result<Option<String>, String> {
    let start = root_dir(&app);
    let start = if start.is_dir() { start.parent().map(Path::to_path_buf).unwrap_or(start) } else { app.path().document_dir().unwrap_or(start) };
    let picked = app.dialog().file().set_title("Choose where to keep your invoices").set_directory(start).blocking_pick_folder();
    let Some(picked) = picked else { return Ok(None) };
    picked.into_path().map(|p| Some(path_string(&p))).map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct StoragePlan {
    target: String,       // the folder that will hold the data
    has_data: bool,       // it already contains invoices
    same: bool,           // it's the folder in use now
    problem: Option<String>,
}
/// The picked folder becomes the place for a "Tuition Invoices" folder, unless the picked folder
/// already holds invoices (or is called that). So picking "My Drive" never scatters files into it.
fn plan_target(picked: &Path) -> PathBuf {
    let named = picked.file_name().is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case("Tuition Invoices"));
    if picked.join("invoice-data.json").is_file() || named { picked.to_path_buf() } else { picked.join("Tuition Invoices") }
}
/// A comparable form of a path. Windows writes existing folders as `\\?\C:\...` after canonicalize()
/// but a folder that doesn't exist yet can't be canonicalized, so canonicalize the deepest part that
/// exists and add the rest back on. Then "is this inside that?" works whether or not the folders exist.
fn norm(p: &Path) -> PathBuf {
    let mut existing = p.to_path_buf();
    let mut rest: Vec<std::ffi::OsString> = vec![];
    loop {
        if let Ok(c) = fs::canonicalize(&existing) {
            let mut out = c;
            for part in rest.iter().rev() { out.push(part); }
            return out;
        }
        match (existing.file_name().map(|n| n.to_os_string()), existing.parent().map(Path::to_path_buf)) {
            (Some(name), Some(parent)) => { rest.push(name); existing = parent; }
            _ => return p.to_path_buf(),
        }
    }
}
#[tauri::command]
fn storage_plan(app: AppHandle, picked: String) -> StoragePlan {
    let picked = PathBuf::from(picked);
    let target = plan_target(&picked);
    let current = root_dir(&app);
    let (t, c) = (norm(&target), norm(&current));
    let problem = if !picked.is_dir() {
        Some("That folder can't be found.".into())
    } else if t != c && t.starts_with(&c) {
        Some("That folder is inside the current invoices folder. Please choose a folder somewhere else.".into())
    } else if fs::create_dir_all(&target).and_then(|_| fs::write(target.join(".write-test"), b"ok")).and_then(|_| fs::remove_file(target.join(".write-test"))).is_err() {
        let _ = fs::remove_dir(&target); // only removes it if we just created it empty
        Some("The app can't save files in that folder (it may be read-only).".into())
    } else {
        None
    };
    let has_data = target.join("invoice-data.json").is_file();
    if !has_data && problem.is_none() && t != c { let _ = fs::remove_dir(&target); } // don't leave an empty folder if she cancels
    StoragePlan { same: t == c, has_data, problem, target: path_string(&target) }
}

/// Every file under `dir`, as paths relative to it.
fn all_files(dir: &Path) -> std::io::Result<Vec<PathBuf>> {
    let mut out = vec![];
    let mut stack = vec![PathBuf::new()];
    while let Some(rel) = stack.pop() {
        for e in fs::read_dir(dir.join(&rel))? {
            let e = e?;
            let r = rel.join(e.file_name());
            if e.file_type()?.is_dir() { stack.push(r) } else { out.push(r) }
        }
    }
    Ok(out)
}

#[derive(Serialize)]
struct MoveResult {
    old: String,
    new: String,
    files: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    leftover: Option<String>,   // old copies that couldn't be removed (e.g. a PDF open in a reader)
}
/// Copy everything to the new folder, check every file arrived intact, switch over, then remove the
/// old copies. If anything goes wrong before the switch, the new copies are removed and nothing changes.
fn move_storage(app: &AppHandle, target: PathBuf, make_default: bool) -> Result<MoveResult, String> {
    let st = app.state::<Storage>();
    let mut root = st.root.lock().unwrap();   // no saving while moving
    let old = root.clone();
    if norm(&old) == norm(&target) {
        return Err("That is already the folder in use.".into());
    }
    if target.join("invoice-data.json").exists() {
        return Err("exists".into());
    }
    let files = if old.is_dir() { all_files(&old).map_err(|e| format!("Couldn't read the current folder: {e}"))? } else { vec![] };
    fs::create_dir_all(&target).map_err(|e| format!("Couldn't create the new folder: {e}"))?;
    let mut copied: Vec<PathBuf> = vec![];
    let undo = |copied: &[PathBuf]| { for f in copied.iter().rev() { let _ = fs::remove_file(target.join(f)); } };
    for rel in &files {
        let (from, to) = (old.join(rel), target.join(rel));
        if to.exists() {
            continue; // never overwrite something that is already there (e.g. a PDF with the same name)
        }
        let res = to.parent().map_or(Ok(()), fs::create_dir_all).and_then(|_| fs::copy(&from, &to)).and_then(|_| {
            if fs::read(&from)? == fs::read(&to)? { Ok(()) } else { Err(std::io::Error::other("the copy is different from the original")) }
        });
        if let Err(e) = res {
            let _ = fs::remove_file(&to);
            undo(&copied);
            return Err(format!("Couldn't copy {}: {e}. Nothing was changed.", path_string(rel)));
        }
        copied.push(rel.clone());
    }
    let switch = if make_default { write_custom_dir(app, None) } else { write_custom_dir(app, Some(&target)) };
    if let Err(e) = switch {
        undo(&copied);
        return Err(format!("Couldn't remember the new folder: {e}. Nothing was changed."));
    }
    *root = target.clone();
    *st.custom.lock().unwrap() = !make_default;
    // Switched. Now tidy up the old folder; failures here only leave harmless copies behind.
    for rel in &copied {
        let _ = fs::remove_file(old.join(rel));
    }
    if old.is_dir() {
        // remove the emptied month/backup folders, deepest first, and the old folder itself
        let mut dirs: Vec<PathBuf> = files.iter().filter_map(|f| f.parent().map(Path::to_path_buf)).filter(|d| !d.as_os_str().is_empty()).collect();
        dirs.sort_by_key(|d| std::cmp::Reverse(d.components().count()));
        dirs.dedup();
        for d in dirs { let _ = fs::remove_dir(old.join(d)); }
        let _ = fs::remove_dir(&old);
    }
    // anything still there (a PDF open in a reader, or a file that already existed in the new folder) stays put
    let leftover = (old.is_dir() && all_files(&old).is_ok_and(|f| !f.is_empty())).then(|| path_string(&old));
    Ok(MoveResult { old: path_string(&old), new: path_string(&target), files: copied.len(), leftover })
}

#[tauri::command]
fn storage_move(app: AppHandle, target: String) -> Result<MoveResult, String> {
    let target = PathBuf::from(target);
    let make_default = norm(&target) == norm(&default_dir(&app));
    move_storage(&app, target, make_default)
}
#[tauri::command]
fn storage_reset(app: AppHandle) -> Result<MoveResult, String> {
    let def = default_dir(&app);
    move_storage(&app, def, true)
}
/// Switch to a folder that already holds invoices (e.g. on a new laptop, or after the folder
/// was moved by hand). The data in the current folder is left exactly where it is.
#[tauri::command]
fn storage_use(app: AppHandle, target: String) -> Result<String, String> {
    let target = PathBuf::from(target);
    if !target.join("invoice-data.json").is_file() {
        return Err("No invoices were found in that folder.".into());
    }
    let st = app.state::<Storage>();
    let mut root = st.root.lock().unwrap();
    let is_default = norm(&target) == norm(&default_dir(&app));
    write_custom_dir(&app, if is_default { None } else { Some(&target) })?;
    *root = target.clone();
    *st.custom.lock().unwrap() = !is_default;
    Ok(path_string(&target))
}
/// Forget a folder that can't be found and go back to Documents\Tuition Invoices (nothing is moved).
#[tauri::command]
fn storage_forget(app: AppHandle) -> Result<String, String> {
    let st = app.state::<Storage>();
    let mut root = st.root.lock().unwrap();
    write_custom_dir(&app, None)?;
    *root = default_dir(&app);
    *st.custom.lock().unwrap() = false;
    Ok(path_string(&root))
}

/// Self-test only: rename a folder (to pretend a drive was unplugged and plugged back in).
#[tauri::command]
fn selftest_rename(from: String, to: String) -> Result<(), String> {
    if !selftest_mode() {
        return Err("not in selftest mode".into());
    }
    fs::rename(from, to).map_err(|e| e.to_string())
}
/// Self-test only: create a folder to "pick".
#[tauri::command]
fn selftest_mkdir(path: String) -> Result<(), String> {
    if !selftest_mode() {
        return Err("not in selftest mode".into());
    }
    fs::create_dir_all(path).map_err(|e| e.to_string())
}

// ---------- self-test (only active when INVOICE_SELFTEST is set) ----------
#[derive(Default)]
struct Selftest {
    phase: Mutex<u32>,
    report: Mutex<serde_json::Map<String, Value>>,
}

fn write_selftest_result(app: &AppHandle, report: &serde_json::Map<String, Value>, extra_error: Option<&str>) -> bool {
    let root = default_dir(app);
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
            storage_info, pick_folder, storage_plan, storage_move, storage_reset, storage_use, storage_forget,
            selftest_phase, selftest_report, selftest_finish, selftest_rename, selftest_mkdir
        ])
        .setup(|app| {
            let custom = read_custom_dir(app.handle());
            app.manage(Storage {
                root: Mutex::new(custom.clone().unwrap_or_else(|| default_dir(app.handle()))),
                custom: Mutex::new(custom.is_some()),
            });
            if missing_root(app.handle()).is_some() {
                eprintln!("invoices folder not found; backup skipped");
            } else if let Err(e) = daily_backup(app.handle()) {
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
