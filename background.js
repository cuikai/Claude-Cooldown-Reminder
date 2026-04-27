/**
 * Claude 提醒助手 - 后台 Service Worker
 *
 * 职责：
 *   1. 接收来自内容脚本 / Popup 的解锁时间，注册 chrome.alarms 任务
 *   2. 闹钟到期时通过 chrome.notifications 触发系统级通知
 *   3. 用户点击通知时打开 claude.ai
 *
 * 隐私：所有状态都仅保存在 chrome.storage.local，绝不外传任何数据。
 */

const ALARM_NAME = 'claude-cooldown-reminder';
const NOTIFICATION_ID = 'claude-cooldown-reminder-notification';
const TEST_NOTIFICATION_ID = NOTIFICATION_ID + '-test';
const STORAGE_KEY = 'reminderState';
const CLAUDE_URL = 'https://claude.ai/';
const USAGE_URL = 'https://claude.ai/settings/usage';

/**
 * 持久化状态结构：
 * {
 *   unlockTimestamp: number,   // 目标解锁时间（ms）
 *   createdAt: number,         // 创建时间
 *   source: 'auto' | 'manual'  // 来源
 * }
 */

async function getState() {
  const obj = await chrome.storage.local.get(STORAGE_KEY);
  return obj[STORAGE_KEY] || null;
}

async function setState(state) {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

async function clearState() {
  await chrome.storage.local.remove(STORAGE_KEY);
}

/**
 * 给自动捕获的时间加 1 分钟缓冲。
 * Claude 的 "Resets in 4 hr 53 min" 是粗略向下取整，
 * 如果按它给的时间响铃，可能 Claude 的倒计时还没结束就提醒了用户。
 * 手动设置的时间是用户明确指定的，不加缓冲。
 */
const AUTO_DETECT_BUFFER_MS = 60 * 1000;

/**
 * 注册（或刷新）闹钟。
 * 如果传入的时间小于等于现在，则立即触发一次通知并清理状态。
 */
async function scheduleAlarm(unlockTimestamp, source) {
  const now = Date.now();
  if (!Number.isFinite(unlockTimestamp)) return { ok: false, reason: 'invalid-time' };

  // 自动来源加缓冲；手动来源原样保留。
  if (source !== 'manual') {
    unlockTimestamp = unlockTimestamp + AUTO_DETECT_BUFFER_MS;
  }

  if (unlockTimestamp <= now + 1000) {
    await fireNotification();
    await clearState();
    await chrome.alarms.clear(ALARM_NAME);
    return { ok: true, fired: true };
  }

  // 容差去重：相对时长在使用量页面随时间漂移，3 分钟内的相近目标视为同一个，
  // 避免每次内容脚本重新扫描就重置闹钟。
  const existing = await getState();
  if (existing && Math.abs(existing.unlockTimestamp - unlockTimestamp) < 3 * 60 * 1000) {
    return { ok: true, unchanged: true };
  }

  // 自动捕获不要覆盖用户手动设置的闹钟（除非时间差距明显，> 30 分钟）。
  if (
    source !== 'manual' &&
    existing && existing.source === 'manual' &&
    Math.abs(existing.unlockTimestamp - unlockTimestamp) < 30 * 60 * 1000
  ) {
    return { ok: true, unchanged: true, kept: 'manual' };
  }

  await chrome.alarms.clear(ALARM_NAME);
  await chrome.alarms.create(ALARM_NAME, { when: unlockTimestamp });
  await setState({
    unlockTimestamp,
    createdAt: now,
    source: source || 'auto'
  });
  return { ok: true, scheduled: true };
}

async function cancelAlarm() {
  await chrome.alarms.clear(ALARM_NAME);
  await clearState();
  return { ok: true };
}

/**
 * 查询浏览器层面的通知权限。
 * 返回 'granted' / 'denied'。注意：这个值反映的是 Chrome 内部的扩展通知开关，
 * macOS / Windows 系统层面是否允许 Chrome 弹通知是另一回事，必须由用户在
 * 系统设置里授权，扩展无法以编程方式触发系统对话框。
 */
function getPermissionLevel() {
  return new Promise((resolve) => {
    try {
      chrome.notifications.getPermissionLevel((level) => resolve(level || 'granted'));
    } catch (_) {
      resolve('granted');
    }
  });
}

/**
 * 触发系统通知。返回 { ok, permission, error }。
 * @param {{ test?: boolean }} [opts]
 */
async function fireNotification(opts = {}) {
  const permission = await getPermissionLevel();
  if (permission !== 'granted') {
    return { ok: false, permission, error: 'permission-denied' };
  }

  // 测试通知用独立 ID，避免和真正闹钟通知互相覆盖
  const id = opts.test ? TEST_NOTIFICATION_ID : NOTIFICATION_ID;
  // 文案来自 chrome.i18n —— 用户的 Chrome 语言决定使用哪个 _locales 目录。
  const title = chrome.i18n.getMessage(opts.test ? 'notifTitleTest' : 'notifTitleReady');
  const message = chrome.i18n.getMessage(opts.test ? 'notifMsgTest' : 'notifMsgReady');

  try {
    // 先清掉同 ID 的旧通知，确保下次仍能弹出
    await new Promise((resolve) => {
      chrome.notifications.clear(id, () => resolve());
    });

    const createdId = await new Promise((resolve, reject) => {
      chrome.notifications.create(id, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title,
        message,
        priority: 2,
        requireInteraction: !opts.test  // 测试通知不需要长驻
      }, (createdId) => {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
        else resolve(createdId);
      });
    });

    return { ok: true, permission, id: createdId };
  } catch (e) {
    const msg = (e && e.message) || String(e);
    console.warn('[Claude Cooldown Reminder] notification failed:', msg);
    return { ok: false, permission, error: msg };
  }
}

