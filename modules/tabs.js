/**
 * tabs.js — Tab 标签页管理模块
 *
 * 负责 Tab 的渲染、创建、切换、缓存和删除。
 */

import { state, abortTabSending, clearTabSending, isTabSending } from './state.js';
import { escapeHtml, editIconSvg, downloadIconSvg, cleanupIconSvg, formatBytes } from './utils.js';
import { saveTabs, generateNewTabId, getTabDisplayName, updateStorageUsage, flushPendingSaveImmediately } from './storage.js';
import { showToast, openRenameTabPanel, openDownloadPanel, closeSidebar, showEmptyChatHint, hideEmptyChatHint, showConfirmModal, openCleanupChoicePanel } from './panels.js';
import { removeFavoritesForTab } from './favorites.js';
import { call as coreCall } from './core.js';

// ========== Tab DOM 缓存 ==========

export function getCachedTabHtml(tabId) {
  return state._tabDomCache[tabId] || null;
}

export function setCachedTabHtml(tabId, html) {
  state._tabDomCache[tabId] = html;
}

export function invalidateTabCache(tabId) {
  if (tabId) {
    delete state._tabDomCache[tabId];
  } else {
    state._tabDomCache = {};
  }
}

// ========== 创建新 Tab ==========

export function createNewTab() {
  coreCall('clearPendingTextAttachment');
  const newId = generateNewTabId();
  state.tabData.list[newId] = { messages: [], title: "", storyArchive: null };
  state.tabData.active = newId;
  saveTabs();
  // renderChat, renderTabs, updateInputCounter 由调用方处理
  showEmptyChatHint();
  return newId;
}

// ========== 渲染 Tab 列表 ==========

export function renderTabs() {
  const tabsEl = document.getElementById("tabs");
  const chat = document.getElementById("chat");
  const input = document.getElementById("input");
  tabsEl.innerHTML = "";
  const tabIds = Object.keys(state.tabData.list);
  if (tabIds.length === 0) {
    state.tabData.list = { tab1: { messages: [], title: "", storyArchive: null } };
    state.tabData.active = "tab1";
    saveTabs();
  }

  Object.keys(state.tabData.list).forEach(id => {
    const tab = state.tabData.list[id];
    const isGroup = tab.type === 'group';
    const isSingleChar = tab.type === 'single-character';
    const tabDiv = document.createElement("div");
    tabDiv.className = `tab ${id === state.tabData.active ? "active" : ""} ${isGroup ? "group-tab" : ""} ${isSingleChar ? "char-tab" : ""}`;
    tabDiv.innerHTML = `
      <span class="tab-title" title="${escapeHtml(getTabDisplayName(id))}">${escapeHtml(getTabDisplayName(id))}</span>
      <div class="tab-actions">
        <span class="tab-btn tab-rename" data-id="${id}" title="修改会话名称">${editIconSvg}</span>
        <span class="tab-btn tab-cleanup" data-id="${id}" title="释放空间">${cleanupIconSvg}</span>
        <span class="tab-btn tab-export" data-id="${id}" title="导出对话">${downloadIconSvg}</span>
        <span class="tab-btn tab-del" data-id="${id}" title="删除对话">×</span>
      </div>
    `;
    tabDiv.addEventListener("click", (e) => {
      if (e.target.closest('.tab-del') || e.target.closest('.tab-export') || e.target.closest('.tab-rename') || e.target.closest('.tab-cleanup')) return;
      // 缓存当前 tab 的 DOM
      setCachedTabHtml(state.tabData.active, chat.innerHTML);
      coreCall('clearPendingTextAttachment');
      state.tabData.active = id;
      saveTabs();
      // 尝试使用缓存
      const cached = getCachedTabHtml(id);
      if (cached) {
        chat.innerHTML = cached;
        coreCall('rebindChatButtons');
      } else {
        coreCall('renderChat');
      }
      // 根据目标 tab 的消息状态正确控制空对话提示
      const targetTab = state.tabData.list[id];
      const targetMsgs = targetTab.messages || [];
      if (targetMsgs.length === 0 && !targetTab.type) {
        showEmptyChatHint();
      } else {
        hideEmptyChatHint();
      }
      renderTabs();
      coreCall('updateInputCounter');
      coreCall('updateBgInfoChip');
      // 同步发送按钮状态：切换到的 tab 若仍在发送中，按钮应显示"停止"
      coreCall('updateComposerPrimaryButtonState');
      coreCall('runLegacySummaryMigrationForTab', id);
      if (window.innerWidth < 768) closeSidebar();
    });
    tabsEl.appendChild(tabDiv);
  });

  // 重命名按钮
  document.querySelectorAll(".tab-rename").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const tabId = btn.dataset.id;
      openRenameTabPanel(tabId);
    });
  });

  // 导出按钮
  document.querySelectorAll(".tab-export").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const exportId = btn.dataset.id;
      openDownloadPanel(exportId);
    });
  });

  // 释放空间按钮
  document.querySelectorAll(".tab-cleanup").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const cleanupId = btn.dataset.id;
      handleCleanupTab(cleanupId);
    });
  });

  // 删除按钮
  document.querySelectorAll(".tab-del").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const delId = btn.dataset.id;
      if (confirm(`确定删除「${getTabDisplayName(delId)}」吗？删除后记录将永久消失！`)) {
        // 若该 tab 仍有正在进行的发送/附件摘要，clearTabSending 会先 abort 再重置（CR-7）；
        // 这里显式设置 abortReason 以便 catch 分支能正确识别为"手动中断"。
        abortTabSending(delId, 'manual');
        clearTabSending(delId);
        removeFavoritesForTab(delId, { silent: true });

        delete state.tabData.list[delId];

        const remainingTabIds = Object.keys(state.tabData.list);
        if (remainingTabIds.length === 0) {
          const newId = createNewTab();
          state.tabData.active = newId;
          return;
        }

        if (delId === state.tabData.active) {
          coreCall('clearPendingTextAttachment');
          state.tabData.active = remainingTabIds[0];
        }
        saveTabs();
        coreCall('renderChat');
        renderTabs();
        coreCall('updateInputCounter');
      }
    });
  });
}

