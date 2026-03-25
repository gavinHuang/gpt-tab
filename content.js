'use strict';

// ── Tab UI for ChatGPT ───────────────────────────────────────────────────────
// One tab per user question. Shows only the selected Q&A turn.

const USER_SEL = '[data-message-author-role="user"]';

let tabBar   = null;   // the injected DOM node
let activeIdx = 0;     // currently visible tab index
let pinned   = false;  // user explicitly clicked a tab — don't auto-jump
let turnCount = 0;     // track to detect newly added turns
let enabled  = true;

// ── Core ─────────────────────────────────────────────────────────────────────

function getTurns() {
    const firstUser = document.querySelector(USER_SEL);
    if (!firstUser) return null;

    // Climb to the turn element (article or conversation-turn), then its parent list
    let el = firstUser.closest('article') ||
             firstUser.closest('[data-testid*="conversation-turn"]') ||
             firstUser.parentElement;
    if (!el?.parentElement) return null;
    const list = el.parentElement;

    const turns = [];
    let cur = null;
    for (const child of list.children) {
        if (child === tabBar) continue;
        const uMsg = child.querySelector(USER_SEL);
        if (uMsg) {
            const labelClone = uMsg.cloneNode(true);
            labelClone.querySelector('.gpt-question-time')?.remove();
            cur = {
                label: labelClone.textContent.trim().slice(0, 60) || `Q${turns.length + 1}`,
                els: [child],
                msgId: uMsg.dataset.messageId ||
                       uMsg.closest('[data-message-id]')?.dataset.messageId,
            };
            turns.push(cur);
        } else if (cur) {
            cur.els.push(child);
        }
        // elements before the first user message stay visible (intro / system UI)
    }
    return { list, turns };
}

function render() {
    if (!enabled) return;

    const got = getTurns();
    if (!got || !got.turns.length) { hideTabBar(); return; }
    const { list, turns } = got;

    // Auto-advance to newest tab when a new turn is added
    const isNew = turns.length > turnCount;
    turnCount = turns.length;
    if (isNew && !pinned) activeIdx = turns.length - 1;
    pinned = false;

    activeIdx = Math.max(0, Math.min(activeIdx, turns.length - 1));

    mountTabBar(list);
    renderTabs(turns);
    applyVisibility(turns);
}

function hideTabBar() {
    if (tabBar) tabBar.style.display = 'none';
}

function mountTabBar(list) {
    const main = document.querySelector('main');
    const parent = main ?? list.parentElement;
    if (tabBar && parent.contains(tabBar)) return; // already mounted

    tabBar?.remove();
    tabBar = document.createElement('div');
    tabBar.id = 'gpt-tabs-container';

    const nav = document.createElement('div');
    nav.className = 'gpt-nav-tabs';
    tabBar.appendChild(nav);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'gpt-close-btn';
    closeBtn.textContent = '✕';
    closeBtn.title = 'Disable tab mode';
    closeBtn.onclick = disable;
    tabBar.appendChild(closeBtn);

    parent.insertBefore(tabBar, parent.firstChild);
}

function renderTabs(turns) {
    const nav = tabBar.querySelector('.gpt-nav-tabs');
    nav.innerHTML = '';
    turns.forEach((t, i) => {
        const btn = document.createElement('button');
        btn.className = 'gpt-nav-link' + (i === activeIdx ? ' active' : '');
        btn.textContent = t.label.length > 28 ? t.label.slice(0, 28) + '…' : t.label;
        btn.title = t.label;
        btn.onclick = () => { pinned = true; activeIdx = i; render(); };
        nav.appendChild(btn);
    });
    tabBar.style.display = 'flex';
}

function applyVisibility(turns) {
    turns.forEach((t, i) => {
        t.els.forEach(el => el.classList.toggle('gpt-hidden', i !== activeIdx));
        if (i === activeIdx) injectQuestionTimestamp(t);
    });
}

