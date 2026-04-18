/**
 * panels.js — UI 面板管理模块
 *
 * 管理 Toast、侧边栏、设置面板、重命名面板、确认弹窗、导出面板、
 * 字号设置、回复引用条、空对话提示等 UI 面板。
 */

import { state } from './state.js';
import { saveTabs, getTabDisplayName } from './storage.js';

// ========== Toast 提示 ==========

export function showToast(text) {
  const toast = document.createElement('div');
  toast.textContent = text;
  toast.style.position = 'fixed';
  toast.style.left = '50%';
  toast.style.bottom = '110px';
  toast.style.transform = 'translateX(-50%)';

  const isDayMode = document.body.classList.contains('day-mode');
  if (isDayMode) {
    toast.style.background = 'rgba(255,255,255,.95)';
    toast.style.color = '#111827';
    toast.style.border = '1px solid #e5e7eb';
    toast.style.boxShadow = '0 10px 30px rgba(0,0,0,.1)';
  } else {
    toast.style.background = 'rgba(17,24,39,.95)';
    toast.style.color = '#fff';
    toast.style.border = '1px solid #374151';
    toast.style.boxShadow = '0 10px 30px rgba(0,0,0,.35)';
  }

  toast.style.padding = '10px 14px';
  toast.style.borderRadius = '10px';
  toast.style.fontSize = '13px';
  toast.style.zIndex = '120';
  toast.style.opacity = '0';
  toast.style.transition = 'all .25s ease';
  document.body.appendChild(toast);
  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.bottom = '120px';
  });
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.bottom = '110px';
    setTimeout(() => toast.remove(), 250);
  }, 1800);
}

// ========== 侧边栏 ==========

export function openSidebar() {
  state.isSidebarOpen = true;
  const sidebar = document.getElementById("sidebar");
  const sidebarOverlay = document.getElementById("sidebarOverlay");
  sidebar.classList.remove("-translate-x-full");
  sidebarOverlay.classList.remove("opacity-0", "pointer-events-none");
  sidebarOverlay.classList.add("opacity-100", "pointer-events-auto");
}

export function closeSidebar() {
  state.isSidebarOpen = false;
  const sidebar = document.getElementById("sidebar");
  const sidebarOverlay = document.getElementById("sidebarOverlay");
  sidebar.classList.add("-translate-x-full");
  sidebarOverlay.classList.remove("opacity-100", "pointer-events-auto");
  sidebarOverlay.classList.add("opacity-0", "pointer-events-none");
}

// ========== 设置面板 ==========

export function openSettingsPanel() {
  const settingsApiKeyInput = document.getElementById('settingsApiKeyInput');
  const settingsDayModeToggle = document.getElementById('settingsDayModeToggle');
  const settingsPanel = document.getElementById('settingsPanel');

  if (settingsApiKeyInput) {
    settingsApiKeyInput.value = state.apiKey || "";
  }
  const currentFontSize = localStorage.getItem("dsFontSize") || "default";
  const currentDayMode = localStorage.getItem("dsDayMode") === "true";
  if (settingsDayModeToggle) {
    settingsDayModeToggle.checked = currentDayMode;
  }
  updateFontSizeButtons(currentFontSize);

  if (settingsPanel) {
    settingsPanel.classList.remove("hidden");
  }
  closeSidebar();
}

export function closeSettingsPanel() {
  const settingsPanel = document.getElementById('settingsPanel');
  if (settingsPanel) {
    settingsPanel.classList.add("hidden");
  }
}

// ========== 重命名面板 ==========

export function openRenameTabPanel(tabId) {
  state.renamingTabId = tabId;
  const renameTabInput = document.getElementById('renameTabInput');
  const renameTabPanel = document.getElementById('renameTabPanel');
  renameTabInput.value = state.tabData.list[tabId]?.title || '';
  renameTabPanel.classList.remove('hidden');
  setTimeout(() => {
    renameTabInput.focus();
    renameTabInput.select();
  }, 30);
}

export function closeRenameTabPanel() {
  state.renamingTabId = null;
  const renameTabInput = document.getElementById('renameTabInput');
  const renameTabPanel = document.getElementById('renameTabPanel');
  renameTabPanel.classList.add('hidden');
  renameTabInput.value = '';
}

export function saveRenamedTab() {
  if (!state.renamingTabId || !state.tabData.list[state.renamingTabId]) return;
  const renameTabInput = document.getElementById('renameTabInput');
  const finalName = renameTabInput.value.trim();
  state.tabData.list[state.renamingTabId].title = finalName;
  saveTabs();
  closeRenameTabPanel();
  showToast(finalName ? '会话名称已更新' : '已恢复默认会话名称');
}

