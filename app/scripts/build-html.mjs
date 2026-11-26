// Writes the standalone single-file versions (no install needed, open in a browser):
//   ../cikgu-pay.html         plain
//   ../cikgu-pay-smooth.html  with animations
import { writeFileSync } from 'node:fs';
import { readUI, smooth } from './editions.mjs';

const out = new URL('../../', import.meta.url);
const html = readUI();
writeFileSync(new URL('cikgu-pay.html', out), html);
writeFileSync(new URL('cikgu-pay-smooth.html', out), smooth(html));
console.log('build-html: cikgu-pay.html + cikgu-pay-smooth.html updated');
