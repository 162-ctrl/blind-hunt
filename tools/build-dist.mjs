/* =========================================================================
 * tools/build-dist.mjs — 打包《盲猎》为可分享产物
 * -------------------------------------------------------------------------
 * 产物：
 *   dist/盲猎.html            单文件版：CSS/JS 全部内联，一个文件发给别人双击即玩
 *   dist/盲猎/               文件夹版：index.html + css/ + js/ + README.md（解压即玩）
 * 用法：D:\node.exe tools/build-dist.mjs
 * ========================================================================= */
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const PACK = join(DIST, '盲猎');
const INDEX = join(ROOT, 'index.html');

function read(p) { return readFileSync(p, 'utf8'); }
function safeJs(js) {
  // 内联脚本里出现 </script 会提前结束标签，必须转义
  return js.replace(/<\/script/gi, '<\\/script');
}

// ---------- 1. 文件夹版 ----------
rmSync(DIST, { recursive: true, force: true });
mkdirSync(PACK, { recursive: true });
cpSync(INDEX, join(PACK, 'index.html'));
cpSync(join(ROOT, 'css'), join(PACK, 'css'), { recursive: true });
cpSync(join(ROOT, 'js'), join(PACK, 'js'), { recursive: true });
cpSync(join(ROOT, 'README.md'), join(PACK, 'README.md'));

// ---------- 2. 单文件版 ----------
let html = read(INDEX);
const css = read(join(ROOT, 'css', 'style.css'));
const cssTag = '<link rel="stylesheet" href="css/style.css">';
if (!html.includes(cssTag)) throw new Error('index.html 中找不到样式表标签，打包规则需要更新');
html = html.replace(cssTag, '<style>\n' + css + '\n</style>');

const scripts = [];
const re = /<script src="(js\/[A-Za-z0-9_.-]+\.js)"><\/script>/g;
let m;
while ((m = re.exec(html)) !== null) scripts.push(m[1]);
if (!scripts.length) throw new Error('index.html 中找不到外部脚本，打包规则需要更新');
for (const src of scripts) {
  const code = safeJs(read(join(ROOT, src)));
  const tag = '<script src="' + src + '"></script>';
  html = html.replace(tag, '<script>\n' + code + '\n</script>');
}
if (/<script src="js\//.test(html)) throw new Error('仍有未内联的脚本标签');
if (/href="css\//.test(html)) throw new Error('仍有未内联的样式标签');

// 单文件版标题里标注一下
html = html.replace('<title>盲猎 · Blind Hunt</title>', '<title>盲猎 · Blind Hunt（单文件版）</title>');

const single = join(DIST, '盲猎.html');
writeFileSync(single, html, 'utf8');
// ASCII 文件名副本：方便网盘/邮件/静态托管，避免某些平台对中文文件名的兼容问题
writeFileSync(join(DIST, 'blind-hunt.html'), html, 'utf8');

// ---------- 3. 报告 ----------
const size = (p) => (readFileSync(p).length / 1024).toFixed(1) + ' KB';
console.log('打包完成：');
console.log('  单文件版  : dist/盲猎.html         ' + size(single) + '  （双击即玩，发给别人最省事）');
console.log('  文件夹版  : dist/盲猎/             （含 README，压缩后分享）');
console.log('  内联脚本  : ' + scripts.join(', '));
if (!existsSync(join(PACK, 'index.html'))) throw new Error('文件夹版缺少 index.html');
