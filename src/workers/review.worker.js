/// <summary>
/// 复核 Worker：在后台线程中穷尽消息投递 / 断电 / 恢复交织，
/// 避免冻结 UI；定期向主线程汇报进度。
/// </summary>
import { normalizeInput, explore } from '../engine/protocol.js';

self.onmessage = (e) => {
  const msg = e.data || {};
  if (msg.type !== 'review') return;

  const { value, errors } = normalizeInput(msg.input);
  if (errors.length) {
    self.postMessage({ type: 'invalid', errors });
    return;
  }

  try {
    const result = explore(value, {
      cap: msg.cap ?? 2_000_000,
      onProgress: (p) => self.postMessage({ type: 'progress', ...p }),
    });
    self.postMessage({ type: 'done', result });
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.stack || err) });
  }
};