// ========== 确认弹窗 ==========

export function showConfirmModal({ title = '确认操作', desc = '确定继续吗？', okText = '确认', cancelText = '取消' } = {}) {
  const confirmTitle = document.getElementById('confirmTitle');
  const confirmDesc = document.getElementById('confirmDesc');
  const confirmOkBtn = document.getElementById('confirmOkBtn');
  const confirmCancelBtn = document.getElementById('confirmCancelBtn');
  const confirmPanel = document.getElementById('confirmPanel');

  confirmTitle.textContent = title;
  confirmDesc.textContent = desc;
  confirmOkBtn.textContent = okText;
  confirmCancelBtn.textContent = cancelText;
  confirmPanel.classList.remove('hidden');

  return new Promise(resolve => {
    state.confirmResolve = resolve;
  });
}

export function closeConfirmModal(result) {
  const confirmPanel = document.getElementById('confirmPanel');
  confirmPanel.classList.add('hidden');
  if (state.confirmResolve) {
    state.confirmResolve(result);
    state.confirmResolve = null;
  }
}

// ========== 导出面板 ==========

export function openDownloadPanel(tabId) {
  const msgs = state.tabData.list[tabId].messages || [];
  if (msgs.length === 0) {
    alert("当前对话为空，无法导出。");
    return;
  }
  state.pendingDownloadTabId = tabId;
  const includeReasoningToggle = document.getElementById('includeReasoningToggle');
  if (includeReasoningToggle) includeReasoningToggle.checked = true;
  const downloadPanel = document.getElementById('downloadPanel');
  downloadPanel.classList.remove("hidden");
}

export function closeDownloadPanel() {
  const downloadPanel = document.getElementById('downloadPanel');
  downloadPanel.classList.add('hidden');
  state.pendingDownloadTabId = null;
}

// ========== 空对话提示 ==========

export function showEmptyChatHint() {
  const emptyChatHint = document.getElementById('emptyChatHint');
  const emptyChatHintCharName = document.getElementById('emptyChatHintCharName');
  const currentTab = state.tabData.list[state.tabData.active];
  if (currentTab && currentTab.type === 'single-character' && currentTab.characterId) {
    const char = state.characterData.find(c => c.id === currentTab.characterId);
    if (char && emptyChatHintCharName) {
      emptyChatHintCharName.textContent = char.name;
    }
  } else if (emptyChatHintCharName) {
    emptyChatHintCharName.textContent = 'DS老师';
  }

  // 只在普通对话中显示空对话提示，群聊和角色对话不显示
  if (emptyChatHint) {
    if (currentTab && !currentTab.type) {
      emptyChatHint.classList.remove('hidden');
    } else {
      emptyChatHint.classList.add('hidden');
    }
  }
}

export function hideEmptyChatHint() {
  const emptyChatHint = document.getElementById('emptyChatHint');
  if (emptyChatHint) emptyChatHint.classList.add('hidden');
}

// ========== 字号设置 ==========

export function applyFontSize(size) {
  document.body.classList.remove("font-size-small", "font-size-smaller", "font-size-default", "font-size-larger", "font-size-large");
  document.body.classList.add(`font-size-${size}`);
}

export function updateFontSizeButtons(activeSize) {
  document.querySelectorAll('.font-size-option').forEach(btn => {
    const btnSize = btn.getAttribute('data-size');
    if (btnSize === activeSize) {
      btn.classList.add('active');
      btn.classList.add('bg-blue-600', 'border-blue-500', 'text-white');
      btn.classList.remove('border-gray-700', 'text-gray-400');
    } else {
      btn.classList.remove('active');
      btn.classList.remove('bg-blue-600', 'border-blue-500', 'text-white');
      btn.classList.add('border-gray-700', 'text-gray-400');
    }
  });
}

// ========== 回复引用条 ==========

export function showReplyBar(charId, charName, snippet) {
  state.replyTarget = { characterId: charId, characterName: charName, snippet: snippet };
  const bar = document.getElementById('replyBar');
  document.getElementById('replyBarCharName').textContent = charName;
  document.getElementById('replyBarSnippet').textContent = snippet.length > 40 ? snippet.slice(0, 40) + '...' : snippet;
  bar.classList.remove('hidden');
}

export function hideReplyBar() {
  state.replyTarget = null;
  const bar = document.getElementById('replyBar');
  if (bar) bar.classList.add('hidden');
}
