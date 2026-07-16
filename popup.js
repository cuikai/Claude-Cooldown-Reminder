/**
 * Claude Cooldown Reminder - Popup script
 *
 * 三块内容，全部由 claude.ai 的 /usage API 数据驱动：
 *   1. 状态卡片：闹钟倒计时（额度打满时后台自动布防），或会话额度的重置倒计时
 *   2. 窗口卡片：接下来 3 个 5 小时窗口的推算（按连续使用假设）
 *   3. 用量卡片：各额度的进度条 + 重置时间
 * All user-facing strings come from chrome.i18n (see _locales/).
 */

const $ = (id) => document.getElementById(id);

const els = {
  card: $('status-card'),
  label: $('status-label'),
  cdInline: $('cd-inline'),
  cdTime: $('cd-time'),
  emptyHint: $('empty-hint'),
  windowsList: $('windows-list'),
  usageList: $('usage-list'),
  usageNote: $('usage-note'),
  usageUpdated: $('usage-updated'),
  usageRefresh: $('btn-usage-refresh'),
  test: $('btn-test'),
  subtitle: $('subtitle'),
};

let timerId = null;
let currentState = null;    // 后台闹钟状态
let lastUsage = null;       // 最近一次 CLAUDE_USAGE_GET 响应（可能 ok，也可能带 stale 兜底）
let countdownTarget = null; // 状态卡片倒计时目标（ms）
let usageTimerId = null;
let lastRenderKey = null;   // 状态/窗口区域的渲染键：数据没变就不重画

// ===== i18n helpers =====
//
// Chrome's _locales/ files are loaded only at extension boot. After we add
// or edit them you MUST fully reload the extension at chrome://extensions —
// just refreshing the page is not enough. To guard against the popup ever
// rendering raw key names we ship an English fallback dictionary in code.
const I18N_FALLBACK = {
  statusIdle: 'Not watching',
  statusArmed: 'Alarm scheduled',
  statusWatching: 'Next reset',
  statusReady: 'Ready to go',
  statusNoData: 'Waiting for usage data…',
  todayWord: 'today',
  tomorrowWord: 'tomorrow',

  windowsIdle: 'Send a message now to start a new 5-hour window.',

  usageSectionTitle: 'Usage limits',
  btnUsageRefresh: 'Refresh',
  btnTest: 'Send a test notification',
  testSentHint: 'Sent. Nothing shown? Check the OS notification permission for Chrome.',
  testDeniedHint: 'Chrome has blocked notifications for this extension.',
  testFailedHint: 'Failed: $1',
  usageLoading: 'Loading usage…',
  usageNotLoggedIn: 'Sign in to claude.ai in this browser to see your usage.',
  usageError: "Couldn't load usage data. Is claude.ai reachable?",
  usageErrorNetwork: 'Network unavailable or claude.ai is unreachable.',
  usageEmpty: 'No active limits reported. You are good to go.',
  usageUpdatedAt: 'Updated $1',
  usageStaleAt: 'Refresh failed — showing data from $1',
  limitSession: 'Session (5h)',
  limitWeekly: 'Weekly',
  limitModelWeekly: '$1 Weekly',
  unitDay: 'd',
  unitHour: 'h',
  unitMin: 'm',
  unitSec: 's',
  resetNow: 'resetting…',
};

let i18nWarned = false;

function applyFallbackSubs(template, substitutions) {
  if (substitutions == null) return template;
  const arr = Array.isArray(substitutions) ? substitutions : [substitutions];
  return template.replace(/\$(\d+)/g, (_, n) => {
    const idx = Number(n) - 1;
    return arr[idx] != null ? String(arr[idx]) : '';
  });
}

function t(key, substitutions) {
  let msg = '';
  try {
    msg = chrome.i18n.getMessage(key, substitutions) || '';
  } catch (_) {
    msg = '';
  }
  if (msg) return msg;

  // Fall back to baked-in English copy and log once so the dev sees it.
  if (!i18nWarned) {
    i18nWarned = true;
    console.warn(
      '[Claude Cooldown Reminder] chrome.i18n.getMessage returned empty for "' + key +
      '". Likely cause: the extension was not fully reloaded after _locales/ was added. ' +
      'Open chrome://extensions and click the reload button on this extension.'
    );
  }
  const fb = I18N_FALLBACK[key];
  if (fb) return applyFallbackSubs(fb, substitutions);
  return key;
}

function applyStaticI18n() {
  // Localize the page lang attribute as a hint to screen readers.
  const uiLang = chrome.i18n.getUILanguage && chrome.i18n.getUILanguage();
  if (uiLang) document.documentElement.setAttribute('lang', uiLang);

  // Replace text content for everything tagged with data-i18n.
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    const msg = chrome.i18n.getMessage(key);
    if (msg) el.textContent = msg;
  });
}