// ========== 释放空间 ==========

// 扫描某个 tab：统计可释放的旧版本数量与字节数；不修改数据。
function scanCleanupTabHistoryVersions(tabId) {
  const tab = state.tabData.list[tabId];
  if (!tab || !Array.isArray(tab.messages)) return { released: 0, bytesSaved: 0 };
  let released = 0;
  let bytesSaved = 0;
  tab.messages.forEach(msg => {
    if (!msg || msg.role !== 'assistant') return;
    if (!Array.isArray(msg.history) || msg.history.length <= 1) return;
    const idx = Number.isInteger(msg.historyIndex) ? msg.historyIndex : 0;
    msg.history.forEach((v, i) => {
      if (i === idx) return;
      const c = (v && v.content) || '';
      const r = (v && v.reasoningContent) || '';
      bytesSaved += (c.length + r.length) * 2; // UTF-16
      released += 1;
    });
  });
  return { released, bytesSaved };
}

// 实际执行清理：保留每条 assistant 消息当前选中的版本，丢弃其它版本。
function applyCleanupTabHistoryVersions(tabId) {
  const tab = state.tabData.list[tabId];
  if (!tab || !Array.isArray(tab.messages)) return { released: 0, bytesSaved: 0 };
  let released = 0;
  let bytesSaved = 0;
  tab.messages.forEach(msg => {
    if (!msg || msg.role !== 'assistant') return;
    if (!Array.isArray(msg.history) || msg.history.length <= 1) return;
    const idx = Number.isInteger(msg.historyIndex) ? msg.historyIndex : 0;
    const safeIdx = Math.min(Math.max(idx, 0), msg.history.length - 1);
    const keep = msg.history[safeIdx] || {
      content: msg.content,
      reasoningContent: msg.reasoningContent || '',
      state: msg.generationState || 'complete'
    };
    msg.history.forEach((v, i) => {
      if (i === safeIdx) return;
      const c = (v && v.content) || '';
      const r = (v && v.reasoningContent) || '';
      bytesSaved += (c.length + r.length) * 2;
      released += 1;
    });
    msg.history = [{
      content: keep.content || '',
      reasoningContent: keep.reasoningContent || '',
      state: keep.state || 'complete'
    }];
    msg.historyIndex = 0;
    msg.content = keep.content || '';
    msg.reasoningContent = keep.reasoningContent || '';
    msg.generationState = keep.state || 'complete';
  });
  return { released, bytesSaved };
}

