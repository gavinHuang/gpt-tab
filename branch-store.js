'use strict';

// ── Branch Store ──────────────────────────────────────────────────────────────
// Loaded into background.js via importScripts().
// All functions are async and talk directly to chrome.storage.local.

const BRANCH_PREFIXES = {
    deeper:    "Let's go deeper on this. Elaborate on the key mechanisms and nuances:",
    challenge: "I want to challenge this answer. What are the strongest counterarguments or limitations?",
    example:   "Give me a concrete real-world example that illustrates this:",
    custom:    '',
};

const BRANCH_LABELS = {
    deeper:    '🔍 Go deeper',
    challenge: '⚔ Challenge',
    example:   '💡 Example',
    custom:    '+ Custom',
};

function buildBranchPrompt({ questionText, answerText, branchType, customText }) {
    const ans    = (answerText || '').slice(0, 500);
    const suffix = (answerText || '').length > 500 ? '...' : '';
    const lines  = [
        '[Context from parent conversation]',
        '',
        `Q: ${questionText || '(unknown)'}`,
        `A: ${ans}${suffix}`,
        '',
    ];
    if (branchType === 'custom') {
        lines.push(customText || '');
    } else {
        lines.push(`[Branch direction: ${branchType}]`, '', BRANCH_PREFIXES[branchType]);
    }
    return lines.join('\n');
}

// ── Storage helpers ───────────────────────────────────────────────────────────

function bgLoad() {
    return new Promise(resolve =>
        chrome.storage.local.get(['branchTree', 'convIdIndex', 'parentConvIdIndex'], data => resolve({
            tree:        data.branchTree        || { version: 1, trees: {} },
            index:       data.convIdIndex        || {},
            parentIndex: data.parentConvIdIndex  || {},
        }))
    );
}

function bgSave(tree, index, parentIndex) {
    return new Promise(resolve =>
        chrome.storage.local.set({ branchTree: tree, convIdIndex: index, parentConvIdIndex: parentIndex }, resolve)
    );
}

async function bgCreateNode({ parentConvId, turnIndex, messageId, branchType, label, questionText }) {
    const { tree, index, parentIndex } = await bgLoad();

    let treeId, parentNodeId;
    const parentEntry = index[parentConvId];

    if (parentEntry) {
        // Parent conv is itself a branch — attach to its node
        treeId       = parentEntry.treeId;
        parentNodeId = parentEntry.nodeId;
    } else if (parentIndex[parentConvId]?.length > 0) {
        // We already have a tree for this parent conv (multiple branches from same conv)
        treeId       = parentIndex[parentConvId][0].treeId;
        parentNodeId = tree.trees[treeId].rootNodeId;
    } else {
        // First branch off this conversation — create a new tree with a root node
        treeId       = crypto.randomUUID();
        parentNodeId = crypto.randomUUID();
        const rootNode = {
            id: parentNodeId, parentId: null, children: [],
            convId: parentConvId, turnIndex: 0,
            label: (questionText || 'Branch tree').slice(0, 60),
            branchType: 'root', createdAt: Date.now(), messageId: null, questionText: null,
        };
        tree.trees[treeId] = {
            id: treeId, createdAt: Date.now(),
            label: rootNode.label,
            rootNodeId: parentNodeId,
            nodes: { [parentNodeId]: rootNode },
        };
        // The parent conv is not itself a branch — don't add it to convIdIndex
    }

    const nodeId = crypto.randomUUID();
    const node = {
        id: nodeId, parentId: parentNodeId, children: [],
        convId: null,   // filled in when the new tab navigates to /c/<uuid>
        turnIndex, label, branchType,
        createdAt: Date.now(), messageId: messageId || null,
        questionText: (questionText || '').slice(0, 100),
    };

    tree.trees[treeId].nodes[nodeId] = node;
    tree.trees[treeId].nodes[parentNodeId].children.push(nodeId);

    if (!parentIndex[parentConvId]) parentIndex[parentConvId] = [];
    parentIndex[parentConvId].push({ nodeId, treeId, turnIndex });

    await bgSave(tree, index, parentIndex);
    return { nodeId, treeId };
}

async function bgUpdateNodeConvId(treeId, nodeId, newConvId) {
    const { tree, index, parentIndex } = await bgLoad();
    const node = tree.trees[treeId]?.nodes[nodeId];
    if (node) {
        node.convId    = newConvId;
        index[newConvId] = { treeId, nodeId };
    }
    await bgSave(tree, index, parentIndex);
}

async function bgCheckBranch(convId) {
    const { tree, index } = await bgLoad();
    const entry   = index[convId];
    if (!entry) return { isBranch: false };
    const treeObj = tree.trees[entry.treeId];
    if (!treeObj) return { isBranch: false };
    const node    = treeObj.nodes[entry.nodeId];
    if (!node)    return { isBranch: false };
    const parentNode = node.parentId ? treeObj.nodes[node.parentId] : null;
    const siblings   = parentNode
        ? parentNode.children.map(id => treeObj.nodes[id]).filter(Boolean)
        : [];
    return { isBranch: true, node, parentNode, siblings, treeId: entry.treeId, nodeId: entry.nodeId };
}

async function bgGetBranchChildren(convId) {
    const { tree, parentIndex } = await bgLoad();
    const entries = parentIndex[convId] || [];
    const result  = {};   // turnIndex → [node + treeId]
    for (const e of entries) {
        const node = tree.trees[e.treeId]?.nodes[e.nodeId];
        if (!node) continue;
        if (!result[e.turnIndex]) result[e.turnIndex] = [];
        result[e.turnIndex].push({ ...node, treeId: e.treeId });
    }
    return result;
}