// ===== utilities =====
function pad(n) { return String(n).padStart(2, '0'); }

/** "今天 19:09" / "明天 00:09" / "7月5日 10:09"。 */
function fmtDayTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const dayStart = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((dayStart(d) - dayStart(now)) / 86400000);
  let day;
  if (diffDays === 0) day = t('todayWord');
  else if (diffDays === 1) day = t('tomorrowWord');
  else day = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "1d 8h" / "2h 10m" / "35m" 风格的紧凑时长；zh 环境下单位取自 _locales。 */
function fmtShortDur(ms) {
  const totalMin = Math.ceil(ms / 60000);
  if (totalMin <= 0) return t('resetNow');
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d}${t('unitDay')} ${h}${t('unitHour')}`;
  if (h > 0) return `${h}${t('unitHour')} ${m}${t('unitMin')}`;
  return `${m}${t('unitMin')}`;
}

function send(type, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...payload }, (resp) => {
      void chrome.runtime.lastError;
      resolve(resp || { ok: false });
    });
  });
}

/** 可用于渲染的用量数据：新鲜的优先，其次是持久化的旧快照（stale）。 */
function effectiveUsage() {
  if (!lastUsage) return null;
  if (lastUsage.ok && lastUsage.limits) return lastUsage;
  if (lastUsage.stale && lastUsage.stale.limits) return lastUsage.stale;
  return null;
}

function limitLabel(item) {
  if (item.key === 'session') return t('limitSession');
  if (item.key === 'weekly') return t('limitWeekly');
  return t('limitModelWeekly', [item.model || '?']);
}

// ===== status card =====
function setStatus(kind, label) {
  els.card.classList.remove('idle', 'armed', 'fired');
  els.card.classList.add(kind);
  els.label.textContent = label;
}

/** 进行中的会话窗口（5 小时额度）的重置目标，没有则返回 null。 */
function pickSessionReset() {
  const data = effectiveUsage();
  if (!data) return null;
  const now = Date.now();
  const session = data.limits.find(
    (l) => l.key === 'session' && l.resetsAt && l.resetsAt > now
  );
  return session ? session.resetsAt : null;
}

/**
 * 状态卡片 = 闹钟状态 + 用量数据的合成视图：
 *   1. 闹钟已布防（某额度打满）→ 闹钟倒计时
 *   2. 有进行中的会话窗口 → 会话重置倒计时
 *   3. 有用量数据但没有进行中的窗口（倒计时归零、还没发新消息）→
 *      绿灯"额度可用"，提示发消息即开启新窗口
 *   4. 什么都没有 → 按具体原因提示（未登录 / 等待数据）
 */
function renderStatus() {
  const now = Date.now();
  const armed = currentState && currentState.unlockTimestamp && currentState.unlockTimestamp > now;

  if (armed) {
    setStatus('armed', t('statusArmed'));
    countdownTarget = currentState.unlockTimestamp;
    els.cdInline.hidden = false;
    els.emptyHint.hidden = true;
    startTicking();
    return;
  }

  const sessionReset = pickSessionReset();
  if (sessionReset) {
    setStatus('idle', t('statusWatching'));
    countdownTarget = sessionReset;
    els.cdInline.hidden = false;
    els.emptyHint.hidden = true;
    startTicking();
    return;
  }

  countdownTarget = null;
  els.cdInline.hidden = true;
  stopTicking();

  if (effectiveUsage()) {
    // 窗口已重置 / 从未开始：绿灯 + 引导发消息
    setStatus('fired', t('statusReady'));
    els.emptyHint.textContent = t('windowsIdle');
  } else {
    setStatus('idle', t('statusIdle'));
    els.emptyHint.textContent =
      lastUsage && !lastUsage.ok && lastUsage.reason === 'not-logged-in'
        ? t('usageNotLoggedIn')
        : t('statusNoData');
  }
  els.emptyHint.hidden = false;
}

function tick() {
  if (!countdownTarget) return;
  const remain = Math.max(0, countdownTarget - Date.now());
  if (remain <= 0) {
    // 目标到点：闹钟可能刚触发，或者额度窗口刚重置 → 都重新拉一遍。
    // 先停表，避免新数据还没回来时每秒重复触发刷新。
    stopTicking();
    countdownTarget = null;
    els.cdInline.hidden = true; // 立即隐藏倒计时，避免刷新期间残留"0秒"
    refreshState();
    loadUsage(true);
    return;
  }
  els.cdTime.textContent = fmtCountdown(Math.floor(remain / 1000));
}

/**
 * 倒计时专用格式：带单位（19小时 00分 56秒），刻意不用 HH:MM:SS，
 * 避免和 24 小时制时钟混淆。秒始终显示，让用户一眼看出它在往下走。
 */
function fmtCountdown(totalSec) {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts = [];
  if (h > 0) parts.push(`${h}${t('unitHour')}`);
  if (h > 0 || m > 0) parts.push(`${pad(m)}${t('unitMin')}`);
  parts.push(`${pad(s)}${t('unitSec')}`);
  return parts.join('');
}

function startTicking() {
  stopTicking();
  tick();
  timerId = setInterval(tick, 1000);
}

function stopTicking() {
  if (timerId) { clearInterval(timerId); timerId = null; }
}

async function fetchAlarmState() {
  const resp = await send('CLAUDE_REMINDER_GET_STATE');
  currentState = resp.state || null;
}

async function refreshState() {
  await fetchAlarmState();
  renderStatus();
}

/**
 * 状态 + 窗口区域的按需重绘。
 * resets_at 在窗口结束前不会变，闹钟时间同理——数据没变就跳过重画，
 * 30 秒一轮的定时刷新只更新用量进度条。
 * 例外："额度可用"状态下窗口推算锚定在"现在"，每轮都要跟着走。
 */
function maybeRenderStatusArea() {
  const now = Date.now();
  const armedTs =
    currentState && currentState.unlockTimestamp > now ? currentState.unlockTimestamp : 0;
  const sessionReset = pickSessionReset() || 0;
  const hasData = effectiveUsage() ? 1 : 0;
  const failReason = lastUsage && !lastUsage.ok ? lastUsage.reason : '';
  const key = `${armedTs}|${sessionReset}|${hasData}|${failReason}`;

  const isReady = hasData && !sessionReset && !armedTs;

  if (key !== lastRenderKey || isReady) {
    lastRenderKey = key;
    renderWindows();
    renderStatus();
  }
}

// ===== 5-hour windows =====

const WINDOW_MS = 5 * 60 * 60 * 1000;
const WINDOW_COUNT = 3;

/**
 * 向后推 3 个 5 小时窗口。锚点：
 *   - 有进行中的会话窗口 → 它的 resets_at（当前窗口的结束由上方倒计时表达）
 *   - 没有（额度可用状态）→ 现在，即"如果你现在开始"的推算
 * （窗口实际从你发出的第一条消息开始计时，此处为连续使用的推算。）
 */
function renderWindows() {
  const data = effectiveUsage();
  if (!data) {
    els.windowsList.hidden = true;
    return;
  }

  const anchor = pickSessionReset() || Date.now();

  els.windowsList.textContent = '';
  let start = anchor;
  for (let i = 1; i <= WINDOW_COUNT; i++) {
    addWindowRow(String(i), `${fmtDayTime(start)} → ${fmtDayTime(start + WINDOW_MS)}`);
    start += WINDOW_MS;
  }

  els.windowsList.hidden = false;
}

function addWindowRow(tag, text) {
  const row = document.createElement('div');
  row.className = 'win-row';
  const tagEl = document.createElement('span');
  tagEl.className = 'win-tag';
  tagEl.textContent = tag;
  const timeEl = document.createElement('span');
  timeEl.className = 'win-time';
  timeEl.textContent = text;
  row.append(tagEl, timeEl);
  els.windowsList.appendChild(row);
}

// ===== usage bars =====

function severityClass(pct) {
  if (pct >= 85) return 'crit';
  if (pct >= 60) return 'warn';
  return 'ok';
}

function usageNote(msg, isError) {
  els.usageNote.textContent = msg;
  els.usageNote.classList.toggle('error', !!isError);
  els.usageNote.hidden = false;
}

function reasonMessage(reason) {
  if (reason === 'not-logged-in') return t('usageNotLoggedIn');
  if (reason === 'network') return t('usageErrorNetwork');
  return t('usageError');
}

function renderBars(limits) {
  els.usageList.textContent = '';
  const now = Date.now();

  for (const item of limits) {
    const pct = Math.round(item.percentage);

    const row = document.createElement('div');
    row.className = `usage-row ${severityClass(pct)}`;

    const top = document.createElement('div');
    top.className = 'usage-top';

    const name = document.createElement('span');
    name.className = 'u-name';
    name.textContent = limitLabel(item) + ':';

    const pctEl = document.createElement('span');
    pctEl.className = 'u-pct';
    pctEl.textContent = `${pct}%`;

    const reset = document.createElement('span');
    reset.className = 'u-reset';
    if (item.resetsAt && item.resetsAt > now) {
      reset.textContent = fmtShortDur(item.resetsAt - now);
      reset.title = new Date(item.resetsAt).toLocaleString();
    }

    top.append(name, pctEl, reset);

    const track = document.createElement('div');
    track.className = 'u-track';
    const fill = document.createElement('div');
    fill.className = 'u-fill';
    fill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
    track.appendChild(fill);

    row.append(top, track);
    els.usageList.appendChild(row);
  }

  els.usageList.hidden = false;
}

function fmtClock(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 用量卡片的渲染，覆盖所有情况：
 *   - 拉取成功 → 进度条 + "更新于 HH:MM"
 *   - 拉取失败但有旧快照 → 旧进度条 + 失败原因 + "显示 HH:MM 的数据"
 *   - 拉取失败且无旧快照 → 只有原因提示（未登录 / 网络 / 其它）
 *   - 成功但没有任何限制条目 → "当前没有生效中的额度限制"
 */
function renderUsage(snapshot) {
  els.usageUpdated.hidden = true;
  els.usageUpdated.classList.remove('error');

  if (snapshot && snapshot.ok) {
    if (!snapshot.limits.length) {
      els.usageList.hidden = true;
      usageNote(t('usageEmpty'), false);
      return;
    }
    renderBars(snapshot.limits);
    els.usageNote.hidden = true;
    if (snapshot.fetchedAt) {
      els.usageUpdated.textContent = t('usageUpdatedAt', [fmtClock(snapshot.fetchedAt)]);
      els.usageUpdated.hidden = false;
    }
    return;
  }

  // 失败路径
  const reason = snapshot && snapshot.reason;
  const stale = snapshot && snapshot.stale;
  if (stale && stale.limits && stale.limits.length) {
    renderBars(stale.limits);
    usageNote(reasonMessage(reason), true);
    if (stale.fetchedAt) {
      els.usageUpdated.textContent = t('usageStaleAt', [fmtClock(stale.fetchedAt)]);
      els.usageUpdated.classList.add('error');
      els.usageUpdated.hidden = false;
    }
  } else {
    els.usageList.hidden = true;
    usageNote(reasonMessage(reason), true);
  }
}

async function loadUsage(force = false) {
  const snapshot = await send('CLAUDE_USAGE_GET', { force });
  lastUsage = snapshot;
  // 用量进度条每轮都更新（百分比在变）
  renderUsage(snapshot);
  // 后台可能刚根据满额数据自动布防了闹钟 → 同步一下闹钟状态，
  // 但状态/窗口区域只在重置时间、闹钟等真正变化时才重画。
  await fetchAlarmState();
  maybeRenderStatusArea();
}

async function onUsageRefresh() {
  els.usageRefresh.disabled = true;
  try {
    await loadUsage(true);
  } finally {
    els.usageRefresh.disabled = false;
  }
}

async function onTest() {
  els.test.disabled = true;
  const resp = await send('CLAUDE_REMINDER_TEST_NOTIFICATION');
  els.test.disabled = false;

  const ok = !!(resp && resp.ok);
  els.test.classList.add(ok ? 'sent' : 'failed');
  setTimeout(() => els.test.classList.remove('sent', 'failed'), 2500);

  // 副标题临时换成结果提示，几秒后恢复
  let msg;
  if (ok) {
    msg = t('testSentHint');
  } else if (resp && resp.permission === 'denied') {
    msg = t('testDeniedHint');
  } else {
    msg = t('testFailedHint', [String((resp && (resp.error || resp.reason)) || 'unknown')]);
  }
  flashSubtitle(msg, ok);
}

function flashSubtitle(msg, ok) {
  if (!els.subtitle.dataset.orig) els.subtitle.dataset.orig = els.subtitle.textContent;
  els.subtitle.textContent = msg;
  els.subtitle.classList.toggle('sub-err', !ok);
  clearTimeout(flashSubtitle._t);
  flashSubtitle._t = setTimeout(() => {
    els.subtitle.textContent = els.subtitle.dataset.orig;
    els.subtitle.classList.remove('sub-err');
  }, 5000);
}

// ===== boot =====
applyStaticI18n();
els.test.title = t('btnTest');

els.usageRefresh.addEventListener('click', onUsageRefresh);
els.test.addEventListener('click', onTest);

refreshState();
loadUsage();
// 弹窗开着时定期刷新用量（后台有 30s 缓存，开销很小）
usageTimerId = setInterval(() => loadUsage(), 30 * 1000);

window.addEventListener('unload', () => {
  stopTicking();
  if (usageTimerId) clearInterval(usageTimerId);
});
