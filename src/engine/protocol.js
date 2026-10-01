/**
 * 航电双模块密钥轮换 —— 核心协议与穷尽交织模型（纯函数，无 DOM / Worker 依赖）。
 *
 * 建模要点：
 *  - 两枚独立模块，控制端按固定顺序下发至多 16 条指令：
 *    prepare（准备密钥）/ activate（激活换纪元）/ issue（签发发布令）/ recover（断电恢复）。
 *  - 每条指令在模块侧的处理都可能在三个窗口断电：
 *      before  持久写入前；preack 持久写入后、确认发出前；after 确认发出后。
 *  - 消息通道按 (发送方→接收方) 保持 FIFO：控制端顺序与“消息延迟但不乱序”一致；
 *    模块间消息的发送方可以重发一份副本（有界 1 份），用于覆盖“确认重发 / 迟到确认”。
 *  - 恢复只重放已落盘记录：断电只丢失运行态与在途消息，持久日志重放出同样的
 *    规范状态；未落盘的效果一律不存在。
 *  - 模块持久规范状态：
 *      { 纪元 epoch, 当前纪元密钥 key, 准备密钥 pending, 已确认发布表 confirmed }
 *    confirmed 保留每条发布令签发时所用的纪元密钥指纹，否则无法判定
 *    “共同确认一份由不同纪元密钥签出的发布令”。
 *  - 违约判据：同一发布令标识同时出现在两个模块的已确认集合中，且两模块记录的
 *    签发密钥指纹不同（即不同纪元密钥）。
 *
 * 穷尽合并键 = 双模块持久三段状态 + 宕机标志 + 各 FIFO 通道的完整在途环境。
 * 只按三段持久状态合并前缀不安全：相同持久状态下在途消息不同，后续落地效果也不同
 * （签署请求 / 确认可能在途、迟到或被重发）。因此以完整异步状态判等来合并等价前缀；
 * 题意规定的三段（持久纪元 / 准备密钥 / 已确认发布集合）作为“规范状态”单独统计覆盖。
 */

export const T_PREPARE = 'prepare';
export const T_ACTIVATE = 'activate';
export const T_ISSUE = 'issue';
export const T_RECOVER = 'recover';

const KIND_RANK = { cmd: 0, req: 1, ack: 2, nack: 3 };
const VERB_RANK = { deliver: 0, retry: 1, drop: 2, reject: 3, recover: 4, crash: 5 };
const CRASH_RANK = { before: 0, preack: 1, after: 2 };

let envelopeSeq = 0;

function makeEnvelope(kind, ch, fields) {
  return { uid: ++envelopeSeq, kind, ch, dup: false, ...fields };
}

