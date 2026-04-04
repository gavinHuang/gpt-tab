'use strict';

// ── Tab UI for ChatGPT ───────────────────────────────────────────────────────
// One tab per user question. Shows only the selected Q&A turn.

const USER_SEL = '[data-message-author-role="user"]';

let tabBar   = null;   // the injected DOM node
let activeIdx = 0;     // currently visible tab index
let pinned   = false;  // user explicitly clicked a tab — don't auto-jump
let turnCount = 0;     // track to detect newly added turns
let enabled  = true;

// ── Branch state ──────────────────────────────────────────────────────────────
let currentConvId       = null;   // convId from current URL
let branchInfo          = null;   // CHECK_BRANCH response (if current page is a branch)
let branchChildrenByTurn = {};    // turnIndex → [node] for fork indicators + sub-tabs
let breadcrumb          = null;   // injected breadcrumb DOM node

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
                questionText: uMsg.textContent.trim(),
                answerText: null,
            };
            turns.push(cur);
        } else if (cur) {
            cur.els.push(child);
            // Capture AI response text from the first assistant element encountered
            if (!cur.answerText) {
                const aiMsg = child.querySelector('[data-message-author-role="assistant"]');
                if (aiMsg) cur.answerText = aiMsg.textContent.trim();
            }
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
    const main   = document.querySelector('main');
    const parent = main ?? list.parentElement;
    if (tabBar && parent.contains(tabBar)) return; // already mounted

    tabBar?.remove();
    tabBar = document.createElement('div');
    tabBar.id = 'gpt-tabs-container';

    // First row: nav tabs + close button
    const row = document.createElement('div');
    row.className = 'gpt-tabs-row';

    const nav = document.createElement('div');
    nav.className = 'gpt-nav-tabs';
    row.appendChild(nav);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'gpt-close-btn';
    closeBtn.textContent = '✕';
    closeBtn.title = 'Disable tab mode';
    closeBtn.onclick = disable;
    row.appendChild(closeBtn);

    tabBar.appendChild(row);
    parent.insertBefore(tabBar, parent.firstChild);
}

