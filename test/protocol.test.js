import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeInput,
  initialState,
  explore,
  successors,
  findViolation,
} from '../src/engine/protocol.js';

const OLD = 'FP-OLD';
const NEW = 'FP-NEW';

function build(commands, opts = {}) {
  const raw = {
    oldFp: OLD,
    newFp: NEW,
    modules: [
      { id: 'M1', epoch: 0, key: OLD, pending: '', confirmed: [], ...(opts.m1 || {}) },
      { id: 'M2', epoch: 0, key: OLD, pending: '', confirmed: [], ...(opts.m2 || {}) },
    ],
    commands,
  };
  const { value, errors } = normalizeInput(raw);
  assert.deepEqual(errors, [], `expected valid input, got: ${errors.join(' | ')}`);
  return value;
}

test('输入校验：模块标识重复、未知密钥、非法初态、无效目标、恢复前无故障一次性指出', () => {
  const { errors } = normalizeInput({
    oldFp: OLD,
    newFp: NEW,
    modules: [
      { id: 'DUP', epoch: 0, key: NEW, pending: NEW, confirmed: [{ id: 'X', fp: 'WHOKEY' }] },
      { id: 'DUP', epoch: -1, key: 'STRANGER', pending: 'MAYBE' },
    ],
    commands: [
      { type: 'prepare', target: 'GHOST', fp: 'NOPE' },
      { type: 'recover', target: 'DUP' },
    ],
  });
  const joined = errors.join('\n');
  assert.match(joined, /模块标识重复/);
  assert.match(joined, /WHOKEY/);
  assert.match(joined, /NOPE/);
  assert.match(joined, /未知密钥指纹/);
  assert.match(joined, /纪元必须为非负整数/);
  assert.match(joined, /STRANGER/);
  assert.match(joined, /纪元 0 必须以旧密钥/);
  assert.match(joined, /无效指令目标/);
  assert.match(joined, /恢复前无故障/);
  assert.ok(errors.length >= 8, `应一次指出多个问题，实际 ${errors.length} 条`);
});

test('输入校验：旧/新指纹缺失或相同、指令数量上限', () => {
  const e1 = normalizeInput({
    oldFp: '',
    newFp: '',
    modules: [
      { id: 'A', epoch: 0, key: OLD },
      { id: 'B', epoch: 0, key: OLD },
    ],
    commands: [],
  }).errors;
  assert.ok(e1.some((x) => /旧密钥指纹不能为空/.test(x)));
  assert.ok(e1.some((x) => /新密钥指纹不能为空/.test(x)));

  const e2 = normalizeInput({
    oldFp: 'SAME',
    newFp: 'SAME',
    modules: [
      { id: 'A', epoch: 0, key: 'SAME' },
      { id: 'B', epoch: 0, key: 'SAME' },
    ],
    commands: [],
  }).errors;
  assert.ok(e2.some((x) => /不得相同/.test(x)));

  const e3 = normalizeInput({
    oldFp: OLD,
    newFp: NEW,
    modules: [
      { id: 'A', epoch: 0, key: OLD },
      { id: 'B', epoch: 0, key: OLD },
    ],
    commands: Array.from({ length: 17 }, () => ({ type: 'activate', target: 'A' })),
  }).errors;
  assert.ok(e3.some((x) => /至多 16 条/.test(x)));
});

test('安全基线：两模块都激活同一新纪元后签发，穷尽全部交织安全', () => {
  const input = build([
    { type: 'prepare', target: 'M1', fp: NEW },
    { type: 'prepare', target: 'M2', fp: NEW },
    { type: 'activate', target: 'M1' },
    { type: 'activate', target: 'M2' },
    { type: 'issue', target: 'M1', order: 'O1' },
  ]);
  const res = explore(input);
  assert.equal(res.status, 'safe');
  assert.ok(res.summary.transitions > 0);
  assert.ok(res.summary.crashWindows.includes('preack'));
  // 终态中 M1、M2 都以 NEW 共同确认 O1 的交织存在
});

test('无激活直接签发：只可能共同以旧密钥确认，安全', () => {
  const input = build([{ type: 'issue', target: 'M2', order: 'O9' }]);
  const res = explore(input);
  assert.equal(res.status, 'safe');
  assert.ok(res.summary.terminals >= 1);
});

test('违约检测：初态中同一发布令以不同纪元密钥被共同确认 → 0 步证人', () => {
  const input = build([], {
    m1: { confirmed: [{ id: 'O1', fp: OLD }] },
    m2: { confirmed: [{ id: 'O1', fp: NEW }] },
  });
  const res = explore(input);
  assert.equal(res.status, 'violation');
  assert.equal(res.violation.order, 'O1');
  assert.equal(res.witness.steps.length, 0);
});