/** 将一次复核输入标准化；返回 { value, errors }。errors 非空时 value 不可用。 */
export function normalizeInput(raw) {
  const errors = [];
  const value = { oldFp: '', newFp: '', modules: [], commands: [] };

  const fpRe = /^[A-Za-z0-9:_-]{2,64}$/;
  const oldFp = String(raw?.oldFp ?? '').trim();
  const newFp = String(raw?.newFp ?? '').trim();
  if (!oldFp) errors.push('旧密钥指纹不能为空。');
  else if (!fpRe.test(oldFp)) errors.push('旧密钥指纹格式非法（允许 2–64 位字母数字 : _ -）。');
  if (!newFp) errors.push('新密钥指纹不能为空。');
  else if (!fpRe.test(newFp)) errors.push('新密钥指纹格式非法（允许 2–64 位字母数字 : _ -）。');
  if (oldFp && newFp && oldFp === newFp) errors.push('旧、新密钥指纹不得相同。');
  value.oldFp = oldFp;
  value.newFp = newFp;
  const known = new Set([oldFp, newFp].filter(Boolean));
  const isKnown = (fp) => known.has(fp);

  // ---- 模块初态 ----
  const moduleIds = [];
  const rawModules = Array.isArray(raw?.modules) ? raw.modules.slice(0, 2) : [];
  if (rawModules.length !== 2) {
    errors.push(`必须提供恰好两个模块的持久初态（当前 ${rawModules.length} 个）。`);
  }
  rawModules.forEach((m, mi) => {
    const where = `模块 ${mi + 1}`;
    const id = String(m?.id ?? '').trim();
    if (!id) errors.push(`${where}：模块标识不能为空。`);
    else if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) errors.push(`${where}：模块标识格式非法。`);
    if (id && moduleIds.includes(id)) errors.push(`模块标识重复：“${id}”被两个模块使用。`);
    moduleIds.push(id);

    const epoch = Number(m?.epoch);
    if (!Number.isInteger(epoch) || epoch < 0) {
      errors.push(`${where}（${id || mi + 1}）：纪元必须为非负整数。`);
    }
    const key = String(m?.key ?? '').trim();
    if (!key) errors.push(`${where}（${id || mi + 1}）：当前纪元密钥缺失。`);
    else if (!isKnown(key)) errors.push(`${where}（${id || mi + 1}）：当前密钥 “${key}” 不是已登记的旧/新密钥指纹。`);

    const pendingRaw = String(m?.pending ?? '').trim();
    let pending = null;
    if (pendingRaw) {
      if (!isKnown(pendingRaw)) errors.push(`${where}（${id || mi + 1}）：准备密钥 “${pendingRaw}” 是未知密钥指纹。`);
      pending = pendingRaw;
    }

    if (Number.isInteger(epoch) && epoch === 0 && (key !== oldFp || pending !== null)) {
      errors.push(`${where}（${id || mi + 1}）：纪元 0 必须以旧密钥为当前密钥且无准备密钥（非法初态）。`);
    }

    const confirmed = new Map();
    const list = Array.isArray(m?.confirmed) ? m.confirmed : [];
    list.forEach((c, ci) => {
      const oid = String(c?.id ?? '').trim();
      const fp = String(c?.fp ?? '').trim();
      const at = `${where} 已确认发布第 ${ci + 1} 条`;
      if (!oid) errors.push(`${at}：发布令标识为空。`);
      if (!fp) errors.push(`${at}：签发密钥指纹为空。`);
      else if (!isKnown(fp)) errors.push(`${at}：密钥 “${fp}” 是未知密钥指纹。`);
      if (oid && confirmed.has(oid)) errors.push(`${at}：发布令 “${oid}” 在同一模块初态中重复。`);
      if (oid && fp) confirmed.set(oid, fp);
    });

    value.modules.push({
      id,
      epoch: Number.isInteger(epoch) ? epoch : 0,
      key: key || oldFp,
      pending,
      confirmed: [...confirmed.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    });
  });

  // ---- 指令 ----
  const commands = Array.isArray(raw?.commands) ? raw.commands : [];
  if (commands.length > 16) {
    errors.push(`指令至多 16 条（当前 ${commands.length} 条）。`);
  }
  const idSet = new Set(moduleIds.filter(Boolean));
  // 每个模块自上一次恢复（或起点）以来经历过多少次可断电处理：prepare/activate 针对本模块，
  // issue 同时涉及发起方与对端（对端要处理签署请求），恢复前计数必须 > 0。
  const sinceRecover = new Map(moduleIds.map((id) => [id, 0]));
  const bump = (id) => sinceRecover.set(id, (sinceRecover.get(id) ?? 0) + 1);

  commands.slice(0, 16).forEach((c, i) => {
    const at = `第 ${i + 1} 条指令`;
    const type = String(c?.type ?? '').trim();
    const target = String(c?.target ?? '').trim();
    if (![T_PREPARE, T_ACTIVATE, T_ISSUE, T_RECOVER].includes(type)) {
      errors.push(`${at}：类型非法（应为准备 / 激活 / 签发 / 恢复）。`);
      return;
    }
    if (!target) errors.push(`${at}：缺少目标模块。`);
    else if (!idSet.has(target)) errors.push(`${at}：无效指令目标 “${target}”（不是两个模块标识之一）。`);

    if (type === T_PREPARE) {
      const fp = String(c?.fp ?? '').trim();
      if (!fp) errors.push(`${at}：准备指令缺少密钥指纹。`);
      else if (!isKnown(fp)) errors.push(`${at}：准备密钥 “${fp}” 是未知密钥指纹。`);
      if (target && idSet.has(target)) bump(target);
    } else if (type === T_ISSUE) {
      const order = String(c?.order ?? '').trim();
      if (!order) errors.push(`${at}：签发指令缺少发布令标识。`);
      else if (!/^[A-Za-z0-9:_-]{1,64}$/.test(order)) errors.push(`${at}：发布令标识格式非法。`);
      if (target && idSet.has(target)) {
        bump(target);
        moduleIds.forEach((id) => { if (id !== target) bump(id); });
      }
    } else if (type === T_ACTIVATE) {
      if (target && idSet.has(target)) bump(target);
    } else if (type === T_RECOVER) {
      if (target && idSet.has(target)) {
        if ((sinceRecover.get(target) ?? 0) === 0) {
          errors.push(`${at}：模块 “${target}” 恢复前无故障（此前没有任何可断电的准备/激活/签发处理）。`);
        }
        sinceRecover.set(target, 0);
      }
    }
    value.commands.push({
      type,
      target,
      fp: type === T_PREPARE ? String(c?.fp ?? '').trim() : null,
      order: type === T_ISSUE ? String(c?.order ?? '').trim() : null,
    });
  });

  return { value, errors };
}

