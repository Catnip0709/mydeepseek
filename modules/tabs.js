/**
 * tabs.js — Tab 标签页管理模块
 *
 * 负责 Tab 的渲染、创建、切换、缓存和删除。
 */

import { state, abortTabSending, clearTabSending } from './state.js';
import { escapeHtml, editIconSvg, downloadIconSvg } from './utils.js';
import { saveTabs, generateNewTabId, getTabDisplayName } from './storage.js';
import { showToast, openRenameTabPanel, openDownloadPanel, closeSidebar, showEmptyChatHint, hideEmptyChatHint } from './panels.js';
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
        <span class="tab-btn tab-export" data-id="${id}" title="导出对话">${downloadIconSvg}</span>
        <span class="tab-btn tab-del" data-id="${id}" title="删除对话">×</span>
      </div>
    `;
    tabDiv.addEventListener("click", (e) => {
      if (e.target.closest('.tab-del') || e.target.closest('.tab-export') || e.target.closest('.tab-rename')) return;
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
