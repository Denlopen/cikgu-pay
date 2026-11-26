// Writes the standalone single-file versions (no install needed, open in a browser):
//   ../invoice-maker.html         plain
//   ../invoice-maker-smooth.html  with animations
import { writeFileSync } from 'node:fs';
import { readUI, smooth } from './editions.mjs';

const out = new URL('../../', import.meta.url);
const html = readUI();
writeFileSync(new URL('invoice-maker.html', out), html);
writeFileSync(new URL('invoice-maker-smooth.html', out), smooth(html));
console.log('build-html: invoice-maker.html + invoice-maker-smooth.html updated');