/** 依据合法输入构造初始探索状态（控制端指令按目标模块入各自 FIFO 通道）。 */
export function initialState(input) {
  envelopeSeq = 0;
  const mods = input.modules.map((m) => ({
    id: m.id,
    durable: {
      epoch: m.epoch,
      key: m.key,
      pending: m.pending,
      confirmed: new Map(m.confirmed),
    },
    down: false,
  }));
  const byId = new Map(mods.map((m) => [m.id, m]));
  const channels = new Map();
  const ch = (name) => {
    if (!channels.has(name)) channels.set(name, []);
    return channels.get(name);
  };
  input.commands.forEach((c, idx) => {
    ch(`ctrl:${c.target}`).push(
      makeEnvelope('cmd', `ctrl:${c.target}`, {
        idx,
        type: c.type,
        target: c.target,
        fp: c.fp,
        order: c.order,
      }),
    );
  });
  return { mods, byId, channels, retryTokens: new Map(), order: input.modules.map((m) => m.id) };
}

function cloneDurable(d) {
  return { epoch: d.epoch, key: d.key, pending: d.pending, confirmed: new Map(d.confirmed) };
}

function cloneChannels(channels, touchedName) {
  // 结构共享：只复制被处理消息所在的那一条通道，其余通道数组永不被原地修改，可共享。
  const out = new Map();
  for (const [name, q] of channels) {
    out.set(name, name === touchedName ? q.slice() : q);
  }
  if (touchedName && !out.has(touchedName)) out.set(touchedName, []);
  return out;
}

/** 克隆状态：只有 recipient 模块与 chName 通道会被本步修改，其余结构共享。 */
function cloneStateFor(state, recipient, chName) {
  const mods = state.mods.map((m) =>
    m.id === recipient ? { id: m.id, down: m.down, durable: cloneDurable(m.durable) } : m,
  );
  return {
    mods,
    byId: new Map(mods.map((m) => [m.id, m])),
    channels: cloneChannels(state.channels, chName),
    retryTokens: cloneRetryTokens(state.retryTokens, chName),
    order: state.order,
  };
}

