import './styles.css';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const TYPE_LABELS = {
  prepare: '准备',
  activate: '激活',
  issue: '签发',
  recover: '恢复',
};
const VERB_LABELS = {
  deliver: '投递/处理',
  retry: '重发',
  drop: '丢弃',
  reject: '拒绝',
  recover: '恢复',
  crash: '断电',
};
const CRASH_LABELS = { before: '写入前', preack: '写入后确认前', after: '确认后' };

const sampleInput = () => ({
  oldFp: 'KEY-OLD',
  newFp: 'KEY-NEW',
  modules: [
    { id: 'M1', epoch: 0, key: 'KEY-OLD', pending: '', confirmed: [] },
    { id: 'M2', epoch: 0, key: 'KEY-OLD', pending: '', confirmed: [] },
  ],
  commands: [
    { type: 'prepare', target: 'M1', fp: 'KEY-NEW' },
    { type: 'prepare', target: 'M2', fp: 'KEY-NEW' },
    { type: 'activate', target: 'M1' },
    { type: 'activate', target: 'M2' },
    { type: 'issue', target: 'M1', order: 'ORDER-001' },
  ],
});

const emptyInput = () => ({
  oldFp: '',
  newFp: '',
  modules: [
    { id: '', epoch: 0, key: '', pending: '', confirmed: [] },
    { id: '', epoch: 0, key: '', pending: '', confirmed: [] },
  ],
  commands: [],
});

let draft = emptyInput();

// ---------------- 渲染：模块初态 ----------------
function renderModules() {
  const root = $('#modules');
  root.innerHTML = '';
  draft.modules.forEach((m, mi) => {
    const card = document.createElement('div');
    card.className = 'subcard';
    card.innerHTML = `
      <h3>模块 ${mi + 1}</h3>
      <div class="grid2 tight">
        <label>模块标识
          <input data-k="id" placeholder="如 M${mi + 1}" />
        </label>
        <label>持久纪元
          <input type="number" min="0" step="1" data-k="epoch" />
        </label>
        <label>当前纪元密钥
          <select data-k="key">
            <option value="">（请选择）</option>
          </select>
        </label>
        <label>准备密钥
          <select data-k="pending">
            <option value="">（无）</option>
          </select>
        </label>
      </div>
      <div class="confirmed-block">
        <div class="confirmed-head">
          <span>已确认发布集合（初态）</span>
          <button type="button" class="btn btn-mini" data-act="addConfirmed">+ 发布令</button>
        </div>
        <div class="confirmed-list"></div>
      </div>
    `;
    card.querySelector('[data-k="id"]').value = m.id;
    card.querySelector('[data-k="epoch"]').value = m.epoch;
    syncKeyOptions(card, m);
    card.querySelector('[data-k="key"]').value = m.key;
    card.querySelector('[data-k="pending"]').value = m.pending;

    card.querySelector('[data-k="id"]').addEventListener('input', (e) => (m.id = e.target.value.trim()));
    card.querySelector('[data-k="epoch"]').addEventListener('input', (e) => {
      m.epoch = e.target.value === '' ? '' : Number(e.target.value);
    });
    card.querySelector('[data-k="key"]').addEventListener('change', (e) => (m.key = e.target.value));
    card.querySelector('[data-k="pending"]').addEventListener('change', (e) => (m.pending = e.target.value));
    card.querySelector('[data-act="addConfirmed"]').addEventListener('click', () => {
      m.confirmed.push({ id: '', fp: '' });
      renderModules();
    });

    const list = card.querySelector('.confirmed-list');
    m.confirmed.forEach((c, ci) => {
      const row = document.createElement('div');
      row.className = 'confirmed-row grid2 tight';
      row.innerHTML = `
        <input data-ck="id" placeholder="发布令标识" />
        <select data-ck="fp">
          <option value="">（密钥）</option>
        </select>
        <button type="button" class="btn btn-mini btn-danger" data-ck="del">删</button>
      `;
      row.querySelector('[data-ck="id"]').value = c.id;
      const sel = row.querySelector('[data-ck="fp"]');
      [draft.oldFp, draft.newFp].filter(Boolean).forEach((fp) => {
        const o = document.createElement('option');
        o.value = fp;
        o.textContent = fp;
        sel.appendChild(o);
      });
      sel.value = c.fp;
      row.querySelector('[data-ck="id"]').addEventListener('input', (e) => (c.id = e.target.value.trim()));
      sel.addEventListener('change', (e) => (c.fp = e.target.value));
      row.querySelector('[data-ck="del"]').addEventListener('click', () => {
        m.confirmed.splice(ci, 1);
        renderModules();
      });
      list.appendChild(row);
    });

    root.appendChild(card);
  });
}

