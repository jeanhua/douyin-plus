/**
 * 打包扩展为 zip（无第三方依赖，走系统自带命令）。
 *
 * 用法：node tools/pack.js
 * 产出：dist/douyin-plus-<version>.zip
 *
 * 只打包运行扩展所需的文件，不含 docs / tools / 开发配置。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const DIST = path.join(ROOT, 'dist');
const NAME = `${manifest.name}-${manifest.version}`;
const STAGE = path.join(DIST, NAME);
const OUT = path.join(DIST, NAME + '.zip');

const INCLUDE = ['manifest.json', 'icons', 'rules', 'src'];

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function copy(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) copy(path.join(src, entry), path.join(dest, entry));
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

function listFiles(dir, base, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.join(base, entry.name);
    if (entry.isDirectory()) listFiles(full, rel, out);
    else out.push(rel.split(path.sep).join('/'));
  }
  return out;
}

function zip(stageDir, outFile) {
  const isWin = process.platform === 'win32';
  try {
    if (isWin) {
      execFileSync(
        'powershell',
        ['-NoProfile', '-Command', `Compress-Archive -Path '${stageDir}\\*' -DestinationPath '${outFile}' -Force`],
        { stdio: 'inherit' }
      );
    } else {
      execFileSync('zip', ['-r', '-q', outFile, '.'], { cwd: stageDir, stdio: 'inherit' });
    }
    return true;
  } catch (err) {
    console.warn('自动打包失败：' + (err && err.message ? err.message : err));
    console.warn('可手动压缩目录：' + stageDir);
    return false;
  }
}

rmrf(DIST);
fs.mkdirSync(STAGE, { recursive: true });
for (const item of INCLUDE) {
  const src = path.join(ROOT, item);
  if (!fs.existsSync(src)) {
    console.warn('跳过不存在的路径：' + item);
    continue;
  }
  copy(src, path.join(STAGE, path.basename(item)));
}

// 清掉打包产物里的临时文件
for (const file of listFiles(STAGE, '', [])) {
  if (file.endsWith('.map') || file.endsWith('.log')) fs.rmSync(path.join(STAGE, file), { force: true });
}

console.log(`已准备 ${NAME}，共 ${listFiles(STAGE, '', []).length} 个文件`);
if (zip(STAGE, OUT)) console.log('打包完成：' + path.relative(ROOT, OUT));
