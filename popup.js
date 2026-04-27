/**
 * Claude Cooldown Reminder - Popup script
 *
 * Renders alarm state + countdown, handles manual input and control buttons.
 * All user-facing strings come from chrome.i18n (see _locales/).
 */

const $ = (id) => document.getElementById(id);

const els = {
  card: $('status-card'),
  label: $('status-label'),
  countdown: $('countdown'),
  emptyHint: $('empty-hint'),
  h: $('cd-h'), m: $('cd-m'), s: $('cd-s'),
  target: $('target-time'),
  source: $('source-tag'),
  date: $('manual-date'),
  time: $('manual-time'),
  set: $('btn-set'),
  cancel: $('btn-cancel'),
  rescan: $('btn-rescan'),
  test: $('btn-test'),
  helpHint: $('help-hint'),
};

let timerId = null;
let currentState = null;

// ===== i18n helpers =====
//
// Chrome's _locales/ files are loaded only at extension boot. After we add
// or edit them you MUST fully reload the extension at chrome://extensions —
// just refreshing the page is not enough. To guard against the popup ever
// rendering raw key names ("testHelpHint" etc.) we ship an English fallback
// dictionary baked into the code.
const I18N_FALLBACK = {
  statusIdle: 'Not watching',
  statusArmed: 'Alarm scheduled',
  todayWord: 'today',
  alarmTimeLabel: 'Alarm time: $1',
  sourceManualLabel: 'Source: manual',
  sourceAutoLabel: 'Source: auto-detected',

  errFillDateTime: 'Pick a date and time',
  errFutureTime: 'Pick a future time',
  errSetFailed: 'Failed to set',
  okCaptured: 'Captured!',
  okNoTime: 'No time on page',
  errScanFailed: 'Scan failed',
  rescanScanning: 'Scanning…',
  rescanOpenedUsage: 'Opened usage page',

  testSent: 'Sent — check the corner',
  testHelpHint:
    "If nothing appears within a few seconds, check:\n" +
    "• macOS: System Settings → Notifications → Google Chrome\n" +
    "• Windows: Settings → System → Notifications → Google Chrome\n" +
    "• Whether system Focus / Do Not Disturb is on",
  testDeniedByChrome: 'Notifications disabled in Chrome',
  testDeniedHint:
    "Chrome has muted notifications for this extension.\n" +
    "Open chrome://settings/content/notifications and make sure " +
    "\"Claude Cooldown Reminder\" is not in the Block list.",
  testFailed: 'Trigger failed',
  errPrefix: 'Error: $1',
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

function fmtTarget(ts) {
  const d = new Date(ts);
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  // Locale-aware date display ("today" or e.g. "May 15" / "5月15日").
  const dateStr = sameDay
    ? t('todayWord')
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return t('alarmTimeLabel', [`${dateStr} ${time}`]);
}

function send(type, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...payload }, (resp) => {
      void chrome.runtime.lastError;
      resolve(resp || { ok: false });
    });
  });
}

// ===== rendering =====
function setStatus(kind, label) {
  els.card.classList.remove('idle', 'armed', 'fired');
  els.card.classList.add(kind);
  els.label.textContent = label;
}

function renderState(state) {
  currentState = state;

  if (!state || !state.unlockTimestamp || state.unlockTimestamp <= Date.now()) {
    setStatus('idle', t('statusIdle'));
    els.countdown.hidden = true;
    els.emptyHint.hidden = false;
    els.cancel.hidden = true;
    stopTicking();
    return;
  }

  setStatus('armed', t('statusArmed'));
  els.countdown.hidden = false;
  els.emptyHint.hidden = true;
  els.cancel.hidden = false;
  els.target.textContent = fmtTarget(state.unlockTimestamp);
  els.source.textContent = state.source === 'manual' ? t('sourceManualLabel') : t('sourceAutoLabel');
  startTicking();
}