function fillCardKeyOptions(card) {
  [
    { sel: card.querySelector('[data-k="key"]'), empty: '（请选择）' },
    { sel: card.querySelector('[data-k="pending"]'), empty: '（无）' },
  ].forEach(({ sel, empty }) => {
    const cur = sel.value;
    sel.innerHTML = `<option value="">${empty}</option>` +
      [draft.oldFp, draft.newFp].filter(Boolean).map((f) => `<option value="${f}">${f}</option>`).join('');
    sel.value = cur;
  });
  card.querySelectorAll('[data-ck="fp"]').forEach((sel) => {
    const cur = sel.value;
    sel.innerHTML = '<option value="">（密钥）</option>' +
      [draft.oldFp, draft.newFp].filter(Boolean).map((f) => `<option value="${f}">${f}</option>`).join('');
    sel.value = cur;
  });
}

function refreshFingerprintOptions() {
  $$('#modules .subcard').forEach((card) => fillCardKeyOptions(card));
  renderCommands();
}

function syncKeyOptions(card) {
  fillCardKeyOptions(card);
}

// ---------------- 渲染：指令行 ----------------
function renderCommands() {
  const root = $('#commands');
  root.innerHTML = '';
  draft.commands.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'cmd-row';
    const targets = draft.modules.map((mm) => mm.id).filter(Boolean);
    row.innerHTML = `
      <span class="cmd-idx">#${i + 1}</span>
      <select data-c="type">
        ${Object.entries(TYPE_LABELS).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}
      </select>
      <select data-c="target">
        <option value="">目标…</option>
        ${targets.map((t) => `<option value="${t}">${t}</option>`).join('')}
      </select>
      <select data-c="fp" hidden>
        <option value="">密钥…</option>
        ${[draft.oldFp, draft.newFp].filter(Boolean).map((f) => `<option value="${f}">${f}</option>`).join('')}
      </select>
      <input data-c="order" placeholder="发布令标识" hidden />
      <button type="button" class="btn btn-mini btn-ghost" data-c="up" title="上移">↑</button>
      <button type="button" class="btn btn-mini btn-ghost" data-c="down" title="下移">↓</button>
      <button type="button" class="btn btn-mini btn-danger" data-c="del">删</button>
    `;
    row.querySelector('[data-c="type"]').value = c.type;
    row.querySelector('[data-c="target"]').value = c.target;
    row.querySelector('[data-c="fp"]').value = c.fp ?? '';
    row.querySelector('[data-c="order"]').value = c.order ?? '';

    const syncVisibility = () => {
      row.querySelector('[data-c="fp"]').hidden = c.type !== 'prepare';
      row.querySelector('[data-c="order"]').hidden = c.type !== 'issue';
    };
    syncVisibility();

    row.querySelector('[data-c="type"]').addEventListener('change', (e) => {
      c.type = e.target.value;
      c.fp = c.type === 'prepare' ? c.fp : null;
      c.order = c.type === 'issue' ? c.order : null;
      syncVisibility();
    });
    row.querySelector('[data-c="target"]').addEventListener('change', (e) => (c.target = e.target.value));
    row.querySelector('[data-c="fp"]').addEventListener('change', (e) => (c.fp = e.target.value));
    row.querySelector('[data-c="order"]').addEventListener('input', (e) => (c.order = e.target.value.trim()));
    row.querySelector('[data-c="up"]').addEventListener('click', () => {
      if (i > 0) {
        [draft.commands[i - 1], draft.commands[i]] = [draft.commands[i], draft.commands[i - 1]];
        renderCommands();
      }
    });
    row.querySelector('[data-c="down"]').addEventListener('click', () => {
      if (i < draft.commands.length - 1) {
        [draft.commands[i + 1], draft.commands[i]] = [draft.commands[i], draft.commands[i + 1]];
        renderCommands();
      }
    });
    row.querySelector('[data-c="del"]').addEventListener('click', () => {
      draft.commands.splice(i, 1);
      renderCommands();
    });
    root.appendChild(row);
  });
  $('#cmdCount').textContent = `共 ${draft.commands.length} / 16 条`;
}