function renderTabs(turns) {
    const nav = tabBar.querySelector('.gpt-nav-tabs');
    nav.innerHTML = '';
    turns.forEach((t, i) => {
        const btn = document.createElement('button');
        btn.className = 'gpt-nav-link' + (i === activeIdx ? ' active' : '');
        const rawLabel = t.label.length > 28 ? t.label.slice(0, 28) + '…' : t.label;
        const hasBranches = (branchChildrenByTurn[i]?.length ?? 0) > 0;
        btn.textContent = hasBranches ? rawLabel + ' ⑃' : rawLabel;
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
        injectBranchBar(t, i);
    });
    renderSubTabs();
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
    breadcrumb?.remove();
    breadcrumb = null;
    document.getElementById('gpt-sub-tabs')?.remove();

    activeIdx = 0;
    pinned    = false;
    turnCount = 0;
    enabled   = true;

    // Reset branch state
    branchInfo          = null;
    branchChildrenByTurn = {};
    currentConvId       = null;

    // Report new convId to background (for branch node convId capture)
    const newConvId = getConvId();
    if (newConvId) {
        chrome.runtime.sendMessage({ type: 'REPORT_CONV_ID', convId: newConvId });
    }

    schedule();
    loadBranchState();
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

// ── Branch UI ─────────────────────────────────────────────────────────────────

function getConvId() {
    return location.pathname.match(/\/c\/([^/?#]+)/)?.[1] || null;
}

function escHtml(str) {
    return (str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

async function loadBranchState() {
    const convId = getConvId();
    currentConvId        = convId;
    branchInfo           = null;
    branchChildrenByTurn = {};

    if (!convId) return;

    // Check if this conversation is itself a branch
    const info = await new Promise(resolve =>
        chrome.runtime.sendMessage({ type: 'CHECK_BRANCH', convId }, resolve)
    );
    if (info?.isBranch) {
        branchInfo = info;
        renderBreadcrumb(info);
    }

    // Load branch children of this conversation (for fork indicators + sub-tabs)
    const children = await new Promise(resolve =>
        chrome.runtime.sendMessage({ type: 'GET_BRANCH_CHILDREN', convId }, resolve)
    );
    if (children && Object.keys(children).length > 0) {
        branchChildrenByTurn = children;
        schedule(); // re-render tabs with fork indicators
    }
}

function renderBreadcrumb(info) {
    breadcrumb?.remove();
    breadcrumb = document.createElement('div');
    breadcrumb.id = 'gpt-branch-breadcrumb';

    const parentLabel = info.parentNode?.label || 'parent conversation';
    const branchLabel = info.node?.label       || 'branch';
    const questionText = info.node?.questionText || '';

    breadcrumb.innerHTML =
        `<span class="gpt-breadcrumb-icon">🌿</span>` +
        `<span class="gpt-breadcrumb-text">Branched from: <em>${escHtml(parentLabel)}</em>` +
        (questionText ? ` — "<em>${escHtml(questionText.slice(0, 60))}…</em>"` : '') +
        ` → ${escHtml(branchLabel)}</span>` +
        `<button class="gpt-breadcrumb-back">← Back to parent</button>`;

    breadcrumb.querySelector('.gpt-breadcrumb-back').onclick = () => {
        const parentConvId = info.parentNode?.convId;
        if (parentConvId) location.href = `https://chatgpt.com/c/${parentConvId}`;
    };

    const main = document.querySelector('main');
    if (main) main.insertBefore(breadcrumb, main.firstChild);
}

function renderSubTabs() {
    // Remove existing sub-tab row
    document.getElementById('gpt-sub-tabs')?.remove();

    const children = branchChildrenByTurn[activeIdx];
    if (!children?.length || !tabBar) return;

    const subRow = document.createElement('div');
    subRow.id = 'gpt-sub-tabs';

    const arrow = document.createElement('span');
    arrow.className = 'gpt-sub-tabs-arrow';
    arrow.textContent = '↳';
    subRow.appendChild(arrow);

    for (const child of children) {
        const btn = document.createElement('button');
        btn.className = 'gpt-sub-tab';
        btn.textContent = child.label;
        btn.title = child.label;
        if (!child.convId) {
            btn.classList.add('gpt-sub-tab-pending');
            btn.title = 'Branch is loading…';
        } else {
            btn.onclick = () => { location.href = `https://chatgpt.com/c/${child.convId}`; };
        }
        subRow.appendChild(btn);
    }

    tabBar.appendChild(subRow);
}

const BRANCH_TYPES = [
    { type: 'deeper',    label: '🔍 Go deeper' },
    { type: 'challenge', label: '⚔ Challenge'   },
    { type: 'example',   label: '💡 Example'     },
    { type: 'custom',    label: '+ Custom'        },
];

function injectBranchBar(turn, turnIdx) {
    // Only inject when the turn has an AI response
    if (turn.els.length < 2) return;
    const lastEl = turn.els[turn.els.length - 1];

    // Always re-add the hover class — React can strip custom classes during re-renders
    lastEl.classList.add('gpt-has-branch-bar');

    // Don't re-inject the bar itself
    if (lastEl.querySelector('.gpt-branch-bar')) return;

    const bar = document.createElement('div');
    bar.className = 'gpt-branch-bar';

    for (const { type, label } of BRANCH_TYPES) {
        const btn = document.createElement('button');
        btn.className = 'gpt-branch-btn';
        btn.textContent = label;
        btn.dataset.branchType = type;
        btn.onclick = (e) => handleBranchClick(e, turn, turnIdx, type);
        bar.appendChild(btn);
    }

    lastEl.appendChild(bar);
}

function handleBranchClick(e, turn, turnIdx, branchType) {
    if (branchType === 'custom') {
        showCustomInput(e.target.closest('.gpt-branch-bar'), turn, turnIdx);
        return;
    }
    createBranch(turn, turnIdx, branchType, null);
}

function showCustomInput(bar, turn, turnIdx) {
    if (bar.querySelector('.gpt-branch-custom-input')) return;

    const input = document.createElement('input');
    input.className = 'gpt-branch-custom-input';
    input.type = 'text';
    input.placeholder = 'Enter follow-up and press Enter…';
    bar.appendChild(input);
    input.focus();

    input.onkeydown = (e) => {
        if (e.key === 'Enter' && input.value.trim()) {
            createBranch(turn, turnIdx, 'custom', input.value.trim());
            input.remove();
        }
        if (e.key === 'Escape') input.remove();
    };
    input.onblur = () => setTimeout(() => input.remove(), 200);
}

function createBranch(turn, turnIdx, branchType, customText) {
    const convId = getConvId();
    if (!convId) return;

    chrome.runtime.sendMessage({
        type:         'CREATE_BRANCH',
        convId,
        turnIndex:    turnIdx,
        messageId:    turn.msgId || null,
        branchType,
        customText:   customText || '',
        questionText: turn.questionText || '',
        answerText:   turn.answerText   || '',
    }, () => {
        // Refresh branch children after a short delay (storage write needs to settle)
        setTimeout(loadBranchState, 500);
    });
}

// ── Boot ──────────────────────────────────────────────────────────────────────
schedule();
loadBranchState();

// Poll until #history has conversation links (React may render them after document_idle)
(function pollSidebar() {
    if (document.querySelector('#history a[href*="/c/"]')) {
        injectSidebarDates();
    } else {
        setTimeout(pollSidebar, 250);
    }
})();
