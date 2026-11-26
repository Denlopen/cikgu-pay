'use strict';
// Main process: owns the window, the data file on disk, and PDF export.
// The page (renderer) never touches the disk directly — it asks through preload.js.

const { app, BrowserWindow, ipcMain, shell, dialog, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const SELFTEST = !!process.env.INVOICE_SELFTEST;
let win = null;

// ---------- where things live ----------
// Documents\Tuition Invoices\
//   invoice-data.json        <- all students / invoices / settings
//   backups\                 <- one copy per day, last 30 kept
//   2026-08\<name>.pdf       <- exported invoices, one folder per month
const rootDir = () => process.env.INVOICE_DATA_DIR || path.join(app.getPath('documents'), 'Tuition Invoices');
const dataFile = () => path.join(rootDir(), 'invoice-data.json');
const backupDir = () => path.join(rootDir(), 'backups');

const ensureDir = d => fs.mkdirSync(d, { recursive: true });
const pad = n => String(n).padStart(2, '0');
const today = () => { const t = new Date(); return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`; };
const cleanName = s => String(s || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').replace(/[. ]+$/, '').trim().slice(0, 150) || 'Invoice';
const isInside = p => typeof p === 'string' && path.resolve(p).startsWith(path.resolve(rootDir()) + path.sep);

// Write to a temp file first, then swap it in, so a crash or power cut
// can never leave a half-written data file behind.
function writeAtomic(file, text) {
  ensureDir(path.dirname(file));
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  try { fs.renameSync(tmp, file); }
  catch { fs.writeFileSync(file, text, 'utf8'); try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
}

function listBackups() {
  if (!fs.existsSync(backupDir())) return [];
  return fs.readdirSync(backupDir()).filter(n => /^invoice-data-\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort().reverse();
}

// Once a day, copy the (valid) data file into backups\ and keep the newest 30.
function dailyBackup() {
  const f = dataFile();
  if (!fs.existsSync(f)) return;
  const text = fs.readFileSync(f, 'utf8');
  JSON.parse(text); // never back up a damaged file
  ensureDir(backupDir());
  const target = path.join(backupDir(), `invoice-data-${today()}.json`);
  if (!fs.existsSync(target)) fs.writeFileSync(target, text, 'utf8');
  for (const n of listBackups().slice(30)) fs.unlinkSync(path.join(backupDir(), n));
}

function loadData() {
  const f = dataFile();
  if (!fs.existsSync(f)) return { data: null, path: f };
  try {
    return { data: JSON.parse(fs.readFileSync(f, 'utf8')), path: f };
  } catch {
    // Damaged file: keep it aside and fall back to the newest good backup.
    const damaged = f.replace(/\.json$/, `.damaged-${Date.now()}.json`);
    try { fs.renameSync(f, damaged); } catch { /* ignore */ }
    for (const n of listBackups()) {
      try {
        const text = fs.readFileSync(path.join(backupDir(), n), 'utf8');
        const data = JSON.parse(text);
        writeAtomic(f, text);
        return { data, path: f, recovered: n, damaged };
      } catch { /* try the next older one */ }
    }
    return { data: null, path: f, damaged };
  }
}

// ---------- IPC: what the page is allowed to ask for ----------
ipcMain.handle('data:load', () => loadData());

ipcMain.on('data:save', (e, text) => {
  try { JSON.parse(text); writeAtomic(dataFile(), text); }
  catch (err) { e.sender.send('data:save-error', String(err.message || err)); }
});

ipcMain.handle('pdf:save', async (e, { month, fileName }) => {
  const folder = /^\d{4}-\d{2}$/.test(month) ? month : 'Other';
  const dir = path.join(rootDir(), folder);
  ensureDir(dir);
  const file = path.join(dir, cleanName(fileName) + '.pdf');
  // Same engine as Chrome's "Save as PDF"; uses the page's @media print styles.
  const pdf = await e.sender.printToPDF({ pageSize: 'A4', printBackground: true, preferCSSPageSize: true });
  try { fs.writeFileSync(file, pdf); }
  catch (err) {
    if (err.code === 'EBUSY' || err.code === 'EPERM') return { error: 'That PDF is open in another program. Close it and try again.' };
    return { error: 'Could not save the PDF: ' + err.message };
  }
  return { path: file };
});

ipcMain.handle('shell:open', (_e, p) => (isInside(p) ? shell.openPath(p) : 'not allowed'));
ipcMain.handle('shell:show', (_e, p) => { if (isInside(p)) shell.showItemInFolder(p); });
ipcMain.handle('folder:open', () => { ensureDir(rootDir()); return shell.openPath(rootDir()); });

ipcMain.handle('backup:export', async (_e, text) => {
  const r = await dialog.showSaveDialog(win, {
    title: 'Save a backup copy',
    defaultPath: path.join(app.getPath('documents'), `cikgu-pay-backup-${today()}.json`),
    filters: [{ name: 'Backup file', extensions: ['json'] }],
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, text, 'utf8');
  return r.filePath;
});

ipcMain.handle('backup:import', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Restore from a backup',
    defaultPath: fs.existsSync(backupDir()) ? backupDir() : app.getPath('documents'),
    properties: ['openFile'],
    filters: [{ name: 'Backup file', extensions: ['json'] }],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  return fs.readFileSync(r.filePaths[0], 'utf8');
});

// ---------- window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1300, height: 900, minWidth: 900, minHeight: 600,
    title: 'Cikgu Pay',
    icon: path.join(__dirname, 'build', 'icon.png'),
    backgroundColor: '#eef0f3',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true,
    },
  });
  win.once('ready-to-show', () => { if (!SELFTEST) { win.maximize(); win.show(); } });
  win.webContents.on('will-navigate', e => e.preventDefault());       // stay on our page
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));   // no pop-up windows
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// Only one copy of the app at a time, so two windows can't overwrite each other's data.
if (!SELFTEST && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  Menu.setApplicationMenu(null);
  app.whenReady().then(() => {
    try { dailyBackup(); } catch (err) { console.error('backup skipped:', err.message); }
    createWindow();
    if (SELFTEST) require('./selftest')(win);
  });
  app.on('window-all-closed', () => app.quit());
}
