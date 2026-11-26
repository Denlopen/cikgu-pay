// Builds ui/ (what Tauri shows) from the Electron app's screen, so both apps share ONE invoice UI.
//   ../app/renderer/index.html  →  ui/index.html  (+ bridge.js)
//   with --smooth: also adds the animation layer (../app/renderer/motion.css + motion.js)
// Runs automatically before `tauri dev` / `tauri build` (see src-tauri/tauri.conf.json,
// and tauri.smooth.conf.json for the Smooth edition).
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { readUI, smooth } from '../../app/scripts/editions.mjs';

const root = new URL('../', import.meta.url);
const edition = process.argv.includes('--smooth') ? 'smooth' : 'plain';

let html = readUI();
const before = html;

// Tauri sets the Content-Security-Policy itself (tauri.conf.json → app.security.csp).
html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\n?/, '');
// Load the bridge before the app script, so window.invoiceApp exists when the page boots.
const marker = '<script>\nconst KEY';
if (!html.includes(marker)) throw new Error('sync-ui: could not find the main <script> in app/renderer/index.html');
html = html.replace(marker, () => '<script src="bridge.js"></script>\n' + marker);
if (html === before) throw new Error('sync-ui: nothing changed – unexpected');
if (edition === 'smooth') html = smooth(html);

// Only write files whose content changed: `tauri dev` live-reloads the window when ui/ changes, and a
// reload while the app is starting (e.g. during the selftest) would run the page twice.
mkdirSync(new URL('ui/', root), { recursive: true });
const put = (name, text) => {
  const f = new URL('ui/' + name, root);
  if (existsSync(f) && readFileSync(f, 'utf8') === text) return false;
  writeFileSync(f, text); return true;
};
const changed = [put('index.html', html), put('bridge.js', readFileSync(new URL('bridge/bridge.js', root), 'utf8'))].some(Boolean);
console.log(`sync-ui: ui/ ${changed ? 'updated' : 'already up to date'} (${edition} edition)`);