function disable() {
    enabled = false;
    document.querySelectorAll('.gpt-hidden').forEach(el => el.classList.remove('gpt-hidden'));
    if (tabBar) tabBar.style.display = 'none';
}

// ── SPA navigation (ChatGPT is a Next.js app) ────────────────────────────────

function onNavigate() {
    tabBar?.remove();
    tabBar    = null;
    activeIdx = 0;
    pinned    = false;
    turnCount = 0;
    enabled   = true;
    schedule();
}

const _push = history.pushState.bind(history);
history.pushState = (...args) => { _push(...args); onNavigate(); };
window.addEventListener('popstate', onNavigate);

// ── Mutation observer ────────────────────────────────────────────────────────
// Observes childList only (not attributes) so toggling .gpt-hidden never re-fires it.
// Skips mutations that are entirely inside our own tab bar.

let timer = null;
function schedule() {
    clearTimeout(timer);
    timer = setTimeout(render, 250);
}

new MutationObserver(muts => {
    if (!enabled) return;
    if (muts.every(m => tabBar?.contains(m.target))) return; // our own changes
    schedule();
}).observe(document.body, { childList: true, subtree: true });

// ── Conversation timestamps ───────────────────────────────────────────────────

const msgTimestamps = {}; // messageId → create_time (Unix seconds)

document.addEventListener('__gpt_ext_ts', e => {
    Object.assign(msgTimestamps, e.detail);
    schedule();
});

function formatDateTime(d) {
    return d.toLocaleString(undefined, {
        month: 'short', day: 'numeric', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
    });
}

function injectQuestionTimestamp(turn) {
    if (!turn.msgId) return;
    const ts = msgTimestamps[turn.msgId];
    if (!ts) return;
    const firstEl = turn.els[0];
    if (firstEl.querySelector('.gpt-question-time')) return;
    const userEl = firstEl.querySelector(USER_SEL);
    if (!userEl) return;
    const timeEl = document.createElement('div');
    timeEl.className = 'gpt-question-time';
    timeEl.textContent = formatDateTime(new Date(ts * 1000));
    userEl.appendChild(timeEl);
}

// ── Sidebar dates ─────────────────────────────────────────────────────────────
// ChatGPT conversation UUIDs encode the creation timestamp in the first 8 hex
// characters (Unix seconds), so no API call is needed.

function dateFromConvId(id) {
    const unix = parseInt(id?.replace(/-/g, '').slice(0, 8), 16);
    return isNaN(unix) ? null : new Date(unix * 1000);
}

function formatSidebarDate(d) {
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
        return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    }
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    if (d.getFullYear() === now.getFullYear()) {
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function injectSidebarDates() {
    const root = document.getElementById('history');
    if (!root) return;
    for (const a of root.querySelectorAll('a[href*="/c/"]')) {
        if (a.querySelector('.gpt-sidebar-date')) continue;
        const convId = a.href.match(/\/c\/([^/?#]+)/)?.[1];
        const d = dateFromConvId(convId);
        if (!d) continue;
        const badge = document.createElement('div');
        badge.className = 'gpt-sidebar-date';
        badge.textContent = formatSidebarDate(d);
        a.appendChild(badge);
    }
}

let sidebarTimer = null;
new MutationObserver(muts => {
    const sidebar = document.getElementById('history');
    if (!sidebar) return;
    if (muts.some(m => sidebar.contains(m.target))) {
        clearTimeout(sidebarTimer);
        sidebarTimer = setTimeout(injectSidebarDates, 300);
    }
}).observe(document.body, { childList: true, subtree: true });

// ── Boot ──────────────────────────────────────────────────────────────────────
schedule();

// Poll until #history has conversation links (React may render them after document_idle)
(function pollSidebar() {
    if (document.querySelector('#history a[href*="/c/"]')) {
        injectSidebarDates();
    } else {
        setTimeout(pollSidebar, 250);
    }
})();
