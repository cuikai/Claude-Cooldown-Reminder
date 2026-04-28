/**
 * Claude 提醒助手 - 内容脚本
 *
 * 在 claude.ai 页面上监听 DOM 变化，捕获额度耗尽提示并解析重置时间。
 *
 * 隐私承诺：本脚本只在本地处理页面文本，不会向任何远程服务器发送任何数据。
 *           所有通信都仅发生在本扩展的内容脚本与后台 Service Worker 之间。
 */

(() => {
  'use strict';

  // 仅运行一次
  if (window.__CLAUDE_COOLDOWN_REMINDER_LOADED__) return;
  window.__CLAUDE_COOLDOWN_REMINDER_LOADED__ = true;

  // ----- 关键字（中英文常见提示） -----
  // 我们用关键字过滤候选节点，避免对每条 mutation 进行昂贵的解析。
  // 这些关键字用于"额度耗尽提示"（带绝对时间，如 reset at 3 PM）。
  const TRIGGER_KEYWORDS = [
    'message limit',
    'limit reached',
    'limit will reset',
    'limit resets',
    'reset at',
    'resets at',
    'try again',
    '额度', '限制', '限额', '已达上限', '稍后再试'
  ];

  // 这些关键字用于"使用量页面 / 倒计时片段"（相对时长，如 Resets in 4 hr 45 min）。
  // 触发词后紧跟数字 + 时长单位，与上面的"绝对时间"路径互不干扰。
  const RELATIVE_TRIGGERS = [
    'resets in',
    'reset in',
    'resets:',
    '重置于',
    '后重置',
    '后恢复',
    '小时后',
    '分钟后'
  ];

  // ----- 时间解析正则 -----
  // 匹配如 "reset at 3:00 PM"、"resets at 3 PM"、"will reset at 15:30"
  // 也兼容 "Try again at 9:30 PM"
  const EN_TIME_RE = /(?:reset|resets|reset at|resets at|try again at|available again at|come back at)[^0-9apmAPM]{0,15}(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?/i;

  // 中文如 "下午 3:00 重置"、"将于 15:30 恢复"、"请在下午3点之后再试"
  const CN_TIME_RE = /(上午|下午|早上|晚上|凌晨|中午)?\s*(\d{1,2})(?:[:：](\d{2}))?\s*(?:点|时)?\s*(?:之后)?\s*(?:再|可|以|重置|恢复|继续|尝试|试)/;

  // 通用：仅匹配 HH:MM（24/12 小时）
  const GENERIC_TIME_RE = /\b(\d{1,2}):(\d{2})\s*(am|pm|a\.m\.|p\.m\.)?/i;

  // Weekly limits 上常见的格式： "Resets Fri 8:00 PM"
  // 也兼容 "Resets Friday 20:00" / "Resets Fri 8 PM"
  const EN_WEEKLY_RE = /\bresets\s+(sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\b/i;

  // 中文（尽力支持）："重置 周五 20:00" / "重置于 周五 下午8:00"
  const CN_WEEKLY_RE = /(?:重置(?:于|在)?)[\s：:]*?(周[一二三四五六日天])\s*(上午|下午|早上|晚上|凌晨|中午)?\s*(\d{1,2})(?:[:：](\d{2}))?/;

  /**
   * 把解析到的小时、分钟、AM/PM 转换为「未来最近」的 Date。
   * 如果当前时间已经晚于今天的目标时间，则推到明天。
   */
  function toFutureDate(hour, minute, meridiem, periodHint) {
    const now = new Date();
    let h = hour;

    const m = (meridiem || '').toLowerCase().replace(/\./g, '');
    if (m === 'pm' && h < 12) h += 12;
    if (m === 'am' && h === 12) h = 0;

    // 中文时段提示
    if (periodHint) {
      if ((periodHint === '下午' || periodHint === '晚上') && h < 12) h += 12;
      if (periodHint === '中午' && h < 12) h += 12;
      if ((periodHint === '上午' || periodHint === '早上' || periodHint === '凌晨') && h === 12) h = 0;
    }

    if (h < 0 || h > 23 || minute < 0 || minute > 59) return null;

    const target = new Date(now);
    target.setHours(h, minute, 0, 0);

    // 如果时间已过，则推到明天
    if (target.getTime() <= now.getTime() + 30 * 1000) {
      target.setDate(target.getDate() + 1);
    }
    return target;
  }

  function weekdayToIndex(weekdayText) {
    if (!weekdayText) return null;
    const key = weekdayText.trim().slice(0, 3).toLowerCase();
    const map = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
  }

  function cnWeekdayToIndex(w) {
    const map = { '周日': 0, '周天': 0, '周一': 1, '周二': 2, '周三': 3, '周四': 4, '周五': 5, '周六': 6 };
    return Object.prototype.hasOwnProperty.call(map, w) ? map[w] : null;
  }

  /**
   * 把「周几 + 时间」转换为未来最近一次发生的 Date（若已过则推到下周）。
   */
  function toFutureWeekdayDate(weekdayIndex, hour, minute, meridiem, periodHint) {
    if (!Number.isFinite(weekdayIndex) || weekdayIndex < 0 || weekdayIndex > 6) return null;
    const now = new Date();

    // 先把 hour/minute 解析成 24h
    let h = hour;
    const m = (meridiem || '').toLowerCase().replace(/\./g, '');
    if (m === 'pm' && h < 12) h += 12;
    if (m === 'am' && h === 12) h = 0;
    if (periodHint) {
      if ((periodHint === '下午' || periodHint === '晚上') && h < 12) h += 12;
      if (periodHint === '中午' && h < 12) h += 12;
      if ((periodHint === '上午' || periodHint === '早上' || periodHint === '凌晨') && h === 12) h = 0;
    }
    if (h < 0 || h > 23 || minute < 0 || minute > 59) return null;

    const target = new Date(now);
    const diff = (weekdayIndex - now.getDay() + 7) % 7;
    target.setDate(target.getDate() + diff);
    target.setHours(h, minute, 0, 0);

    // 如果目标时刻已经过去（或几乎到了），推到下周同一时刻
    if (target.getTime() <= now.getTime() + 30 * 1000) {
      target.setDate(target.getDate() + 7);
    }
    return target;
  }

  /**
   * 判断 usage 页面里的 "All models" 是否已经 100% used。
   */
  function isAllModelsFullyUsed(text) {
    if (!text) return false;
    // English
    const en = text.match(/all models[\s\S]{0,80}?(\d{1,3})%\s*used/i);
    if (en) {
      const p = parseInt(en[1], 10);
      return Number.isFinite(p) && p >= 100;
    }
    // Chinese
    const cn = text.match(/所有模型[\s\S]{0,80}?(\d{1,3})%\s*(?:已)?使用/i);
    if (cn) {
      const p = parseInt(cn[1], 10);
      return Number.isFinite(p) && p >= 100;
    }
    return false;
  }

  /**
   * 当 "All models" 100% used 时，从该块里解析 Weekly limits 的重置时间：
   * 例如 "All models ... Resets Fri 8:00 PM ... 100% used"。
   */
  function parseAllModelsWeeklyReset(text) {
    if (!text) return null;
    const lower = text.toLowerCase();
    let idx = lower.indexOf('all models');
    let labelLen = 'all models'.length;
    if (idx < 0) {
      idx = text.indexOf('所有模型');
      labelLen = '所有模型'.length;
    }
    if (idx < 0) return null;

    // 只取 All models 后面一小段，避免误匹配到 Claude Design 等其它行
    const slice = text.substring(idx, Math.min(text.length, idx + labelLen + 260));
    if (!/100%\s*used/i.test(slice) && !/100%\s*(?:已)?使用/i.test(slice)) return null;

    const m = slice.match(EN_WEEKLY_RE);
    if (m) {
      const weekday = weekdayToIndex(m[1]);
      const hour = parseInt(m[2], 10);
      const minute = m[3] ? parseInt(m[3], 10) : 0;
      const meridiem = m[4] || null;
      return toFutureWeekdayDate(weekday, hour, minute, meridiem, null);
    }

    const c = slice.match(CN_WEEKLY_RE);
    if (c) {
      const weekday = cnWeekdayToIndex(c[1]);
      const period = c[2] || null;
      const hour = parseInt(c[3], 10);
      const minute = c[4] ? parseInt(c[4], 10) : 0;
      return toFutureWeekdayDate(weekday, hour, minute, null, period);
    }

    return null;
  }

  /**
   * 从一段文本中尝试提取重置时间，返回 Date 或 null。
   */
  function extractResetTime(text) {
    if (!text) return null;
    const lower = text.toLowerCase();

    // 1) 优先英文显式格式
    const en = text.match(EN_TIME_RE);
    if (en) {
      const hour = parseInt(en[1], 10);
      const minute = en[2] ? parseInt(en[2], 10) : 0;
      const d = toFutureDate(hour, minute, en[3], null);
      if (d) return d;
    }

    // 2) 中文格式
    const cn = text.match(CN_TIME_RE);
    if (cn) {
      const period = cn[1] || null;
      const hour = parseInt(cn[2], 10);
      const minute = cn[3] ? parseInt(cn[3], 10) : 0;
      const d = toFutureDate(hour, minute, null, period);
      if (d) return d;
    }

    // 3) 文本中含有触发关键字才用通用 HH:MM 兜底（避免误捕获普通时间字符串）
    const hasTrigger = TRIGGER_KEYWORDS.some(k => lower.includes(k.toLowerCase()));
    if (hasTrigger) {
      const g = text.match(GENERIC_TIME_RE);
      if (g) {
        const hour = parseInt(g[1], 10);
        const minute = parseInt(g[2], 10);
        const d = toFutureDate(hour, minute, g[3], null);
        if (d) return d;
      }
    }

    return null;
  }

  /**
   * 检查一个文本片段是否像 Claude 的额度耗尽提示。
   */
  function looksLikeQuotaMessage(text) {
    if (!text || text.length > 600) return false;
    const lower = text.toLowerCase();
    return TRIGGER_KEYWORDS.some(k => lower.includes(k.toLowerCase()));
  }

  /**
   * 解析相对时长，例如 "Resets in 4 hr 45 min" / "Resets in 30 min" /
   * "重置于 4 小时 45 分钟后" / "Resets in 1 day 3 hr"。
   * 返回未来 Date 或 null。
   *
   * 这个函数不要求页面带"额度耗尽"关键字 —— 它专门用来从
   * https://claude.ai/settings/usage 这种页面抓"还剩多久重置"。
   */
  function parseRelativeDuration(text) {
    if (!text) return null;
    const lower = text.toLowerCase();

    // 在文本里找触发词，并取后续 ~80 字符作为窗口
    let triggerEnd = -1;
    for (const t of RELATIVE_TRIGGERS) {
      const i = lower.indexOf(t.toLowerCase());
      if (i >= 0) {
        // 中文触发词如 "后重置"、"小时后"，时间在它前面，所以窗口要包含前面
        const isSuffixCN = ['后重置', '后恢复', '小时后', '分钟后'].includes(t);
        if (isSuffixCN) {
          triggerEnd = i + t.length;
          // 把窗口起点往前推
          const start = Math.max(0, i - 40);
          return parseDurationWindow(text.substring(start, triggerEnd));
        }
        triggerEnd = i + t.length;
        break;
      }
    }
    if (triggerEnd < 0) return null;

    const window = text.substring(triggerEnd, triggerEnd + 80);
    return parseDurationWindow(window);
  }

  function parseDurationWindow(slice) {
    if (!slice) return null;
    let totalMs = 0;
    let foundAny = false;

    // 天 / day
    const dM = slice.match(/(\d+)\s*(?:days?|d(?=\s|$|\d))|(\d+)\s*天/i);
    if (dM) {
      const v = parseInt(dM[1] || dM[2], 10);
      if (Number.isFinite(v)) { totalMs += v * 24 * 3600 * 1000; foundAny = true; }
    }

    // 小时 / hour / hr
    const hM = slice.match(/(\d+)\s*(?:hours?|hrs?|hr|h(?=\s|$|\d))|(\d+)\s*(?:小时|时(?!分))/i);
    if (hM) {
      const v = parseInt(hM[1] || hM[2], 10);
      if (Number.isFinite(v)) { totalMs += v * 3600 * 1000; foundAny = true; }
    }

    // 分钟 / minute / min
    const mM = slice.match(/(\d+)\s*(?:minutes?|mins?|min)|(\d+)\s*(?:分钟|分(?!\d))/i);
    if (mM) {
      const v = parseInt(mM[1] || mM[2], 10);
      if (Number.isFinite(v)) { totalMs += v * 60 * 1000; foundAny = true; }
    }

    if (!foundAny) return null;
    if (totalMs < 60 * 1000) return null;            // < 1 分钟视为噪声
    if (totalMs > 7 * 24 * 3600 * 1000) return null; // > 7 天视为不合理

    return new Date(Date.now() + totalMs);
  }

  // ----- 防抖 + 去重 -----
  let lastDispatchedAt = 0;
  let lastDispatchedTs = 0;

  // usage 页面特殊：当 All models 100% used 时，必须按 Weekly limits 的重置时间，
  // 不能按 Current session 的 "Resets in ..." 来算。
  let allModelsExhausted = false;
  let lastUsageProbeAt = 0;
  let lastUsageProbeText = '';

  function isUsagePage() {
    try { return location && location.pathname && location.pathname.startsWith('/settings/usage'); }
    catch (_) { return false; }
  }

  function probeUsagePageText() {
    if (!isUsagePage()) return '';
    const now = Date.now();
    if (lastUsageProbeText && (now - lastUsageProbeAt) < 1500) return lastUsageProbeText;
    lastUsageProbeAt = now;
    try {
      lastUsageProbeText = (document.body && document.body.innerText) || '';
    } catch (_) {
      lastUsageProbeText = '';
    }
    if (isAllModelsFullyUsed(lastUsageProbeText)) allModelsExhausted = true;
    return lastUsageProbeText;
  }

  function dispatchUnlock(date, kind) {
    const ts = date.getTime();
    const now = Date.now();

    // 容差去重：相对时长在每次扫描时会有秒级漂移，
    // 因此把"3 分钟内的相近时间戳"视为同一目标，避免反复 setAlarm。
    const drift = Math.abs(ts - lastDispatchedTs);
    if (drift < 3 * 60 * 1000 && now - lastDispatchedAt < 10 * 60 * 1000) {
      return;
    }

    lastDispatchedAt = now;
    lastDispatchedTs = ts;

    chrome.runtime.sendMessage({
      type: 'CLAUDE_RESET_DETECTED',
      unlockTimestamp: ts,
      // 仅发送时间戳与来源类型（绝对/相对），不传出原始页面文本
      kind: kind || 'absolute'
    }, () => {
      // 忽略响应错误（如 service worker 暂时未唤醒）
      void chrome.runtime.lastError;
    });
  }

  function scanText(text) {
    if (!text) return;

    // 规则修复：
    // - 当 usage 页的 All models 已 100% used 时，优先抓 Weekly limits 的 "Resets Fri 8:00 PM"
    // - 此时忽略 Current session 的相对倒计时（"Resets in ..."）。
    // 注意：为了避免先扫到 Current session 导致误设闹钟，这里会轻量探测整页 innerText（带节流）。
    if (isUsagePage()) {
      const pageText = probeUsagePageText() || text;
      if (isAllModelsFullyUsed(pageText)) {
        allModelsExhausted = true;
        const weekly = parseAllModelsWeeklyReset(pageText) || parseAllModelsWeeklyReset(text);
        if (weekly) {
          dispatchUnlock(weekly, 'weekly');
        }
        return; // 不用相对倒计时
      }
    }

    // 路径 A：使用量页面 / 任何带 "Resets in X hr Y min" 这种相对时长的片段。
    // 不需要"额度耗尽"关键字，未达上限时也能从 /settings/usage 抓到。
    const relDate = parseRelativeDuration(text);
    if (relDate) {
      // 如果已经确认 All models 耗尽，就不要再被相对倒计时覆盖
      if (allModelsExhausted) return;
      dispatchUnlock(relDate, 'relative');
      return;
    }

    // 路径 B：额度耗尽提示（带绝对时间，如 "reset at 3 PM"）。
    if (!looksLikeQuotaMessage(text)) return;
    const date = extractResetTime(text);
    if (date) dispatchUnlock(date, 'absolute');
  }

  function scanNode(node) {
    if (!node) return;
    if (node.nodeType === Node.TEXT_NODE) {
      scanText(node.nodeValue || '');
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    // React 在一次 mutation 里可能挂载整块卡片（远超几百字符），
    // 不能因为大就跳过。parseRelativeDuration 走 indexOf + 小窗口正则，
    // 32KB 文本也不到 1ms，性能完全可接受。
    const text = (node.textContent || '').trim();
    if (!text) return;
    const sample = text.length > 32 * 1024 ? text.slice(0, 32 * 1024) : text;
    scanText(sample);
  }

  // ----- 启动 MutationObserver -----
  let observer = null;
  let scanTimer = null;

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver((mutations) => {
      // 防抖：合并 200ms 内的 mutation 一起处理
      if (scanTimer) return;
      scanTimer = setTimeout(() => {
        scanTimer = null;
        try {
          for (const m of mutations) {
            for (const n of m.addedNodes) scanNode(n);
            if (m.type === 'characterData') scanNode(m.target);
          }
        } catch (_) { /* 静默吞掉解析异常 */ }
      }, 200);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });

    // MutationObserver 已经覆盖了绝大多数场景，所以只补两次"安全网"扫描：
    //   - 2s：覆盖初次渲染时 React 一次性挂载、observer 可能错过的情况
    //   - 6s：覆盖慢渲染或客户端路由切换
    // 一旦 dispatch 成功就立刻跳过后续扫描；避免反复触发 innerText 强制 layout。
    function safetyNetScan() {
      if (lastDispatchedTs !== 0) return;
      try {
        const text = (document.body && document.body.innerText) || '';
        const sample = text.length > 32 * 1024 ? text.slice(0, 32 * 1024) : text;
        scanText(sample);
      } catch (_) { /* ignore */ }
    }
    setTimeout(safetyNetScan, 2000);
    setTimeout(safetyNetScan, 6000);
  }

  if (document.body) {
    startObserver();
  } else {
    document.addEventListener('DOMContentLoaded', startObserver, { once: true });
  }

  /**
   * 在整页 innerText 上跑一次完整扫描，返回 { found, ts, kind } 或 { found: false }。
   * 这条路径不走 dispatchUnlock 的容差去重 —— 让用户手动点的"重新扫描"始终生效。
   */
  async function fullScanAndDispatch() {
    const text = (document.body && document.body.innerText) || '';
    // 整页扫描，避免漏掉 /settings/usage 顶部的 "Resets in ..." 区块。
    // 32KB 上限足够覆盖任何 Claude 设置页，又能避免极端情况下卡顿。
    const sample = text.length > 32 * 1024 ? text.slice(0, 32 * 1024) : text;

    let date = null;
    let kind = 'relative';

    // 修复：All models 100% used 时，以 Weekly limits 的重置时间为准
    if (isUsagePage() && isAllModelsFullyUsed(sample)) {
      allModelsExhausted = true;
      date = parseAllModelsWeeklyReset(sample);
      kind = 'weekly';
    } else {
      date = parseRelativeDuration(sample);
      kind = 'relative';
    }

    if (!date) {
      // 退而求其次：找绝对时间提示（聊天页/弹窗提示里常见）
      if (looksLikeQuotaMessage(sample)) {
        date = extractResetTime(sample);
        kind = 'absolute';
      }
    }

    if (!date) return { found: false };

    // 重置容差去重的"上次"记录，让 background 也允许这次刷新
    lastDispatchedAt = 0;
    lastDispatchedTs = 0;

    const ts = date.getTime();
    const ack = await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'CLAUDE_RESET_DETECTED', unlockTimestamp: ts, kind },
        (r) => { void chrome.runtime.lastError; resolve(r || { ok: false }); }
      );
    });

    return { found: true, ts, kind, ack };
  }

  // 允许 popup 通过 chrome.tabs.sendMessage 触发一次手动重新扫描
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'CLAUDE_REMINDER_RESCAN') {
      (async () => {
        try {
          const result = await fullScanAndDispatch();
          sendResponse({ ok: true, ...result });
        } catch (e) {
          sendResponse({ ok: false, reason: (e && e.message) || 'error' });
        }
      })();
      return true; // 异步响应
    }
  });
})();