function cloneRetryTokens(tokens, touchedName) {
  const out = new Map();
  for (const [name, list] of tokens) out.set(name, name === touchedName ? list.slice() : list);
  if (touchedName && !out.has(touchedName)) out.set(touchedName, []);
  return out;
}

/** 登记一个“可重发一份副本”的令牌（消息被丢弃 / 断电窗口内未可靠完成时）。 */
function grantRetryToken(s, chName, env) {
  const copyTpl = { ...env, uid: -1, dup: true };
  const sig = envelopeSig(copyTpl);
  const list = s.retryTokens.get(chName);
  if (list) {
    if (!list.some((t) => t.sig === sig)) s.retryTokens.set(chName, [...list, { sig, env: copyTpl }].sort((a, b) => (a.sig < b.sig ? -1 : 1)));
  } else {
    s.retryTokens.set(chName, [{ sig, env: copyTpl }]);
  }
}

/** 向通道追加消息时 copy-on-write：未触碰的通道数组保持跨状态共享。 */
function pushEnvelope(s, name, env) {
  const q = s.channels.get(name);
  if (q) s.channels.set(name, [...q, env]);
  else s.channels.set(name, [env]);
}

function snapshot(mods) {
  return mods.map((m) => ({
    id: m.id,
    down: m.down,
    epoch: m.durable.epoch,
    key: m.durable.key,
    pending: m.durable.pending,
    confirmed: [...m.durable.confirmed.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
  }));
}

/** 违约：同一发布令被两模块以不同纪元密钥共同确认。 */
export function findViolation(state) {
  const [a, b] = state.mods;
  for (const [oid, fp] of a.durable.confirmed) {
    const fp2 = b.durable.confirmed.get(oid);
    if (fp2 !== undefined && fp2 !== fp) return { order: oid, a: fp, b: fp2 };
  }
  return null;
}

function envelopeSig(e) {
  return [e.kind, e.idx ?? '', e.viaCmd ?? '', e.order ?? '', e.epoch ?? '', e.key ?? '', e.from ?? '', e.reason ?? '', e.dup ? 1 : 0].join('|');
}

/** 持久规范状态的可复用序列化片段。 */
function durablePart(state) {
  return state.mods.map((m) => [
    m.id,
    m.down ? 1 : 0,
    m.durable.epoch,
    m.durable.key,
    m.durable.pending ?? '~',
    ...[...m.durable.confirmed.entries()].sort().map(([o, f]) => `${o}=${f}`),
  ]);
}

/** 持久规范状态键：三段（双模块持久纪元 / 准备密钥 / 已确认发布集合）+ 宕机标志，仅用于覆盖摘要。 */
function canonicalKey(state) {
  return JSON.stringify({ d: durablePart(state) });
}

/**
 * 同时计算穷尽合并键与规范键，共享一次持久段序列化。
 *
 * 穷尽合并键 = 持久规范三段 + 宕机标志 + 各 FIFO 通道在途环境 + 重发令牌多集。
 * 相同持久状态但在途消息不同时，请求/确认仍可能落地改变结果，因此不能只按持久段合并。
 *
 * 其中：
 *  - 控制端通道严格按发起顺序（数组序）入键；
 *  - 模块间通道与重发令牌以“消息签名多集”入键：不同发布令的请求/确认彼此独立、处理可交换，
 *    同一发布令的 req 与其 ack 分居相反方向通道，重复消息幂等，故同通道内顺序不影响
 *    可达持久状态集合（见 scripts/fuzz-multiset.js 差分验证）。
 */
function stateKeys(state, multiset = true) {
  const q = {};
  for (const [name, queue] of state.channels) {
    if (!queue.length) continue;
    const sigs = queue.map(envelopeSig);
    q[name] = multiset && !name.startsWith('ctrl:') ? sigs.sort() : sigs;
  }
  const t = {};
  for (const [name, list] of state.retryTokens) {
    if (list.length) t[name] = list.map((x) => x.sig).sort();
  }
  const d = durablePart(state);
  const canonical = JSON.stringify({ d });
  const exact = `{"d":${JSON.stringify(d)},"q":${JSON.stringify(q)},"t":${JSON.stringify(t)}}`;
  return { canonical, exact };
}

function actionKey(act) {
  return [
    VERB_RANK[act.verb] ?? 9,
    act.module ?? '',
    act.idx ?? -1,
    act.order ?? '',
    KIND_RANK[act.msgKind] ?? 9,
    act.peer ?? '',
    act.detail ?? '',
    CRASH_RANK[act.crash] ?? 9,
  ];
}

function cmpAction(a, b) {
  const ka = actionKey(a);
  const kb = actionKey(b);
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] < kb[i]) return -1;
    if (ka[i] > kb[i]) return 1;
  }
  return 0;
}

