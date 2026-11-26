// Builds ui/ (what Tauri shows) from the Electron app's screen, so both apps share ONE invoice UI.
//   ../app/renderer/index.html  →  ui/index.html  (+ bridge.js)
//   with --smooth: also adds the animation layer (../app/renderer/motion.css + motion.js)
// Runs automatically before `tauri dev` / `tauri build` (see src-tauri/tauri.conf.json,
// and tauri.smooth.conf.json for the Smooth edition).
import { writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
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

mkdirSync(new URL('ui/', root), { recursive: true });
writeFileSync(new URL('ui/index.html', root), html);
copyFileSync(new URL('bridge/bridge.js', root), new URL('ui/bridge.js', root));
console.log(`sync-ui: ui/ updated from app/renderer/index.html (${edition} edition)`);
