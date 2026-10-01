/**
 * verify 服务 HTTP 冒烟：等待 web 就绪后，检查
 *  1) 页面入口 / 返回 200 且含关键文案与 Worker 入口；
 *  2) 健康地址 /healthz 返回 200 且 status=ok；
 *  3) Worker 构建产物可访问（200、JS MIME）。
 * 任一失败立即以非零退出码结束。
 */
const WEB_URL = process.env.WEB_URL || 'http://web:80';
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 60_000);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchOk(path, { expect } = {}) {
  const url = `${WEB_URL}${path}`;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url} 返回 ${res.status}`);
  const body = await res.text();
  for (const [label, check] of expect || []) {
    if (!check(res, body)) throw new Error(`${url} 未通过检查：${label}`);
  }
  return { res, body };
}

async function waitForHealth(deadline) {
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${WEB_URL}/healthz`);
      if (res.ok) {
        const j = await res.json();
        if (j && j.status === 'ok') return;
        lastErr = new Error(`healthz 内容异常：${JSON.stringify(j)}`);
      } else {
        lastErr = new Error(`healthz HTTP ${res.status}`);
      }
    } catch (e) {
      lastErr = e;
    }
    await sleep(500);
  }
  throw new Error(`等待 ${WEB_URL}/healthz 超时：${lastErr?.message || lastErr}`);
}

async function main() {
  console.log(`[smoke] 目标 ${WEB_URL}`);
  await waitForHealth(Date.now() + TIMEOUT_MS);

  await fetchOk('/healthz', {
    expect: [
      ['JSON status=ok', (_r, b) => {
        try { return JSON.parse(b).status === 'ok'; } catch { return false; }
      }],
    ],
  });
  console.log('[smoke] /healthz OK');

  const { body: html } = await fetchOk('/', {
    expect: [
      ['HTML 含页面标题', (_r, b) => b.includes('双模块共同确认复核')],
      ['引用 /src/main.js 构建入口', (_r, b) => b.includes('/assets/')],
    ],
  });
  console.log('[smoke] / OK');

  // Worker 构建产物（dist/assets/review.worker-*.js）：文件名由 Vite 内容哈希生成，
  // 且由主 JS chunk 引用（不直接出现在 HTML 中），故从本地 dist 清单定位再做 HTTP 检查。
  const { readdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const distAssets = join(process.cwd(), 'dist', 'assets');
  const workerFile = readdirSync(distAssets).find((f) => /^review\.worker-.*\.js$/.test(f));
  if (!workerFile) throw new Error('dist/assets 中未找到 review.worker 构建产物');
  await fetchOk(`/assets/${workerFile}`, {
    expect: [
      ['JS MIME', (r) => /javascript/.test(r.headers.get('content-type') || '')],
      ['非空', (_r, b) => b.length > 1000],
    ],
  });
  console.log(`[smoke] Worker 产物 /assets/${workerFile} OK`);

  console.log('[smoke] 全部冒烟检查通过');
}

main().catch((e) => {
  console.error(`[smoke] 失败：${e.message}`);
  process.exit(1);
});