// 扫描某个 tab：统计当前选中版本可释放的思考过程字节数；不修改数据。
function scanCleanupTabThinking(tabId) {
  const tab = state.tabData.list[tabId];
  if (!tab || !Array.isArray(tab.messages)) return { released: 0, bytesSaved: 0 };
  let released = 0;
  let bytesSaved = 0;
  tab.messages.forEach(msg => {
    if (!msg || msg.role !== 'assistant') return;
    let reasoning = '';
    if (Array.isArray(msg.history) && msg.history.length > 0) {
      const idx = Number.isInteger(msg.historyIndex) ? msg.historyIndex : 0;
      const safeIdx = Math.min(Math.max(idx, 0), msg.history.length - 1);
      reasoning = (msg.history[safeIdx] && msg.history[safeIdx].reasoningContent) || '';
    } else {
      reasoning = msg.reasoningContent || '';
    }
    if (reasoning) {
      bytesSaved += reasoning.length * 2; // UTF-16
      released += 1;
    }
  });
  return { released, bytesSaved };
}

// 实际执行清理：清空每条 assistant 消息当前选中版本的思考过程（含顶层字段）。
function applyCleanupTabThinking(tabId) {
  const tab = state.tabData.list[tabId];
  if (!tab || !Array.isArray(tab.messages)) return { released: 0, bytesSaved: 0 };
  let released = 0;
  let bytesSaved = 0;
  tab.messages.forEach(msg => {
    if (!msg || msg.role !== 'assistant') return;
    if (Array.isArray(msg.history) && msg.history.length > 0) {
      const idx = Number.isInteger(msg.historyIndex) ? msg.historyIndex : 0;
      const safeIdx = Math.min(Math.max(idx, 0), msg.history.length - 1);
      const cur = msg.history[safeIdx];
      const reasoning = (cur && cur.reasoningContent) || '';
      if (reasoning) {
        bytesSaved += reasoning.length * 2;
        released += 1;
        cur.reasoningContent = '';
      }
      // 顶层字段始终与当前版本保持同步
      msg.reasoningContent = '';
    } else if (msg.reasoningContent) {
      bytesSaved += msg.reasoningContent.length * 2;
      released += 1;
      msg.reasoningContent = '';
    }
  });
  return { released, bytesSaved };
}

// 释放空间入口：弹出类型选择弹窗（历史版本 / 思考内容）。
function handleCleanupTab(tabId) {
  const tab = state.tabData.list[tabId];
  if (!tab) return;

  // 流式中：禁止清理（避免与 history.push({state:'generating'}) 竞态）
  if (isTabSending(tabId)) {
    showToast('该对话正在生成中，请稍后再释放空间');
    return;
  }

  const versions = scanCleanupTabHistoryVersions(tabId);
  const thinking = scanCleanupTabThinking(tabId);
  const name = getTabDisplayName(tabId);

  if (versions.released === 0 && thinking.released === 0) {
    showToast('该对话没有可释放的内容');
    return;
  }

  openCleanupChoicePanel({
    desc: `对话「${name}」`,
    versionsEnabled: versions.released > 0,
    thinkingEnabled: thinking.released > 0,
    versionsInfo: versions.released > 0
      ? `${versions.released} 个旧版本 · 约 ${formatBytes(versions.bytesSaved)}`
      : '无可释放',
    thinkingInfo: thinking.released > 0
      ? `约 ${formatBytes(thinking.bytesSaved)}`
      : '无可释放',
    onVersions: () => confirmAndCleanupVersions(tabId),
    onThinking: () => confirmAndCleanupThinking(tabId)
  });
}