function renderAll() {
  $('#oldFp').value = draft.oldFp;
  $('#newFp').value = draft.newFp;
  renderModules();
  renderCommands();
}

// ---------------- 结果渲染 ----------------
function fmtConfirmed(list) {
  if (!list.length) return '∅';
  return list.map(([oid, fp]) => `${oid}@${fp}`).sort().join('，');
}

function moduleStateCell(s) {
  return `
    <div class="ms ${s.down ? 'ms-down' : ''}">
      <div class="ms-id">${s.id}${s.down ? ' <span class="down-tag">断电</span>' : ''}</div>
      <div>纪元 <b>${s.epoch}</b></div>
      <div>密钥 <b>${s.key}</b></div>
      <div>准备 ${s.pending ?? '∅'}</div>
      <div class="ms-conf">已确认：${fmtConfirmed(s.confirmed)}</div>
    </div>`;
}

function renderResult(msg) {
  const result = msg.result;
  const root = $('#result');
  root.innerHTML = '';

  if (result.status === 'truncated') {
    root.innerHTML = `<section class="card card-warn">
      <h2>搜索达到上限被截断</h2>
      <p>已探索迁移 ${result.summary.transitions}、合并状态 ${result.summary.states}。请缩减指令规模后重试。</p>
    </section>`;
    return;
  }

  if (result.status === 'safe') {
    const s = result.summary;
    root.innerHTML = `
      <section class="card card-safe">
        <h2>✓ 安全：穷尽全部交织未发现违约</h2>
        <p>不存在两枚模块以不同纪元密钥共同确认同一发布令的任何完整交织。</p>
        <table class="summary-table">
          <tbody>
            <tr><th>已枚举一步迁移</th><td>${s.transitions}</td></tr>
            <tr><th>合并后穷尽状态数</th><td>${s.states}</td></tr>
            <tr><th>覆盖持久规范状态数（纪元·准备密钥·已确认发布集）</th><td>${s.canonicalStates}</td></tr>
            <tr><th>完整终态交织数</th><td>${s.terminals}</td></tr>
            <tr><th>已覆盖断电窗口</th><td>${s.crashWindows.map((w) => CRASH_LABELS[w]).join('、') || '（本场景无断电点）'}</td></tr>
          </tbody>
        </table>
        <p class="hint">穷尽状态以双模块持久三段（纪元·准备密钥·已确认发布集）+ 宕机标志 + 各 FIFO 在途环境判等合并；不同发布令的独立在途消息按多集合并，保持控制端顺序不变。</p>
      </section>`;
    return;
  }

  // violation
  const { witness, violation } = result;
  const head = witness.steps.length
    ? `共 ${witness.steps.length} 个动作（动作数最短；同长度按模块与指令标识稳定排序）`
    : '违约直接存在于给定的模块持久初态中（0 个动作）';
  const rows = witness.steps
    .map((st, i) => {
      const before = witness.states[i];
      const after = witness.states[i + 1];
      const verb = VERB_LABELS[st.verb] || st.verb;
      const crashTag = st.crash ? ` · ${CRASH_LABELS[st.crash]}${st.verb === 'crash' ? '断电' : ''}` : '';
      const idxTag = st.idx !== null && st.idx !== undefined ? `指令#${st.idx + 1}` : '';
      return `
        <tr class="${i + 1 === witness.badStep ? 'bad-row' : ''}">
          <td>${i + 1}</td>
          <td><span class="verb verb-${st.verb}">${verb}</span>${crashTag}<div class="step-detail">${st.detail || ''}</div><div class="hint">${idxTag}${st.order ? ` · 发布令 ${st.order}` : ''}${st.peer ? ` · 来自 ${st.peer}` : ''}</div></td>
          <td><div class="ms-pair">${moduleStateCell(before[0])}${moduleStateCell(before[1])}</div></td>
          <td><div class="ms-pair">${moduleStateCell(after[0])}${moduleStateCell(after[1])}</div></td>
        </tr>`;
    })
    .join('');

  root.innerHTML = `
    <section class="card card-bad">
      <h2>✗ 发现违约：跨纪元密钥共同确认</h2>
      <p>发布令 <b>${violation.order}</b> 被两枚模块以不同纪元密钥共同确认：
      模块 ${witness.states.at(-1)[0].id} = <b>${violation.a}</b>，模块 ${witness.states.at(-1)[1].id} = <b>${violation.b}</b>。</p>
      <p class="hint">${head}</p>
      <div class="witness-wrap">
        <table class="witness-table">
          <thead><tr><th>#</th><th>动作</th><th>动作前双模块状态</th><th>动作后双模块状态</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>`;
}