// ----- 标签页查找与扫描 -----

/**
 * 给一个 claude.ai 标签页打分，挑出"最像聊天页"的那个。
 * 通知点击之后我们用它选目标标签：聊天 > 首页 > 任意 claude > 设置/用量页。
 */
function scoreClaudeTab(tab) {
  const url = (tab && tab.url) || '';
  let score = 0;
  if (/^https:\/\/claude\.ai\/chat\//i.test(url)) score += 100;
  else if (/^https:\/\/claude\.ai\/(?:new|project)/i.test(url)) score += 90;
  else if (/^https:\/\/claude\.ai\/?$/i.test(url)) score += 70;
  else if (/^https:\/\/claude\.ai\/settings/i.test(url)) score += 10;
  else score += 50;
  if (tab.active) score += 5;
  return score;
}

function waitForTabComplete(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { chrome.tabs.onUpdated.removeListener(listener); } catch (_) {}
      resolve();
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(finish, timeoutMs);
  });
}

/**
 * 让目标标签页的内容脚本扫描，最多重试 attempts 次（页面 SPA 渲染需要时间）。
 */
async function scanTabWithRetry(tabId, attempts = 1, gapMs = 1500) {
  for (let i = 0; i < attempts; i++) {
    const r = await new Promise((resolve) => {
      try {
        chrome.tabs.sendMessage(
          tabId,
          { type: 'CLAUDE_REMINDER_RESCAN' },
          (resp) => { void chrome.runtime.lastError; resolve(resp || { ok: false }); }
        );
      } catch (_) { resolve({ ok: false }); }
    });
    if (r && r.ok && r.found) return r;
    if (i < attempts - 1) await new Promise((res) => setTimeout(res, gapMs));
  }
  return { ok: false, found: false };
}

/**
 * 用户在 popup 点了"重新扫描"。流程：
 *   1. 优先扫当前窗口里激活的 claude.ai 标签
 *   2. 没有就扫任意一个 claude.ai 标签
 *   3. 都没有，或者前面没扫到时间 → 打开（或聚焦）/settings/usage 再扫一次
 *
 * 整套流程放在 background 里跑，因为 popup 关闭后 setTimeout/await 会被打断；
 * service worker 不会受 popup 关闭影响。
 */
async function performRescan() {
  // 1) 当前窗口里活动的 claude.ai 标签
  let candidates = await chrome.tabs.query({
    url: 'https://claude.ai/*',
    active: true,
    currentWindow: true
  });
  // 2) 否则任意一个
  if (!candidates.length) {
    candidates = await chrome.tabs.query({ url: 'https://claude.ai/*' });
  }

  // 先快试一下当前活动标签（最多 2 次）
  if (candidates.length) {
    const r = await scanTabWithRetry(candidates[0].id, 2, 1200);
    if (r.found) return { ok: true, found: true, ts: r.ts, source: 'existing-tab' };
  }

  // 3) 当前标签没扫到 → 找/造一个 /settings/usage 标签再扫
  let usageTabId;
  let createdNew = false;

  const usageTabs = await chrome.tabs.query({ url: 'https://claude.ai/settings/usage*' });
  if (usageTabs.length) {
    usageTabId = usageTabs[0].id;
    try {
      await chrome.tabs.update(usageTabId, { active: true });
      if (usageTabs[0].windowId !== undefined) {
        await chrome.windows.update(usageTabs[0].windowId, { focused: true });
      }
    } catch (_) { /* ignore */ }

    // 关键修复：复用已存在的 usage 标签时强制 reload 一次。
    // 原因：如果该标签是在扩展上次 reload 之前就开着的，
    // Chrome 不会自动给它注入 content script，扫描永远拿不到回应。
    // /settings/usage 没有可丢失的页面状态，重新加载是无副作用的。
    try {
      await chrome.tabs.reload(usageTabId);
      await waitForTabComplete(usageTabId);
      await new Promise((r) => setTimeout(r, 3000));
    } catch (_) { /* ignore reload errors */ }
  } else {
    try {
      const newTab = await chrome.tabs.create({ url: USAGE_URL, active: true });
      usageTabId = newTab.id;
      createdNew = true;
      await waitForTabComplete(usageTabId);
      // 等 React 渲染出 "Resets in ..." 区块；claude 设置页较慢，给 3.5s
      await new Promise((r) => setTimeout(r, 3500));
    } catch (e) {
      return { ok: false, error: (e && e.message) || 'open-tab-failed' };
    }
  }

  // SPA 渲染节奏不可预测：6 次重试 × 2s = 最多 12s 的扫描窗口
  const r2 = await scanTabWithRetry(usageTabId, 6, 2000);
  return {
    ok: true,
    found: !!r2.found,
    ts: r2.ts,
    openedUsage: true,
    createdNew
  };
}