async function confirmAndCleanupVersions(tabId) {
  const tab = state.tabData.list[tabId];
  if (!tab) return;
  if (isTabSending(tabId)) {
    showToast('该对话正在生成中，请稍后再释放空间');
    return;
  }
  const { released, bytesSaved } = scanCleanupTabHistoryVersions(tabId);
  if (released === 0) {
    showToast('该对话没有可释放的历史版本');
    return;
  }
  const name = getTabDisplayName(tabId);
  const ok = await showConfirmModal({
    title: '释放历史版本',
    desc: `对话「${name}」共有 ${released} 个旧版本可释放，预计可节省 约 ${formatBytes(bytesSaved)} 空间。\n` +
      `释放后未选中的版本（正文与思考）将永久删除，无法恢复。是否继续？`,
    okText: '释放',
    cancelText: '取消'
  });
  if (!ok) return;

  // 二次确认期间可能开始了流式生成，apply 前再次校验，避免与 history 竞态
  if (isTabSending(tabId)) {
    showToast('该对话正在生成中，已取消释放');
    return;
  }

  const result = applyCleanupTabHistoryVersions(tabId);
  finalizeCleanup(tabId);
  showToast(`已释放 ${result.released} 个版本，节省 约 ${formatBytes(result.bytesSaved)}`);
}

async function confirmAndCleanupThinking(tabId) {
  const tab = state.tabData.list[tabId];
  if (!tab) return;
  if (isTabSending(tabId)) {
    showToast('该对话正在生成中，请稍后再释放空间');
    return;
  }
  const { released, bytesSaved } = scanCleanupTabThinking(tabId);
  if (released === 0) {
    showToast('该对话没有可释放的思考内容');
    return;
  }
  const name = getTabDisplayName(tabId);
  const ok = await showConfirmModal({
    title: '释放思考内容',
    desc: `对话「${name}」可释放当前回复的思考过程，预计可节省 约 ${formatBytes(bytesSaved)} 空间。\n` +
      `释放后这些回复的思考过程将不再显示，且永久删除、无法恢复（正文保留）。是否继续？`,
    okText: '释放',
    cancelText: '取消'
  });
  if (!ok) return;

  // 二次确认期间可能开始了流式生成，apply 前再次校验，避免与 history 竞态
  if (isTabSending(tabId)) {
    showToast('该对话正在生成中，已取消释放');
    return;
  }

  const result = applyCleanupTabThinking(tabId);
  finalizeCleanup(tabId);
  showToast(`已释放思考内容，节省 约 ${formatBytes(result.bytesSaved)}`);
}

// 清理后的统一收尾：落盘 + 刷新存储用量 + 刷新渲染。
function finalizeCleanup(tabId) {
  saveTabs();
  // 立即落盘：避免防抖窗口内（300ms）用户刷新或关闭页面导致清理结果丢失
  flushPendingSaveImmediately();
  updateStorageUsage();

  // 当前正在查看这个对话：刷新渲染（移除版本切换控件 / 思考折叠块）
  if (state.tabData.active === tabId) {
    invalidateTabCache(tabId);
    coreCall('renderChat');
  } else {
    // 非当前 tab：仅清掉它的缓存，下次切回时会重新渲染
    invalidateTabCache(tabId);
  }
}

// ========== Tab 事件绑定 ==========

export function bindTabEvents() {
  const addTab = document.getElementById("addTab");
  const addTabDropdown = document.getElementById("addTabDropdown");
  const addTabSingle = document.getElementById("addTabSingle");
  const addTabGroup = document.getElementById("addTabGroup");
  const addTabCharacter = document.getElementById("addTabCharacter");
  const input = document.getElementById("input");

  if (addTab) {
    addTab.onclick = (e) => {
      e.stopPropagation();
      addTabDropdown.classList.toggle("hidden");
    };
  }

  if (addTabSingle) {
    addTabSingle.onclick = () => {
      addTabDropdown.classList.add("hidden");
      createNewTab();
      coreCall('renderChat');
      renderTabs();
      coreCall('updateInputCounter');
      closeSidebar();
      if (input) input.focus();
    };
  }

  if (addTabGroup) {
    addTabGroup.onclick = () => {
      addTabDropdown.classList.add("hidden");
      coreCall('openCreateGroupPanel');
    };
  }

  if (addTabCharacter) {
    addTabCharacter.onclick = () => {
      addTabDropdown.classList.add("hidden");
      if (state.characterData.length === 0) {
        showToast('还没有创建任何角色，请先去角色卡管理中创建角色');
        return;
      }
      if (state.characterData.length === 1) {
        coreCall('createCharacterChatTab', state.characterData[0].id);
        return;
      }
      coreCall('openCharacterSelectPanel');
    };
  }

  // 点击页面其他区域关闭下拉菜单
  document.addEventListener("click", () => {
    if (addTabDropdown) addTabDropdown.classList.add("hidden");
  });
}
