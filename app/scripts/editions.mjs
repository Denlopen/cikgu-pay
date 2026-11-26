// Builds the two editions of the invoice screen from ONE source (renderer/index.html):
//   plain  = index.html as it is
//   smooth = index.html + renderer/motion.css + renderer/motion.js (animations)
// Used by scripts/build-html.mjs (standalone files) and by ../tauri/scripts/sync-ui.mjs.
import { readFileSync } from 'node:fs';

const renderer = new URL('../renderer/', import.meta.url);
const read = name => readFileSync(new URL(name, renderer), 'utf8');

export const readUI = () => read('index.html');

export function smooth(html) {
  if (!html.includes('</head>') || !html.includes('</body>')) throw new Error('editions: unexpected index.html layout');
  const css = read('motion.css'), js = read('motion.js');
  // Function replacers: CSS/JS text is inserted literally (no special "$&" handling).
  return html
    .replace('</head>', () => `<style id="motion-css">\n${css}</style>\n</head>`)
    .replace(/<\/body>(?![\s\S]*<\/body>)/, () => `<script id="motion-js">\n${js}</script>\n</body>`);
}