function showErrors(errors) {
  const el = $('#errors');
  el.hidden = false;
  el.innerHTML = `<h2>输入问题（已一次性列出，并已清除旧结论）</h2><ul>${errors.map((x) => `<li>${x}</li>`).join('')}</ul>`;
}

function clearErrorsAndResult() {
  $('#errors').hidden = true;
  $('#errors').innerHTML = '';
  $('#result').innerHTML = '';
  $('#progress').textContent = '';
}

// ---------------- Worker ----------------
let worker = null;
let running = false;

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./workers/review.worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const msg = e.data || {};
    if (msg.type === 'progress') {
      $('#progress').textContent = `穷尽中… 迁移 ${msg.transitions} · 合并状态 ${msg.visited} · 队列 ${msg.queued}`;
    } else if (msg.type === 'invalid') {
      running = false;
      $('#reviewBtn').disabled = false;
      $('#progress').textContent = '';
      $('#result').innerHTML = '';
      showErrors(msg.errors);
    } else if (msg.type === 'done') {
      running = false;
      $('#reviewBtn').disabled = false;
      $('#progress').textContent = '';
      $('#errors').hidden = true;
      renderResult(msg);
    } else if (msg.type === 'error') {
      running = false;
      $('#reviewBtn').disabled = false;
      $('#progress').textContent = '';
      showErrors([`Worker 执行失败：${msg.message}`]);
    }
  };
  return worker;
}

// ---------------- 事件 ----------------
$('#oldFp').addEventListener('input', (e) => {
  draft.oldFp = e.target.value.trim();
  refreshFingerprintOptions();
});
$('#newFp').addEventListener('input', (e) => {
  draft.newFp = e.target.value.trim();
  refreshFingerprintOptions();
});

$('#addCmd').addEventListener('click', () => {
  if (draft.commands.length >= 16) return;
  draft.commands.push({ type: 'prepare', target: draft.modules[0]?.id || '', fp: draft.newFp || draft.oldFp || '', order: '' });
  renderCommands();
});
$('#removeCmd').addEventListener('click', () => {
  draft.commands.pop();
  renderCommands();
});

$('#reviewBtn').addEventListener('click', () => {
  if (running) return;
  clearErrorsAndResult();
  running = true;
  $('#reviewBtn').disabled = true;
  $('#progress').textContent = '已提交 Worker，开始穷尽…';
  ensureWorker().postMessage({ type: 'review', input: draft });
});

$('#clearBtn').addEventListener('click', () => {
  draft = emptyInput();
  renderAll();
  clearErrorsAndResult();
});

$('#sampleBtn').addEventListener('click', () => {
  draft = sampleInput();
  renderAll();
  clearErrorsAndResult();
});

renderAll();