function repairRefs(state) {
  state.byId = new Map(state.mods.map((m) => [m.id, m]));
}

/**
 * 枚举某状态的全部一步后继。
 * 每个后继：{ state, action }，action 描述该步（投递/丢弃/拒绝/恢复/断电）。
 * 导出以便单元测试直接验证三窗口断电与恢复语义。
 */
export function successors(state) {
  const out = [];

  const pushOutcome = (next, act) => {
    out.push({ state: next, action: act });
  };

  // 显式“重发”动作：消耗一个令牌，把对应签署请求的副本重新投入其 FIFO 通道。
  for (const [chName, tokens] of state.retryTokens) {
    tokens.forEach((tok, ti) => {
      const retried = cloneStateFor(state, null, chName);
      // 不触碰模块；消费令牌（有界：每个原始请求至多重发一次，副本再被丢弃也不发新令牌）。
      const rest = retried.retryTokens.get(chName).filter((_, j) => j !== ti);
      if (rest.length) retried.retryTokens.set(chName, rest);
      else retried.retryTokens.delete(chName);
      const copy = { ...tok.env, uid: ++envelopeSeq };
      pushEnvelope(retried, chName, copy);
      const [from, to] = chName.split(':');
      const kindCn = copy.kind === 'ack' ? '确认' : '签署请求';
      pushOutcome(retried, {
        verb: 'retry',
        module: to,
        peer: from,
        idx: copy.viaCmd,
        order: copy.order,
        msgKind: copy.kind,
        envelope: copy,
        detail: `${from} 未获可靠完成，重发 ${copy.order} 的${kindCn}副本（有界一次）`,
      });
    });
  }

  for (const [chName, queue] of state.channels) {
    if (!queue.length) continue;
    const env = queue[0];
    const recipient = env.kind === 'cmd' ? env.target : chName.split(':')[1] || chName.split(':')[0];
    const m = state.byId.get(recipient);
    const peerMod = state.mods.find((x) => x.id !== recipient);
    if (!m) continue;

    const maybeGrant = (nextS, consumed, crash) => {
      // 仅在“原件的效果未可靠达成”时发放重发令牌（有界一次，副本不产生令牌）：
      //  - req before：对端未落盘签署，请求丢失 → 重发请求；
      //  - req preack：对端已落盘确认但确认未发出 → 重发请求，对端幂等重发确认；
      //  - ack before：确认方未落盘，确认丢失 → 重发确认（迟到/重复确认幂等）；
      //  - ack preack：确认方已落盘 → 效果已持久，无需重发；
      //  - after：后续消息已发出并在途，无需重发。
      if (consumed.dup) return;
      if (consumed.kind === 'req' && (crash === 'before' || crash === 'preack')) {
        grantRetryToken(nextS, chName, consumed);
      } else if (consumed.kind === 'ack' && crash === 'before') {
        grantRetryToken(nextS, chName, consumed);
      }
    };

    const baseDeliver = (mutator, verb, detail, crashPoints) => {
      for (const crash of crashPoints) {
        const next = cloneStateFor(state, recipient, chName);
        const nenv = next.channels.get(chName).shift();
        const nm = next.byId.get(recipient);
        const act = {
          verb,
          module: recipient,
          idx: env.kind === 'cmd' ? env.idx : env.viaCmd,
          order: env.order,
          msgKind: env.kind,
          peer: env.from,
          envelope: nenv,
          detail,
        };
        if (crash === null) {
          mutator(next, nm, nenv, act);
          pushOutcome(next, act);
        } else {
          const crashed = { ...act, verb: 'crash', crash };
          if (crash === 'before') {
            // 写入前断电：不执行任何落盘 / 发消息动作。
            nm.down = true;
            crashed.detail = `${detail} 前断电（无落盘）`;
            maybeGrant(next, nenv, 'before');
          } else if (crash === 'preack') {
            // 落盘后、确认前断电：执行持久化但不发任何后续消息。
            mutator(next, nm, nenv, crashed);
            nm.down = true;
            crashed.detail = `${detail}：已落盘、确认发出前断电`;
            maybeGrant(next, nenv, 'preack');
          } else {
            mutator(next, nm, nenv, crashed);
            nm.down = true;
            crashed.detail = `${detail}：确认发出后断电`;
            // after：确认/后续消息已发出（在独立通道在途），无需重发令牌。
          }
          pushOutcome(next, crashed);
        }
      }
    };

    if (m.down) {
      if (env.kind === 'cmd' && env.type === T_RECOVER) {
        // 上电恢复指令在模块断电期间同样可送达（它本身就是恢复动作）。
        baseDeliver(
          (s, nm) => {
            nm.down = false;
          },
          'recover',
          `模块 ${recipient} 上电，重放落盘日志，规范状态不变`,
          [null, 'before'],
        );
        continue;
      }
      // 其他到达消息：模块不接收，消息丢弃（恢复只重放落盘记录，不重放在途命令）。
      const next = cloneStateFor(state, recipient, chName);
      const droppedEnv = next.channels.get(chName).shift();
      // 断电中到达的 req/ack 原件未被处理（等价于丢失），发送方可重发一次。
      if (droppedEnv) maybeGrant(next, droppedEnv, 'before');
      pushOutcome(next, {
        verb: 'drop',
        module: recipient,
        idx: env.kind === 'cmd' ? env.idx : env.viaCmd,
        order: env.order,
        msgKind: env.kind,
        peer: env.from,
        envelope: { ...env },
        detail: `模块 ${recipient} 断电中，到达消息丢弃`,
      });
      continue;
    }

    if (env.kind === 'cmd') {
      if (env.type === T_RECOVER) {
        baseDeliver(
          (s, nm) => {
            nm.down = false;
          },
          'recover',
          `模块 ${recipient} 上电，重放落盘日志，规范状态不变`,
          [null, 'before'],
        );
      } else if (env.type === T_PREPARE) {
        baseDeliver(
          (s, nm) => {
            nm.durable.pending = env.fp;
          },
          'deliver',
          `模块 ${recipient} 准备密钥 ${env.fp}（持久写入）`,
          [null, 'before', 'preack', 'after'],
        );
      } else if (env.type === T_ACTIVATE) {
        if (m.durable.pending === null) {
          baseDeliver(
            () => {},
            'reject',
            `模块 ${recipient} 无准备密钥，拒绝激活（记录不变）`,
            [null],
          );
        } else {
          const np = m.durable.pending;
          baseDeliver(
            (s, nm) => {
              nm.durable.epoch += 1;
              nm.durable.key = np;
              nm.durable.pending = null;
            },
            'deliver',
            `模块 ${recipient} 激活新纪元 ${m.durable.epoch + 1}（密钥 ${np}）`,
            [null, 'before', 'preack', 'after'],
          );
        }
      } else if (env.type === T_ISSUE) {
        baseDeliver(
          (s, nm) => {
            // 请求方不持久化，仅按自身当前纪元/密钥向对端发出签署请求。
            const req = makeEnvelope('req', `${nm.id}:${peerMod.id}`, {
              order: env.order,
              epoch: nm.durable.epoch,
              key: nm.durable.key,
              from: nm.id,
              viaCmd: env.idx,
            });
            pushEnvelope(s, req.ch, req);
          },
          'deliver',
          `模块 ${recipient} 就发布令 ${env.order} 向 ${peerMod.id} 请求签发（纪元 ${m.durable.epoch}/${m.durable.key}）`,
          [null, 'before', 'after'],
        );
      }
    } else if (env.kind === 'req') {
      const stored = m.durable.confirmed.get(env.order);
      if (stored !== undefined) {
        if (stored === env.key && env.epoch === m.durable.epoch) {
          // 幂等：已以同一纪元密钥确认过，仅重发确认，不改记录。
          baseDeliver(
            (s, nm) => {
              const ack = makeEnvelope('ack', `${nm.id}:${env.from}`, {
                order: env.order,
                epoch: nm.durable.epoch,
                key: stored,
                from: nm.id,
                viaCmd: env.viaCmd,
              });
              pushEnvelope(s, ack.ch, ack);
            },
            'deliver',
            `重复签署请求 ${env.order}：已确认，记录不变，重发确认`,
            [null, 'before', 'after'],
          );
        } else {
          // 以不同纪元密钥重签：记录已存在，拒绝，绝不覆盖。
          baseDeliver(
            (s, nm) => {
              const nack = makeEnvelope('nack', `${nm.id}:${env.from}`, {
                order: env.order,
                from: nm.id,
                viaCmd: env.viaCmd,
                reason: 'cross-epoch',
              });
              pushEnvelope(s, nack.ch, nack);
            },
            'reject',
            `拒绝以 ${env.key} 重签 ${env.order}：本模块已用纪元密钥 ${stored} 确认，记录不变`,
            [null],
          );
        }
      } else if (env.epoch !== m.durable.epoch || env.key !== m.durable.key) {
        baseDeliver(
          (s, nm) => {
            const nack = makeEnvelope('nack', `${nm.id}:${env.from}`, {
              order: env.order,
              from: nm.id,
              viaCmd: env.viaCmd,
              reason: 'epoch-mismatch',
            });
            pushEnvelope(s, nack.ch, nack);
          },
          'reject',
          `拒绝签署 ${env.order}：对端纪元 ${env.epoch}/${env.key} 与本模块 ${m.durable.epoch}/${m.durable.key} 不一致`,
          [null],
        );
      } else {
        baseDeliver(
          (s, nm, _e, act) => {
            nm.durable.confirmed.set(env.order, nm.durable.key);
            if (act.crash !== 'preack') {
              const ack = makeEnvelope('ack', `${nm.id}:${env.from}`, {
                order: env.order,
                epoch: nm.durable.epoch,
                key: nm.durable.key,
                from: nm.id,
                viaCmd: env.viaCmd,
              });
              pushEnvelope(s, ack.ch, ack);
            }
          },
          'deliver',
          `模块 ${recipient} 确认签发 ${env.order}@${m.durable.key}`,
          [null, 'before', 'preack', 'after'],
        );
      }
    } else if (env.kind === 'ack') {
      const stored = m.durable.confirmed.get(env.order);
      if (stored !== undefined) {
        // 重复 / 迟到确认：不得改变模块记录。
        baseDeliver(
          () => {},
          'reject',
          `重复/迟到确认 ${env.order}：发布令已在记录中，丢弃且记录不变`,
          [null],
        );
      } else if (env.epoch !== m.durable.epoch || env.key !== m.durable.key) {
        baseDeliver(
          () => {},
          'reject',
          `迟到确认 ${env.order}（纪元 ${env.epoch}/${env.key}）与当前 ${m.durable.epoch}/${m.durable.key} 不符，忽略`,
          [null],
        );
      } else {
        baseDeliver(
          (s, nm) => {
            nm.durable.confirmed.set(env.order, nm.durable.key);
          },
          'deliver',
          `模块 ${recipient} 收到对端确认，落盘 ${env.order}@${m.durable.key}`,
          [null, 'before', 'preack', 'after'],
        );
      }
    } else if (env.kind === 'nack') {
      baseDeliver(
        () => {},
        'reject',
        `发布令 ${env.order} 收到对端拒绝（${env.reason}），签发不成立`,
        [null],
      );
    }
  }

  out.sort((x, y) => cmpAction(x.action, y.action));
  return out;
}

