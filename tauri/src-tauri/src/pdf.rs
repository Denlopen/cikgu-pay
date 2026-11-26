// "Save PDF" – the part Tauri doesn't have built in (Electron has webContents.printToPDF).
// Each operating system's web engine has its own API, so there is one version per platform:
//   Windows → WebView2 (Edge/Chromium)   ICoreWebView2_7::PrintToPdf
//   Linux   → WebKitGTK                   WebKitPrintOperation to a "Print to File" printer
use std::path::Path;
use std::sync::{Arc, Mutex};
use tauri::WebviewWindow;
use tokio::sync::oneshot;

type Reply = Arc<Mutex<Option<oneshot::Sender<Result<(), String>>>>>;

fn reply(tx: &Reply, r: Result<(), String>) {
    if let Some(s) = tx.lock().unwrap().take() {
        let _ = s.send(r);
    }
}

// A4 with the same margins as the page's CSS (@page { margin: 17mm 20mm }).
#[allow(dead_code)]
const A4_MM: (f64, f64) = (210.0, 297.0);
#[allow(dead_code)]
const MARGIN_MM: (f64, f64) = (17.0, 20.0); // (top/bottom, left/right)

#[cfg(windows)]
pub async fn print_to_pdf(window: &WebviewWindow, file: &Path) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Environment6, ICoreWebView2_7, COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT,
    };
    use webview2_com::PrintToPdfCompletedHandler;
    use windows_core::{Interface, HSTRING};

    let (tx, rx) = oneshot::channel();
    let tx: Reply = Arc::new(Mutex::new(Some(tx)));
    let path = HSTRING::from(file.as_os_str());
    let inch = |mm: f64| mm / 25.4;

    let tx_outer = tx.clone();
    window
        .with_webview(move |wv| {
            // Runs on the UI thread, where WebView2 must be used.
            let started = (|| -> windows_core::Result<()> {
                unsafe {
                    let core7: ICoreWebView2_7 = wv.controller().CoreWebView2()?.cast()?;
                    let env6: ICoreWebView2Environment6 = wv.environment().cast()?;
                    let s = env6.CreatePrintSettings()?;
                    s.SetOrientation(COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT)?;
                    s.SetPageWidth(inch(A4_MM.0))?;
                    s.SetPageHeight(inch(A4_MM.1))?;
                    s.SetMarginTop(inch(MARGIN_MM.0))?;
                    s.SetMarginBottom(inch(MARGIN_MM.0))?;
                    s.SetMarginLeft(inch(MARGIN_MM.1))?;
                    s.SetMarginRight(inch(MARGIN_MM.1))?;
                    s.SetShouldPrintBackgrounds(true)?;
                    s.SetShouldPrintHeaderAndFooter(false)?; // no URL/date; our own header/footer come from CSS
                    let tx_done = tx.clone();
                    let handler = PrintToPdfCompletedHandler::create(Box::new(move |result, success| {
                        reply(&tx_done, match result {
                            Ok(()) if success => Ok(()),
                            Ok(()) => Err("WebView2 reported that printing failed".into()),
                            Err(e) => Err(e.message().to_string()),
                        });
                        Ok(())
                    }));
                    core7.PrintToPdf(&path, &s, &handler)?;
                }
                Ok(())
            })();
            if let Err(e) = started {
                reply(&tx, Err(format!("WebView2: {}", e.message())));
            }
        })
        .map_err(|e| e.to_string())?;
    let _ = tx_outer;
    rx.await.map_err(|_| "PDF export was interrupted".to_string())?
}

#[cfg(target_os = "linux")]
pub async fn print_to_pdf(window: &WebviewWindow, file: &Path) -> Result<(), String> {
    use webkit2gtk::{PrintOperation, PrintOperationExt};

    let (tx, rx) = oneshot::channel();
    let tx: Reply = Arc::new(Mutex::new(Some(tx)));
    let uri = tauri::Url::from_file_path(file).map_err(|_| "bad file path".to_string())?.to_string();

    window
        .with_webview(move |wv| {
            let op = PrintOperation::new(&wv.inner());
            let settings = gtk::PrintSettings::new();
            settings.set(&gtk::PRINT_SETTINGS_PRINTER, Some("Print to File"));
            settings.set(&gtk::PRINT_SETTINGS_OUTPUT_FILE_FORMAT, Some("pdf"));
            settings.set(&gtk::PRINT_SETTINGS_OUTPUT_URI, Some(&uri));
            op.set_print_settings(&settings);
            let setup = gtk::PageSetup::new();
            setup.set_paper_size(&gtk::PaperSize::new(Some(&gtk::PAPER_NAME_A4)));
            setup.set_top_margin(MARGIN_MM.0, gtk::Unit::Mm);
            setup.set_bottom_margin(MARGIN_MM.0, gtk::Unit::Mm);
            setup.set_left_margin(MARGIN_MM.1, gtk::Unit::Mm);
            setup.set_right_margin(MARGIN_MM.1, gtk::Unit::Mm);
            op.set_page_setup(&setup);
            let t1 = tx.clone();
            op.connect_finished(move |_| reply(&t1, Ok(())));
            let t2 = tx.clone();
            op.connect_failed(move |_, e| reply(&t2, Err(e.to_string())));
            op.print(); // no dialog: straight to the "Print to File" printer
        })
        .map_err(|e| e.to_string())?;
    rx.await.map_err(|_| "PDF export was interrupted".to_string())?
}

#[cfg(not(any(windows, target_os = "linux")))]
pub async fn print_to_pdf(_window: &WebviewWindow, _file: &Path) -> Result<(), String> {
    Err("Saving PDFs is not supported on this system yet – use Print instead.".into())
}
