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
const STORAGE_KEY = 'reminderState';
const CLAUDE_URL = 'https://claude.ai/';

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
 * 注册（或刷新）闹钟。目标时间直接使用 API 返回的精确 resets_at，
 * 不再加缓冲（缓冲是过去解析页面粗略文案时的遗留做法），
 * 保证倒计时和窗口列表显示的时间完全一致。
 * 如果传入的时间小于等于现在，则立即触发一次通知并清理状态。
 */
async function scheduleAlarm(unlockTimestamp) {
  const now = Date.now();
  if (!Number.isFinite(unlockTimestamp)) return { ok: false, reason: 'invalid-time' };

  if (unlockTimestamp <= now + 1000) {
    await fireNotification();
    await clearState();
    await chrome.alarms.clear(ALARM_NAME);
    return { ok: true, fired: true };
  }

  // 容差去重：相对时长随扫描时间漂移，3 分钟内的相近目标视为同一个，
  // 避免每次刷新用量就重置闹钟。
  const existing = await getState();
  if (existing && Math.abs(existing.unlockTimestamp - unlockTimestamp) < 3 * 60 * 1000) {
    return { ok: true, unchanged: true };
  }

  await chrome.alarms.clear(ALARM_NAME);
  await chrome.alarms.create(ALARM_NAME, { when: unlockTimestamp });
  await setState({
    unlockTimestamp,
    createdAt: now,
    source: 'auto'
  });
  return { ok: true, scheduled: true };
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
 */
async function fireNotification() {
  const permission = await getPermissionLevel();
  if (permission !== 'granted') {
    return { ok: false, permission, error: 'permission-denied' };
  }

  // 文案来自 chrome.i18n —— 用户的 Chrome 语言决定使用哪个 _locales 目录。
  const title = chrome.i18n.getMessage('notifTitleReady');
  const message = chrome.i18n.getMessage('notifMsgReady');

  try {
    // 先清掉同 ID 的旧通知，确保下次仍能弹出
    await new Promise((resolve) => {
      chrome.notifications.clear(NOTIFICATION_ID, () => resolve());
    });

    const createdId = await new Promise((resolve, reject) => {
      chrome.notifications.create(NOTIFICATION_ID, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title,
        message,
        priority: 2,
        requireInteraction: true
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

// ----- 用量数据（claude.ai /usage API）-----

/**
 * 组织 ID 发现：列出 /api/organizations，优先取具备 chat 能力的组织。
 * （请求会自动携带登录 cookie，这依赖 host_permissions，无需 cookies 权限。）
 */
async function getOrgIdFromApi() {
  try {
    const resp = await fetch('https://claude.ai/api/organizations', {
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include'
    });
    if (!resp.ok) return null;
    const orgs = await resp.json();
    if (!Array.isArray(orgs) || orgs.length === 0) return null;
    const chatOrg = orgs.find(
      (o) => Array.isArray(o.capabilities) && o.capabilities.includes('chat')
    );
    return (chatOrg || orgs[0]).uuid || null;
  } catch (_) {
    return null;
  }
}

/**
 * 把 /usage 响应归一化成一组进度条条目：
 *   { key, model, percentage, resetsAt, order }
 * 新格式是 limits 数组（kind: session / weekly_all / weekly_scoped），
 * 旧格式是顶层 five_hour / seven_day / seven_day_sonnet / seven_day_opus 字段。
 */
function normalizeUsage(raw) {
  const toTs = (iso) => {
    if (!iso) return null;
    const t = new Date(iso).getTime();
    return Number.isFinite(t) ? t : null;
  };
  const items = [];
  const push = (key, model, percentage, resetsAt, order) => {
    if (typeof percentage !== 'number' || !Number.isFinite(percentage)) return;
    items.push({ key, model, percentage: Math.max(0, percentage), resetsAt, order });
  };

  if (Array.isArray(raw.limits) && raw.limits.length > 0) {
    let scopedIdx = 0;
    for (const entry of raw.limits) {
      if (entry.kind === 'session') {
        push('session', null, entry.percent, toTs(entry.resets_at), 0);
      } else if (entry.kind === 'weekly_all') {
        push('weekly', null, entry.percent, toTs(entry.resets_at), 1);
      } else if (entry.kind === 'weekly_scoped') {
        const model = entry.scope?.model?.display_name || '';
        push('modelWeekly', model, entry.percent, toTs(entry.resets_at), 2 + scopedIdx++);
      }
    }
  } else {
    const old = (obj) => (obj ? { p: obj.utilization, r: toTs(obj.resets_at) } : null);
    const s = old(raw.five_hour);
    const w = old(raw.seven_day);
    const so = old(raw.seven_day_sonnet);
    const op = old(raw.seven_day_opus);
    if (s) push('session', null, s.p, s.r, 0);
    if (w) push('weekly', null, w.p, w.r, 1);
    if (so) push('modelWeekly', 'Sonnet', so.p, so.r, 2);
    if (op) push('modelWeekly', 'Opus', op.p, op.r, 3);
  }

  items.sort((a, b) => a.order - b.order);
  return items;
}

/**
 * 某个额度已打满时，直接用 API 给的精确 resets_at 自动布防闹钟。
 * 比从页面文本里抠 "Resets in 4 hr 53 min" 精确得多。
 * 取所有已满额度里最早的重置时间。
 */
async function maybeAutoArmFromUsage(limits) {
  const now = Date.now();
  const maxed = limits.filter(
    (l) => l.percentage >= 100 && l.resetsAt && l.resetsAt > now
  );
  if (!maxed.length) return;
  const earliest = Math.min(...maxed.map((l) => l.resetsAt));
  try {
    await scheduleAlarm(earliest);
  } catch (_) { /* 布防失败不影响用量展示 */ }
}

let usageCache = { at: 0, data: null };
const USAGE_CACHE_TTL_MS = 30 * 1000;
// 最近一次成功的快照持久化到 storage：网络抖动/重开浏览器时可以先展示旧数据。
const USAGE_SNAPSHOT_KEY = 'usageSnapshotV1';

async function getStoredSnapshot() {
  try {
    const obj = await chrome.storage.local.get(USAGE_SNAPSHOT_KEY);
    return obj[USAGE_SNAPSHOT_KEY] || null;
  } catch (_) {
    return null;
  }
}

/** 失败响应统一带上 stale 兜底数据（如果有），让 popup 依然能展示。 */
async function usageFailure(reason) {
  return { ok: false, reason, stale: await getStoredSnapshot() };
}

/** 请求某个组织的 /usage。返回 { raw } 或 { errReason }。 */
async function fetchUsageFor(orgId) {
  let resp;
  try {
    resp = await fetch(`https://claude.ai/api/organizations/${orgId}/usage`, {
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include'
    });
  } catch (_) {
    return { errReason: 'network' };
  }
  if (resp.status === 401) return { errReason: 'not-logged-in' };
  if (resp.status === 403 || resp.status === 404) return { errReason: 'wrong-org' };
  if (!resp.ok) return { errReason: 'http-' + resp.status };
  try {
    return { raw: await resp.json() };
  } catch (_) {
    return { errReason: 'bad-json' };
  }
}

async function getUsageSnapshot(force = false) {
  if (!force && usageCache.data && Date.now() - usageCache.at < USAGE_CACHE_TTL_MS) {
    return usageCache.data;
  }

  const orgId = await getOrgIdFromApi();
  if (!orgId) return usageFailure('not-logged-in');

  const result = await fetchUsageFor(orgId);
  if (result.errReason) {
    return usageFailure(result.errReason === 'wrong-org' ? 'not-logged-in' : result.errReason);
  }

  const limits = normalizeUsage(result.raw);
  const snapshot = { ok: true, limits, fetchedAt: Date.now() };
  usageCache = { at: snapshot.fetchedAt, data: snapshot };
  try {
    await chrome.storage.local.set({ [USAGE_SNAPSHOT_KEY]: snapshot });
  } catch (_) { /* 持久化失败不影响本次返回 */ }

  await maybeAutoArmFromUsage(limits);
  return snapshot;
}

// ----- 用量轮询 -----
//
// 没有 content script 之后，这是唯一的"无人值守"检测通道：
// 每 15 分钟拉一次 /usage，额度打满就用精确的 resets_at 自动布防闹钟。
// chrome.alarms 会唤醒休眠的 service worker，无需常驻。
const USAGE_POLL_ALARM = 'claude-usage-poll';
const USAGE_POLL_MINUTES = 15;

chrome.alarms.create(USAGE_POLL_ALARM, { periodInMinutes: USAGE_POLL_MINUTES });

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
  if (alarm.name === USAGE_POLL_ALARM) {
    // 静默轮询：失败（未登录、断网）就等下一轮，不打扰用户
    try { await getUsageSnapshot(true); } catch (_) { /* ignore */ }
    return;
  }
  if (alarm.name !== ALARM_NAME) return;
  await fireNotification();
  await clearState();
});

chrome.notifications.onClicked.addListener(async (notificationId) => {
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
  if (notificationId === NOTIFICATION_ID) {
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
        case 'CLAUDE_REMINDER_GET_STATE': {
          const state = await getState();
          sendResponse({ ok: true, state });
          return;
        }
        case 'CLAUDE_REMINDER_TEST_NOTIFICATION': {
          // 直接发一条正式文案的通知，让用户确认通知通道畅通
          const result = await fireNotification();
          sendResponse(result);
          return;
        }
        case 'CLAUDE_USAGE_GET': {
          const result = await getUsageSnapshot(!!msg.force);
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