function isTerminal(state) {
  for (const [, q] of state.channels) if (q.length) return false;
  for (const [, tokens] of state.retryTokens) if (tokens.length) return false;
  return state.mods.every((m) => !m.down);
}

/**
 * 穷尽搜索（BFS = 动作数最短；后继按 (动作类型, 模块标识, 指令序号, 发布令标识…)
 * 稳定排序，故同长度取字典序最小的完整交织）。以完整异步状态判等合并等价前缀。
 * 返回 { status: 'violation'|'safe'|'truncated', witness?, summary? }。
 */
export function explore(input, { onProgress, cap = 2_000_000, multisetKeys = true } = {}) {
  const start = initialState(input);
  repairRefs(start);
  const startViolation = findViolation(start);
  if (startViolation) {
    return {
      status: 'violation',
      violation: startViolation,
      witness: { steps: [], states: [snapshot(start.mods)], badStep: 0 },
      summary: null,
    };
  }

  const root = { state: start, parent: null, action: null };
  const startKeys = stateKeys(start, multisetKeys);
  const visited = new Set([startKeys.exact]);
  const canonicalSeen = new Set([startKeys.canonical]);
  const queue = [root];
  let head = 0;
  let transitions = 0;
  let terminals = 0;
  const crashKinds = new Set();

  // 命中违约时沿 parent 链回溯，再一次性生成完整动作序列与每步双模块状态。
  const buildWitness = (node, next, action) => {
    const nodes = [];
    for (let n = node; n !== null; n = n.parent) nodes.push(n);
    nodes.reverse();
    const steps = nodes.slice(1).map((n) => ({ ...n.action, envelope: undefined }));
    steps.push({ ...action, envelope: undefined });
    const states = nodes.map((n) => snapshot(n.state.mods));
    states.push(snapshot(next.mods));
    return { steps, states, badStep: steps.length };
  };

  while (head < queue.length) {
    const node = queue[head++];
    if ((transitions & 4095) === 0) onProgress?.({ visited: visited.size, queued: queue.length - head, transitions });
    if (transitions > cap) {
      return {
        status: 'truncated',
        witness: null,
        summary: { transitions, states: visited.size, canonicalStates: canonicalSeen.size, terminals },
      };
    }
    for (const { state: next, action } of successors(node.state)) {
      transitions += 1;
      if (action.verb === 'crash') crashKinds.add(action.crash);
      repairRefs(next);
      const { exact: key, canonical } = stateKeys(next, multisetKeys);
      if (visited.has(key)) continue;
      visited.add(key);
      canonicalSeen.add(canonical);
      const child = { state: next, parent: node, action };
      const violation = findViolation(next);
      if (violation) {
        const w = buildWitness(node, next, action);
        return {
          status: 'violation',
          violation,
          witness: w,
          summary: { transitions, states: visited.size, canonicalStates: canonicalSeen.size, terminals },
        };
      }
      if (isTerminal(next)) terminals += 1;
      queue.push(child);
    }
  }

  return {
    status: 'safe',
    witness: null,
    summary: {
      transitions,
      states: visited.size,
      canonicalStates: canonicalSeen.size,
      terminals,
      crashWindows: ['before', 'preack', 'after'].filter((k) => crashKinds.has(k)),
    },
  }
}
