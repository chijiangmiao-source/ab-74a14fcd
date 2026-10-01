/**
 * 差分 fuzz：对比严格 FIFO 合并键（multisetKeys=false）与模块间通道多集键（true）
 * 在大量随机合法小场景上的安全/违约判定与可达持久规范状态集合。两者必须一致。
 */
import { normalizeInput, explore } from '../src/engine/protocol.js';

const OLD = 'FP-OLD';
const NEW = 'FP-NEW';

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function scenario(rand) {
  const mk = (epoch, key, pending) => ({
    id: '',
    epoch,
    key,
    pending: pending || null,
    confirmed: [],
  });
  // 一半概率带非平凡初态
  const phase = rand() < 0.4 ? 1 : 0;
  const modules = [
    { ...mk(phase, phase ? NEW : OLD, null), id: 'M1' },
    { ...mk(phase, phase ? NEW : OLD, null), id: 'M2' },
  ];
  // 偶尔预置已确认发布令（制造潜在跨纪元矛盾）
  if (rand() < 0.3) {
    const n = 1 + Math.floor(rand() * 2);
    for (let i = 0; i < n; i++) {
      const oid = `R${i}`;
      modules[0].confirmed.push({ id: oid, fp: rand() < 0.5 ? OLD : NEW });
      if (rand() < 0.7) modules[1].confirmed.push({ id: oid, fp: rand() < 0.5 ? OLD : NEW });
    }
  }

  const cmds = [];
  let prepared = { M1: phase > 0, M2: phase > 0 };
  let activeEpoch = { M1: phase, M2: phase };
  let sinceFault = { M1: 0, M2: 0 };
  const n = 2 + Math.floor(rand() * 6);
  for (let i = 0; i < n; i++) {
    const target = rand() < 0.5 ? 'M1' : 'M2';
    const r = rand();
    if (r < 0.3) {
      cmds.push({ type: 'prepare', target, fp: rand() < 0.5 ? OLD : NEW });
      sinceFault[target]++;
    } else if (r < 0.55) {
      cmds.push({ type: 'activate', target, fp: null });
      sinceFault[target]++;
    } else if (r < 0.85) {
      cmds.push({ type: 'issue', target, order: `O${Math.floor(rand() * 3)}` });
      sinceFault[target]++;
      sinceFault[target === 'M1' ? 'M2' : 'M1']++;
    } else if (sinceFault[target] > 0) {
      cmds.push({ type: 'recover', target, fp: null, order: null });
      sinceFault[target] = 0;
    } else {
      cmds.push({ type: 'prepare', target, fp: NEW });
      sinceFault[target]++;
    }
    void prepared;
    void activeEpoch;
  }
  return { oldFp: OLD, newFp: NEW, modules, commands: cmds };
}

let seed = Number(process.argv[2] || 1234);
const iters = Number(process.argv[3] || 400);
let mismatches = 0;
for (let i = 0; i < iters; i++) {
  const rand = rng(seed + i * 7919);
  const raw = scenario(rand);
  const { value, errors } = normalizeInput(raw);
  if (errors.length) continue;
  const a = explore(value, { multisetKeys: false, cap: 1_000_000 });
  const b = explore(value, { multisetKeys: true, cap: 1_000_000 });
  // 严格模式若被截断则无法作为基准，跳过
  if (a.status === 'truncated' || b.status === 'truncated') continue;
  if (a.status !== b.status) {
    mismatches++;
    console.log('MISMATCH status seed', seed + i * 7919, a.status, b.status, JSON.stringify(raw.commands), JSON.stringify(raw.modules.map((m) => m.confirmed)));
    if (mismatches > 5) process.exit(1);
  }
  if (a.status === 'violation' && a.witness.steps.length !== b.witness.steps.length) {
    mismatches++;
    console.log('MISMATCH witness length seed', seed + i * 7919, a.witness.steps.length, b.witness.steps.length, JSON.stringify(raw.commands));
    if (mismatches > 5) process.exit(1);
  }
}
if (mismatches) {
  console.log(`FAILED with ${mismatches} mismatches`);
  process.exit(1);
}
console.log(`OK: ${iters} random scenarios, strict vs multiset verdict identical`);
