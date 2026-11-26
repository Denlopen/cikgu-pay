// Tauri's version of the Electron preload.js.
// Gives the page the exact same window.invoiceApp object, but every call goes to a
// Rust command in src-tauri/src/main.rs instead of to Node.js.
(() => {
  const T = window.__TAURI__;
  if (!T) return;                 // opened as a plain web page → the app falls back to localStorage
  const invoke = T.core.invoke;
  let onError = msg => console.error(msg);

  // Saves happen on every keystroke. Queue them so they reach the disk in order,
  // and if several pile up while one is writing, only the newest is written next.
  let writing = false, pending = null;
  async function flush() {
    if (writing) return;
    writing = true;
    while (pending !== null) {
      const text = pending; pending = null;
      try { await invoke('save_data', { text }); } catch (e) { onError(String(e)); }
    }
    writing = false;
  }

  window.invoiceApp = {
    load: () => invoke('load_data'),
    save: text => { pending = text; flush(); },
    onSaveError: cb => { onError = cb; },
    savePdf: (month, fileName) => invoke('save_pdf', { month, fileName }),
    openPath: path => invoke('open_path', { path }),
    showInFolder: path => invoke('show_in_folder', { path }),
    openFolder: () => invoke('open_folder'),
    exportBackup: text => invoke('export_backup', { text }),
    importBackup: () => invoke('import_backup'),
  };
})();
