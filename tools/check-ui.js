/**
 * UI 静态一致性检查：把 popup / options 的 HTML 与 JS 对照，
 * 确认 JS 里 $('xxx') 引用的元素都存在于 HTML，避免运行时空指针。
 *
 * 用法：node tools/check-ui.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PAGES = [
  { name: 'popup', html: 'src/popup/popup.html', js: 'src/popup/popup.js' },
  { name: 'options', html: 'src/options/options.html', js: 'src/options/options.js' }
];

let problems = 0;

for (const page of PAGES) {
  const html = fs.readFileSync(path.join(ROOT, page.html), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, page.js), 'utf8');

  const ids = new Set();
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) ids.add(match[1]);

  // JS 里所有 $('xxx') / getElementById('xxx') 的引用
  const referenced = new Set();
  for (const match of js.matchAll(/\$\('([^']+)'\)/g)) referenced.add(match[1]);
  for (const match of js.matchAll(/getElementById\('([^']+)'\)/g)) referenced.add(match[1]);

  const missing = Array.from(referenced).filter((id) => !ids.has(id));
  const unused = Array.from(ids).filter((id) => !referenced.has(id));

  console.log(`\n${page.name} (${page.html})`);
  console.log(`  HTML 定义 ${ids.size} 个 id，JS 引用 ${referenced.size} 个`);
  if (missing.length) {
    problems += missing.length;
    console.log('  ✗ JS 引用了不存在的 id：');
    for (const id of missing) console.log('      - ' + id);
  } else {
    console.log('  ✓ JS 引用的 id 全部存在');
  }
  if (unused.length) {
    console.log('  · HTML 里未被 JS 直接引用的 id（可能是 CSS 或 data-* 选择器在用）：' + unused.join(', '));
  }

  // 检查 JS 里用到的 data-* 属性选择器在 HTML 里确实出现
  const dataSelectors = new Set();
  for (const match of js.matchAll(/querySelectorAll\('([^']+)'\)/g)) {
    const selector = match[1];
    for (const attr of selector.matchAll(/\[data-([\w-]+)\]/g)) dataSelectors.add('data-' + attr[1]);
  }
  for (const key of dataSelectors) {
    const present = html.indexOf(key) !== -1 || js.indexOf(key) !== -1;
    if (!present) {
      problems++;
      console.log(`  ✗ 选择器依赖的 ${key} 在 HTML 里找不到`);
    }
  }
  if (dataSelectors.size) console.log('  ✓ data-* 选择器：' + Array.from(dataSelectors).join(', '));

  // 检查 tab 面板 id 与按钮 data-tab 是否一一对应
  const tabNames = new Set();
  for (const match of html.matchAll(/data-tab="([^"]+)"/g)) tabNames.add(match[1]);
  const panelNames = new Set();
  for (const match of html.matchAll(/id="tab-([^"]+)"/g)) panelNames.add(match[1]);
  const missingPanels = Array.from(tabNames).filter((name) => !panelNames.has(name));
  const orphanPanels = Array.from(panelNames).filter((name) => !tabNames.has(name));
  if (missingPanels.length) {
    problems += missingPanels.length;
    console.log('  ✗ 有标签按钮但没有对应面板：' + missingPanels.join(', '));
  }
  if (orphanPanels.length) {
    console.log('  · 有面板但没有对应标签按钮：' + orphanPanels.join(', '));
  }
  if (!missingPanels.length && !orphanPanels.length && tabNames.size) {
    console.log(`  ✓ ${tabNames.size} 个标签页与面板一一对应`);
  }
}

console.log(problems ? `\n发现 ${problems} 处问题` : '\nUI 检查通过');
process.exit(problems ? 1 : 0);
