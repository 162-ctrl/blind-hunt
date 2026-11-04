#!/usr/bin/env node
/**
 * tools/push-api.mjs —— 备用上传通道
 *
 * 背景：这台机器上 github.com:443 经常连不上（git push 会超时），
 * 但 api.github.com 通常可以直连。此脚本用 GitHub Git Data API
 * 把当前 HEAD 提交的完整文件树同步成远端 main 上的一个提交，
 * 效果等同 git push（GitHub Pages 同样会自动重建）。
 *
 * 用法：
 *   node tools/push-api.mjs "提交说明"        # 同步
 *   node tools/push-api.mjs "提交说明" --dry  # 只看差异，不上传
 *
 * 认证：优先环境变量 GH_TOKEN / GITHUB_TOKEN，否则调用本机 gh auth token。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import https from 'node:https';

const REPO = process.env.BH_REPO || '162-ctrl/blind-hunt';
const BRANCH = process.env.BH_BRANCH || 'main';
const args = process.argv.slice(2);
const dry = args.includes('--dry');
const message = args.filter((a) => !a.startsWith('--')).join(' ') || '更新';
const GH = process.env.GH_BIN || 'C:\\Program Files\\GitHub CLI\\gh.exe';

function run(cmd, cmdArgs, opts) {
  return execFileSync(cmd, cmdArgs, {
    maxBuffer: 128 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
    ...opts,
  });
}

function resolveToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN.trim();
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  for (const bin of [GH, 'gh']) {
    try {
      const tok = run(bin, ['auth', 'token'], { encoding: 'utf8' }).trim();
      if (tok) return tok;
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

const token = resolveToken();
if (!token) {
  console.error('[push-api] 没有 GitHub token：请先运行 gh auth login');
  process.exit(2);
}

function api(method, path, body) {
  const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.github.com',
        path,
        method,
        headers: Object.assign(
          {
            'User-Agent': 'blind-hunt-push-api',
            Authorization: 'token ' + token,
            Accept: 'application/vnd.github+json',
          },
          payload
            ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
            : {}
        ),
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(text ? JSON.parse(text) : {});
            } catch {
              resolve(text);
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode} ${method} ${path}\n${text.slice(0, 600)}`));
          }
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** 本地 HEAD 的完整 blob 列表：path -> {mode, sha} */
function localTree() {
  const raw = run('git', ['-c', 'core.quotepath=false', 'ls-tree', '-r', '-z', 'HEAD'], {
    encoding: 'utf8',
  });
  const map = new Map();
  for (const rec of raw.split('\0')) {
    if (!rec) continue;
    // "<mode> blob <sha>\t<path>"
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const meta = rec.slice(0, tab).split(' ');
    if (meta[1] !== 'blob') continue;
    map.set(rec.slice(tab + 1), { mode: meta[0], sha: meta[2] });
  }
  return map;
}

async function main() {
  const ref = await api('GET', `/repos/${REPO}/git/ref/heads/${BRANCH}`);
  const headSha = ref.object.sha;
  const headCommit = await api('GET', `/repos/${REPO}/git/commits/${headSha}`);
  const baseTree = headCommit.tree.sha;
  const remoteTree = await api('GET', `/repos/${REPO}/git/trees/${baseTree}?recursive=1`);
  if (remoteTree.truncated) throw new Error('远端文件树被截断，无法安全比较');

  const remote = new Map();
  for (const e of remoteTree.tree) if (e.type === 'blob') remote.set(e.path, { mode: e.mode, sha: e.sha });

  const local = localTree();
  const upload = [];
  const remove = [];
  for (const [path, info] of local) {
    const r = remote.get(path);
    if (!r || r.sha !== info.sha) upload.push({ path, ...info });
  }
  for (const path of remote.keys()) if (!local.has(path)) remove.push(path);

  if (!upload.length && !remove.length) {
    console.log('[push-api] 远端已经是当前版本，无需上传');
    console.log('          https://github.com/' + REPO + '/commit/' + headSha);
    return;
  }

  console.log(`[push-api] 变更：新增/修改 ${upload.length} 个，删除 ${remove.length} 个`);
  for (const f of upload) console.log('   + ' + f.path);
  for (const f of remove) console.log('   - ' + f);
  if (dry) {
    console.log('[push-api] --dry：到此为止，未上传');
    return;
  }

  // 用本地 HEAD 的 tree 作为新的基树：改动项重传 blob，其余沿用远端
  const entries = [];
  for (const f of upload) {
    const content = run('git', ['cat-file', 'blob', f.sha]);
    const blob = await api('POST', `/repos/${REPO}/git/blobs`, {
      content: Buffer.from(content).toString('base64'),
      encoding: 'base64',
    });
    entries.push({ path: f.path, mode: f.mode, type: 'blob', sha: blob.sha });
  }
  for (const path of remove) entries.push({ path, mode: '100644', type: 'blob', sha: null });

  const newTree = await api('POST', `/repos/${REPO}/git/trees`, {
    base_tree: baseTree,
    tree: entries,
  });
  const commit = await api('POST', `/repos/${REPO}/git/commits`, {
    message,
    tree: newTree.sha,
    parents: [headSha],
  });
  await api('PATCH', `/repos/${REPO}/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: false });

  console.log('[push-api] 上传成功：' + commit.sha.slice(0, 7) + '  ' + message);
  console.log('          https://github.com/' + REPO + '/commit/' + commit.sha);
  console.log('          在线版 1~2 分钟后自动重建：https://' + REPO.split('/')[0] + '.github.io/' + REPO.split('/')[1] + '/');
}

main().catch((e) => {
  console.error('[push-api] 失败：' + e.message);
  process.exit(1);
});
