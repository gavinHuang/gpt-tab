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
            cur = {
                label: uMsg.textContent.trim().slice(0, 60) || `Q${turns.length + 1}`,
                els: [child],
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

// ── Boot ──────────────────────────────────────────────────────────────────────
schedule();
