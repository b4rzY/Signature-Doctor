// Refresh checked-in browser assets after dependency upgrades.
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
await mkdir('public/vendor', {recursive:true});
await mkdir('public/fonts', {recursive:true});
for (const [from,to] of [
 ['gsap/dist/gsap.min.js','vendor/gsap.min.js'],
 ['@fontsource-variable/manrope/files/manrope-latin-wght-normal.woff2','fonts/manrope-latin.woff2'],
 ['@fontsource-variable/manrope/LICENSE','fonts/OFL.txt'],
 ['lucide-static/LICENSE','vendor/lucide-LICENSE.txt'],
]) await copyFile(`node_modules/${from}`,`public/${to}`);
const mapping = {
  "grid": "panels-top-left",
  "scan": "scan-line",
  "list": "list-filter",
  "clock": "history",
  "export": "download",
  "chevron": "chevron-right",
  "chevrondown": "chevrons-up-down",
  "search": "search",
  "plus": "plus",
  "arrow": "arrow-right",
  "up": "arrow-up-right",
  "check": "check",
  "circlecheck": "circle-check",
  "warning": "triangle-alert",
  "pulse": "activity",
  "link": "plug",
  "book": "book-open",
  "code": "code-xml",
  "target": "crosshair",
  "branch": "git-compare-arrows",
  "close": "x",
  "edit": "square-pen",
  "trash": "trash-2",
  "upload": "upload",
  "file": "file-json",
  "terminal": "terminal",
  "copy": "copy",
  "shield": "shield-check",
  "menu": "panel-left",
  "reset": "rotate-ccw",
  "info": "info",
  "command": "command",
  "folder": "folder-open",
  "settings": "settings-2",
  "cpu": "cpu",
  "arrowdown": "arrow-down",
  "arrowup": "arrow-up",
  "checklist": "list-checks"
};
const paths={};
for(const [key,name] of Object.entries(mapping)) {
 const svg=await readFile(`node_modules/lucide-static/icons/${name}.svg`,'utf8');
 paths[key]=svg.slice(svg.indexOf('>',svg.indexOf('<svg'))+1,svg.indexOf('</svg>')).trim();
}
await writeFile('public/icons.mjs', '// Lucide icons, ISC license. See vendor/lucide-LICENSE.txt.\nconst paths = '+JSON.stringify(paths,null,2)+';\n'+`export function icon(name, size = 18) {
 return \`<svg width="\${size}" height="\${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">\${paths[name] ?? paths.file}</svg>\`;
}
`);