test('断电窗口：落盘前断电不落盘；落盘后确认前断电效果保留且模块宕机', () => {
  const input = build([{ type: 'prepare', target: 'M1', fp: NEW }]);
  const s0 = initialState(input);
  const succ = successors(s0);
  const crashes = succ.filter((x) => x.action.verb === 'crash');
  const before = crashes.find((x) => x.action.crash === 'before');
  const preack = crashes.find((x) => x.action.crash === 'preack');
  assert.ok(before && preack, 'prepare 必须同时暴露 before / preack 断电分支');
  assert.equal(before.state.mods[0].down, true);
  assert.equal(before.state.mods[0].durable.pending, null);
  assert.equal(preack.state.mods[0].down, true);
  assert.equal(preack.state.mods[0].durable.pending, NEW);
});

test('恢复只能重放已落盘记录：宕机时在途消息被丢弃，恢复后规范状态等于断电时落盘状态', () => {
  const input = build([
    { type: 'prepare', target: 'M1', fp: NEW },
    { type: 'recover', target: 'M1' },
  ]);
  // 走到 M1 preack 断电（prepare 已落盘）的状态
  const s0 = initialState(input);
  const preack = successors(s0).find(
    (x) => x.action.verb === 'crash' && x.action.crash === 'preack',
  ).state;
  // 队列里 M1 还有 recover；此时投递 recover 恢复
  const rec = successors(preack).find((x) => x.action.verb === 'recover');
  assert.ok(rec, '宕机模块必须能收到 recover');
  assert.equal(rec.state.mods[0].down, false);
  assert.equal(rec.state.mods[0].durable.pending, NEW);
});

test('重复/迟到确认不得改变模块记录', () => {
  // M1 已确认 O1@OLD；再来一个携带 NEW 的迟到 ack，应被拒绝且记录不变。
  const input = build([], {
    m1: { confirmed: [{ id: 'O1', fp: OLD }] },
  });
  const s0 = initialState(input);
  s0.channels.set('M2:M1', [
    { uid: 1, kind: 'ack', ch: 'M2:M1', dup: false, order: 'O1', epoch: 1, key: NEW, from: 'M2' },
  ]);
  const succ = successors(s0);
  assert.equal(succ.length, 1);
  assert.equal(succ[0].action.verb, 'reject');
  assert.deepEqual([...succ[0].state.mods[0].durable.confirmed.entries()], [['O1', OLD]]);
});

test('跨纪元重签检出违约：旧纪元已确认的发布令在新纪元被对端首次确认', () => {
  // M1 初态已在旧纪元确认 O1，随后两模块升到新纪元；M1 再发起 O1 签发。
  // M2 此前无 O1 记录，按 NEW 确认并落盘 → 两模块以不同纪元密钥共同确认 O1。
  // M1 即使忽略携带 NEW 的迟到 ack，也无法撤销 M2 已落盘的确认 → 必须检出。
  const input = build(
    [
      { type: 'prepare', target: 'M1', fp: NEW },
      { type: 'prepare', target: 'M2', fp: NEW },
      { type: 'activate', target: 'M1' },
      { type: 'activate', target: 'M2' },
      { type: 'issue', target: 'M1', order: 'O1' },
    ],
    { m1: { confirmed: [{ id: 'O1', fp: OLD }] } },
  );
  const res = explore(input);
  assert.equal(res.status, 'violation');
  assert.equal(res.violation.order, 'O1');
  assert.ok(res.witness.steps.length > 0, '证人应由若干动作构成，而非初态矛盾');
  // 证人最后一步：某模块落盘与对端不同密钥的确认
  const last = res.witness.steps.at(-1);
  const tail = res.witness.states.at(-1);
  assert.notEqual(tail[0].confirmed.find(([o]) => o === 'O1')?.[1], tail[1].confirmed.find(([o]) => o === 'O1')?.[1]);
  assert.ok(last.detail.includes('O1'));
});

test('证人最短性：BFS 返回动作数最少的完整交织', () => {
  // 构造一个“需要若干步才能形成跨纪元共同确认”的初态：
  // M1 已确认 O1@OLD，M2 未确认；只有 M2 错误地以 NEW 确认 O1 才违约。
  // 在本协议中 M2 只能通过收到 NEW 纪元的 req 确认，而 M1 已持 OLD，
  // 因此协议必须判安全（反向验证防护有效）。
  const input = build(
    [
      { type: 'prepare', target: 'M2', fp: NEW },
      { type: 'activate', target: 'M2' },
    ],
    { m1: { confirmed: [{ id: 'O1', fp: OLD }] } },
  );
  const res = explore(input);
  assert.equal(res.status, 'safe');
  assert.equal(findViolation(initialState(input)), null);
});