function tick() {
  if (!currentState || !currentState.unlockTimestamp) return;
  const remain = Math.max(0, currentState.unlockTimestamp - Date.now());
  if (remain <= 0) {
    refreshState();
    return;
  }
  const totalSec = Math.floor(remain / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  els.h.textContent = pad(h);
  els.m.textContent = pad(m);
  els.s.textContent = pad(s);
}

function startTicking() {
  stopTicking();
  tick();
  timerId = setInterval(tick, 1000);
}

function stopTicking() {
  if (timerId) { clearInterval(timerId); timerId = null; }
}

async function refreshState() {
  const resp = await send('CLAUDE_REMINDER_GET_STATE');
  renderState(resp.state);
}

// ===== manual form =====
function fillDefaultManual() {
  // Default: now + 5 hours
  const d = new Date(Date.now() + 5 * 60 * 60 * 1000);
  els.date.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  els.time.value = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function manualToTimestamp() {
  const d = els.date.value;
  const tt = els.time.value;
  if (!d || !tt) return null;
  const [y, mo, da] = d.split('-').map(Number);
  const [hh, mm] = tt.split(':').map(Number);
  const dt = new Date(y, mo - 1, da, hh, mm, 0, 0);
  if (isNaN(dt.getTime())) return null;
  return dt.getTime();
}

async function onSet() {
  const ts = manualToTimestamp();
  if (!ts) {
    flash(els.set, t('errFillDateTime'));
    return;
  }
  if (ts <= Date.now()) {
    flash(els.set, t('errFutureTime'));
    return;
  }
  els.set.disabled = true;
  const resp = await send('CLAUDE_RESET_MANUAL', { unlockTimestamp: ts });
  els.set.disabled = false;
  if (!resp.ok) {
    flash(els.set, t('errSetFailed'));
    return;
  }
  await refreshState();
}

async function onCancel() {
  els.cancel.disabled = true;
  await send('CLAUDE_REMINDER_CANCEL');
  els.cancel.disabled = false;
  await refreshState();
}

async function onRescan() {
  els.rescan.disabled = true;
  // 立即给个反馈：扫描可能要几秒（可能需要打开 /settings/usage 等渲染）
  flash(els.rescan, t('rescanScanning'), 60 * 1000);
  try {
    // 整个流程委托给 background：popup 关闭后也能继续。
    // 如果 background 打开了一个新标签，焦点会切走，popup 会关闭，
    // 这条响应不会回到 popup —— 但 background 还是会把闹钟写入 storage，
    // 用户下次打开 popup 就能看到倒计时。
    const resp = await send('CLAUDE_REMINDER_TRIGGER_RESCAN');

    if (!resp || !resp.ok) {
      flash(els.rescan, t('errScanFailed'));
      return;
    }

    if (resp.found) {
      await new Promise((r) => setTimeout(r, 80));
      await refreshState();
      flash(els.rescan, t('okCaptured'));
    } else if (resp.openedUsage) {
      // 已打开 /settings/usage 但还没扫到时间。
      // 内容脚本里的 MutationObserver 会在页面渲染出 "Resets in..." 时自动捕获。
      flash(els.rescan, t('rescanOpenedUsage'));
    } else {
      flash(els.rescan, t('okNoTime'));
    }
  } catch (_) {
    flash(els.rescan, t('errScanFailed'));
  } finally {
    els.rescan.disabled = false;
  }
}

async function onTest() {
  els.test.disabled = true;
  try {
    const resp = await send('CLAUDE_REMINDER_TEST_NOTIFICATION');
    if (resp && resp.ok) {
      flash(els.test, t('testSent'));
      showHelpHint(t('testHelpHint'));
    } else if (resp && resp.permission === 'denied') {
      flash(els.test, t('testDeniedByChrome'));
      showHelpHint(t('testDeniedHint'));
    } else {
      flash(els.test, t('testFailed'));
      const err = (resp && resp.error) || 'unknown';
      showHelpHint(t('errPrefix', [String(err)]));
    }
  } catch (e) {
    flash(els.test, t('testFailed'));
  } finally {
    els.test.disabled = false;
  }
}

function showHelpHint(text) {
  if (!els.helpHint) return;
  els.helpHint.textContent = text;
  els.helpHint.hidden = false;
  clearTimeout(showHelpHint._t);
  showHelpHint._t = setTimeout(() => { els.helpHint.hidden = true; }, 12000);
}

function flash(btn, msg, ms) {
  if (!btn) return;
  const old = btn.dataset.origText || btn.textContent;
  btn.dataset.origText = old;
  btn.textContent = msg;
  if (btn._flashTimer) clearTimeout(btn._flashTimer);
  btn._flashTimer = setTimeout(() => {
    btn.textContent = btn.dataset.origText || old;
    btn._flashTimer = null;
  }, ms || 1500);
}

// ===== boot =====
applyStaticI18n();

document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    const mins = Number(chip.dataset.mins) || 0;
    const d = new Date(Date.now() + mins * 60 * 1000);
    els.date.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    els.time.value = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  });
});

els.set.addEventListener('click', onSet);
els.cancel.addEventListener('click', onCancel);
els.rescan.addEventListener('click', onRescan);
els.test.addEventListener('click', onTest);

fillDefaultManual();
refreshState();

window.addEventListener('unload', stopTicking);
