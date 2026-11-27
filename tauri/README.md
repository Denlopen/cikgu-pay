# Cikgu Pay: Tauri version

The same app as `../app` (Electron), rebuilt with [Tauri 2](https://tauri.app). Both versions use the same invoice screen, data file and PDF names. Only the code underneath differs.

| | Electron (`../app`) | Tauri (this folder) |
|---|---|---|
| Windows installer | 121 MB | **1.2 MB** |
| Installed size | ~300 MB | **3.5 MB** |
| Browser engine | Bundled Chromium | Windows' own WebView2 (Edge) · WebKitGTK on Linux |
| Back-end code | `main.js` (JavaScript) | `src-tauri/src/main.rs` + `pdf.rs` (Rust) |
| Save PDF | `webContents.printToPDF()` | Hand-written per OS in `pdf.rs` (WebView2 `PrintToPdf` / WebKitGTK print-to-file) |

## How the pieces fit
```
../app/renderer/index.html  ──(scripts/sync-ui.mjs)──►  ui/index.html   ← the screen (shared with Electron, never edit ui/)
bridge/bridge.js            ──────────────────────────►  ui/bridge.js    ← defines window.invoiceApp → invoke('rust_command')
src-tauri/src/main.rs        Rust commands: load_data, save_data, save_pdf, open_path, …, backups, single-instance
src-tauri/src/pdf.rs         Save PDF for Windows (WebView2) and Linux (WebKitGTK)
src-tauri/selftest.js        injected only when INVOICE_SELFTEST=1
```
The page only ever calls `window.invoiceApp.*`. In Electron, `preload.js` provides that object; here `bridge.js` does. That's why the same HTML works in both.

## Commands
```bash
npm install                 # once (Tauri CLI)
npm start                   # run on Linux (tauri dev)
npm run selftest            # automated test → .selftest/selftest-result.json
npm run build:win           # Windows installer → dist/Cikgu-Pay-Setup-1.5.0.exe

# Smooth edition (same app + animations from ../app/renderer/motion.css + motion.js)
npm run start:smooth
npm run selftest:smooth
npm run build:win:smooth    # → dist/Cikgu-Pay-Smooth-Setup-1.5.0.exe
```
Both editions are the same app (same identifier and data), so installing one replaces the other on Windows.
Data goes to `~/Documents/Tuition Invoices/`, the same folder the Electron version uses. Both apps read the same file. The folder keeps its old name on purpose: the app was called "Tuition Invoice Maker" before 1.3, and keeping the folder means existing data is found. Since 1.4 the user can pick another folder (Settings). The choice is stored in `%APPDATA%\io.github.denlopen.tuitioninvoice.tauri\storage.json`, outside the data folder. Moving copies every file, compares each copy byte for byte, switches over, and only then deletes the old copies. If a chosen folder is missing at start-up, the app loads and saves nothing until it's back or another folder is chosen. `src-tauri/windows/hooks.nsh` makes the installer remove an old "Tuition Invoice Maker" install (the program only, never the data).

## One-time setup for building the Windows installer on Linux
- Rust ≥ 1.90: `rustup update stable`, then `rustup target add x86_64-pc-windows-msvc`
- `cargo install --locked cargo-xwin` (installs into `~/.cargo/bin`, which `build:win` adds to PATH). On first use it downloads Microsoft's Windows SDK/CRT headers.
- NSIS ≥ 3.08 for the installer. Arch has no package, so it was built in user space:
  1. Download `nsis-3.12.zip` and `nsis-3.12-src.tar.bz2` (SourceForge). Unzip to `~/.local/share/nsis-3.12`.
  2. In the source: `scons SKIPSTUBS=all SKIPPLUGINS=all SKIPUTILS=all SKIPMISC=all NSIS_CONFIG_CONST_DATA_PATH=no PREFIX=~/.local/share/nsis-3.12 install-compiler`
  3. Move the binary to `~/.local/share/nsis-3.12/bin/makensis` (it looks for Stubs/ one level up). `~/.local/share/nsis-wrapper/makensis` points at it.
  - electron-builder's bundled NSIS 3.0.4 is too old (missing `Win\RestartManager.nsh` and newer COM headers).

## Testing the Windows build under wine
WebView2 does run under wine 11 once Microsoft's runtime is installed into a throwaway prefix:
```bash
export WINEPREFIX=$TMPDIR/wineprefix-wv2 WINEDEBUG=-all
wineboot -i; winecfg -v win10
wine MicrosoftEdgeWebView2RuntimeInstallerX64.exe /silent /install   # https://go.microsoft.com/fwlink/?linkid=2124701
INVOICE_SELFTEST=1 INVOICE_DATA_DIR='Z:\some\dir' WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--no-sandbox --disable-gpu" \
  wine src-tauri/target/x86_64-pc-windows-msvc/release/cikgu-pay.exe
```

## Known differences
- On **Linux** (WebKitGTK), CSS `@page` margin boxes aren't supported, so the page-number header prints at the top and the footer right under the content (`body.no-margin-boxes` in the shared CSS). WebKitGTK prints at the desktop scale factor (e.g. 125%), so mm-based heights don't hold. Linux PDFs are also ~550 KB instead of ~35 KB. Windows (WebView2 = Chromium) output matches Electron.
- Windows 10/11 already include WebView2. On a PC without it, the installer downloads it (needs internet once).