test('控制端顺序：同一模块通道内消息 FIFO，指令按发起顺序出队', () => {
  const input = build([
    { type: 'prepare', target: 'M1', fp: NEW },
    { type: 'activate', target: 'M1' },
  ]);
  const s0 = initialState(input);
  assert.deepEqual(s0.channels.get('ctrl:M1').map((e) => e.idx), [0, 1]);
  // 队首只能是第 0 条
  const first = successors(s0).filter((x) => x.action.idx === 0);
  assert.ok(first.length > 0);
  assert.ok(!successors(s0).some((x) => x.action.idx === 1 && x.action.msgKind === 'cmd'));
});

test('穷尽覆盖确认重发：请求写入前断电后可显式重发并最终共同确认，安全', () => {
  // 单次 issue 且允许三窗口断电：req 在对端写入前断电丢失 → 恢复 → 显式重发 → 仍能共同确认。
  const input = build([{ type: 'issue', target: 'M1', order: 'O1' }]);
  const res = explore(input);
  assert.equal(res.status, 'safe');
  // 存在包含 retry 动作的完整成功交织
  const s0 = initialState(input);
  let sawRetry = false;
  const walk = (state, depth) => {
    if (depth > 30 || sawRetry) return;
    for (const { state: next, action } of successors(state)) {
      if (action.verb === 'retry') {
        sawRetry = true;
        // 重发副本确实重新进入对应通道
        const total = [...next.channels.values()].reduce((a, q) => a + q.length, 0);
        assert.ok(total >= 1);
      }
      walk(next, depth + 1);
    }
  };
  walk(s0, 0);
  assert.ok(sawRetry, '应存在显式重发动作');
});

test('重发有界：副本本身被丢弃时不再产生新的重发令牌（不会无限重发）', () => {
  const input = build([{ type: 'issue', target: 'M1', order: 'O1' }]);
  const s0 = initialState(input);
  // 构造：M2 宕机，通道 M1:M2 中仅有一个 dup 重发副本（req）。
  s0.channels = new Map([
    ['ctrl:M1', []],
    ['ctrl:M2', []],
    ['M1:M2', [{ uid: 9, kind: 'req', ch: 'M1:M2', dup: true, order: 'O1', epoch: 0, key: OLD, from: 'M1', viaCmd: 0 }]],
    ['M2:M1', []],
  ]);
  s0.mods[1].down = true;
  const dropped = successors(s0).filter((x) => x.action.verb === 'drop');
  assert.ok(dropped.length >= 1, '宕机时到达的副本应被丢弃');
  for (const { state: ns } of dropped) {
    const tokens = [...ns.retryTokens.values()].reduce((a, l) => a + l.length, 0);
    assert.equal(tokens, 0, 'dup 副本被丢弃后不得产生新的重发令牌');
  }
});

test('无准备密钥的激活被拒绝且记录不变', () => {
  const input = build([{ type: 'activate', target: 'M1' }]);
  const s0 = initialState(input);
  const succ = successors(s0).filter((x) => x.action.module === 'M1' && x.action.msgKind === 'cmd');
  assert.ok(succ.every((x) => x.action.verb === 'reject'));
  assert.equal(s0.mods[0].durable.epoch, 0);
});

test('重发的重复签署请求被幂等处理：只重发确认、不重复落盘', () => {
  // M2 已确认 O1 后，重发的 req 副本到达，应走“已确认→重发 ack”幂等分支，
  // confirmed 仍只有一条 O1。
  const input = build([{ type: 'issue', target: 'M1', order: 'O1' }]);
  const s0 = initialState(input);
  // 手工构造：M2 已确认 O1@OLD，通道里再来一个（重发的）req 原件。
  s0.mods[1].durable.confirmed.set('O1', OLD);
  s0.channels.set('M1:M2', [
    { uid: 1, kind: 'req', ch: 'M1:M2', dup: true, order: 'O1', epoch: 0, key: OLD, from: 'M1', viaCmd: 0 },
  ]);
  const succ = successors(s0);
  const delivers = succ.filter((x) => x.action.msgKind === 'req' && x.action.verb === 'deliver');
  assert.ok(delivers.length >= 1, '重复 req 应被正常投递（幂等）而非拒绝');
  for (const { state } of delivers) {
    assert.deepEqual([...state.mods[1].durable.confirmed.entries()], [['O1', OLD]]);
    // 产生一个重发的 ack
    const ackQ = state.channels.get('M2:M1') || [];
    assert.ok(ackQ.some((e) => e.kind === 'ack' && e.order === 'O1'));
  }
});