// ----- 事件处理 -----

chrome.runtime.onInstalled.addListener(async () => {
  // 安装/升级后保险地清掉过期闹钟
  const state = await getState();
  if (state && state.unlockTimestamp <= Date.now()) {
    await clearState();
    await chrome.alarms.clear(ALARM_NAME);
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  await fireNotification();
  await clearState();
});

chrome.notifications.onClicked.addListener(async (notificationId) => {
  // 测试通知：点了就关，不打开任何页面
  if (notificationId === TEST_NOTIFICATION_ID) {
    chrome.notifications.clear(TEST_NOTIFICATION_ID);
    return;
  }
  if (notificationId !== NOTIFICATION_ID) return;
  chrome.notifications.clear(NOTIFICATION_ID);

  // 寻找最适合"回到聊天"的 claude.ai 标签：
  //   聊天页 > /new、/project > 首页 > 其它 > 设置/用量页
  // host_permissions 已涵盖 claude.ai，无需 "tabs" 权限即可读取 url。
  try {
    const tabs = await chrome.tabs.query({ url: 'https://claude.ai/*' });
    if (tabs && tabs.length > 0) {
      const target = tabs
        .map((t) => ({ tab: t, score: scoreClaudeTab(t) }))
        .sort((a, b) => b.score - a.score)[0].tab;

      await chrome.tabs.update(target.id, { active: true });
      if (target.windowId !== undefined) {
        await chrome.windows.update(target.windowId, { focused: true });
      }
      return;
    }
  } catch (_) { /* 没有匹配标签或权限不足时忽略 */ }

  // 一个 claude 标签都没有 → 新开一个 Claude 首页
  try {
    await chrome.tabs.create({ url: CLAUDE_URL, active: true });
  } catch (_) { /* 静默 */ }
});

chrome.notifications.onClosed.addListener((notificationId) => {
  // 主动清理同 ID 通知，确保下次能再弹
  if (notificationId === NOTIFICATION_ID || notificationId === TEST_NOTIFICATION_ID) {
    chrome.notifications.clear(notificationId);
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (!msg || typeof msg !== 'object') {
        sendResponse({ ok: false, reason: 'bad-message' });
        return;
      }

      switch (msg.type) {
        case 'CLAUDE_RESET_DETECTED': {
          const ts = Number(msg.unlockTimestamp);
          const result = await scheduleAlarm(ts, 'auto');
          sendResponse(result);
          return;
        }
        case 'CLAUDE_RESET_MANUAL': {
          const ts = Number(msg.unlockTimestamp);
          const result = await scheduleAlarm(ts, 'manual');
          sendResponse(result);
          return;
        }
        case 'CLAUDE_REMINDER_GET_STATE': {
          const state = await getState();
          sendResponse({ ok: true, state });
          return;
        }
        case 'CLAUDE_REMINDER_CANCEL': {
          const result = await cancelAlarm();
          sendResponse(result);
          return;
        }
        case 'CLAUDE_REMINDER_TEST_NOTIFICATION': {
          const result = await fireNotification({ test: true });
          sendResponse(result);
          return;
        }
        case 'CLAUDE_REMINDER_TRIGGER_RESCAN': {
          const result = await performRescan();
          sendResponse(result);
          return;
        }
        default:
          sendResponse({ ok: false, reason: 'unknown-type' });
      }
    } catch (e) {
      sendResponse({ ok: false, reason: (e && e.message) || 'error' });
    }
  })();
  return true; // 异步响应
});
