/**
 * init.js — 应用入口模块
 *
 * 负责初始化调用、全局事件绑定、数据修复逻辑。
 * 所有模块在此汇聚，由 index.html 作为 ES Module 入口加载。
 */

import { state } from './state.js';
import { trackEvent } from './utils.js';
import { initializeData, repairData, flushPendingSaveImmediately, onPersistError } from './storage.js';
import { register } from './core.js';
import { renderChat, cancelEdit, checkScrollButton, scrollToBottom, rebindChatButtons, updateInputCounter, clearPendingTextAttachment, updateComposerPrimaryButtonState, closeComposerActionMenu } from './chat.js';
import { renderTabs, invalidateTabCache } from './tabs.js';
import {
  closeSettingsPanel, closeRenameTabPanel, closeConfirmModal, closeDownloadPanel,
  showToast, applyFontSize, updateFontSizeButtons, openSidebar, closeSidebar
} from './panels.js';
import { bindSettingsEvents, applyDeepThinkState, forceToggleDeepThinkFromUI, syncDeepThinkFromInput } from './settings.js';
import { bindTabEvents } from './tabs.js';
import { bindChatEvents } from './chat.js';
import { bindGroupChatEvents, closeCreateGroupPanel, openCreateGroupPanel, closeBgInfoPanel, updateBgInfoChip } from './groupchat.js';
import { bindCharacterEvents, closeCharacterPanel, openCharacterPanel, getCharacterColor, getCharacterById, createCharacterChatTab, openCharacterSelectPanel } from './character.js';
import { bindPromptEvents, closeOptimizePreviewPanel, closePromptPanel } from './prompts.js';
import { bindMarketEvents, closePromptMarketPanel, closeAiGeneratePanel } from './market.js';
import { bindSearchEvents, clearSearch } from './search.js';
import { migrateLegacySummariesOnInit, migrateLegacySummaryForTab } from './summary.js';
import { bindStoryArchiveEvents, closeStoryArchivePanel, openStoryArchivePanel, markStoryArchiveStale } from './archive.js';
import { bindFavoritesEvents, closeFavoritePreviewPanel, closeFavoritesPanel, openFavoritesPanel, renderFavoritesPanel } from './favorites.js';
import { bindHtmlModeEvents } from './htmlmode.js';

// ========== 注册跨模块函数到 core ==========

register('renderChat', renderChat);
register('rebindChatButtons', rebindChatButtons);
register('updateInputCounter', updateInputCounter);
register('clearPendingTextAttachment', clearPendingTextAttachment);
register('updateComposerPrimaryButtonState', updateComposerPrimaryButtonState);
register('closeComposerActionMenu', closeComposerActionMenu);
register('renderTabs', renderTabs);
register('invalidateTabCache', invalidateTabCache);
register('getCharacterColor', getCharacterColor);
register('getCharacterById', getCharacterById);
register('createCharacterChatTab', createCharacterChatTab);
register('openCharacterSelectPanel', openCharacterSelectPanel);
register('openCharacterPanel', openCharacterPanel);
register('openCreateGroupPanel', openCreateGroupPanel);
register('updateBgInfoChip', updateBgInfoChip);
register('runLegacySummaryMigration', runLegacySummaryMigration);
register('runLegacySummaryMigrationForTab', runLegacySummaryMigrationForTab);
register('openStoryArchivePanel', openStoryArchivePanel);
register('markStoryArchiveStale', markStoryArchiveStale);
register('openFavoritesPanel', openFavoritesPanel);
register('renderFavoritesPanel', renderFavoritesPanel);

// 将深度思考函数挂载到 window，供 HTML inline handler 调用
window.applyDeepThinkState = function(nextChecked) {
  applyDeepThinkState(nextChecked, 'inline-global');
  return false;
};
window.forceToggleDeepThinkFromUI = function(event) {
  forceToggleDeepThinkFromUI(event);
};
window.syncDeepThinkFromInput = function(checked) {
  syncDeepThinkFromInput(checked);
  return false;
};

// ========== 初始化 ==========

function runLegacySummaryMigration() {
  return migrateLegacySummariesOnInit().then(({ migratedTabIds = [], skipped = false }) => {
    if (skipped || migratedTabIds.length === 0) return { migratedTabIds, skipped };
    flushPendingSaveImmediately();
    if (migratedTabIds.includes(state.tabData.active)) {
      renderChat();
    }
    return { migratedTabIds, skipped };
  }).catch(e => {
    console.warn('旧摘要初始化迁移失败:', e.message);
    return { migratedTabIds: [], skipped: false, error: e };
  });
}

function runLegacySummaryMigrationForTab(tabId) {
  return migrateLegacySummaryForTab(tabId).then(({ migrated = false, skipped = false }) => {
    if (skipped || !migrated) return { migrated, skipped };
    flushPendingSaveImmediately();
    if (tabId === state.tabData.active) {
      renderChat();
    }
    return { migrated, skipped };
  }).catch(e => {
    console.warn(`旧摘要按会话迁移失败，tab=${tabId}:`, e.message);
    return { migrated: false, skipped: false, error: e };
  });
}

function init() {
  try {
    // 事件埋点
    trackEvent('访问页面');

    // 数据初始化与修复
    initializeData();

    // 监听存储持久化错误（配额满等），给用户可见化提示，避免静默吞错导致以为消息已保存
    let _lastQuotaToastAt = 0;
    let _lastGenericToastAt = 0;
    onPersistError(({ type, isQuota }) => {
      const now = Date.now();
      if (isQuota) {
        if (now - _lastQuotaToastAt > 3000) {
          _lastQuotaToastAt = now;
          showToast('本地存储已满，数据未能保存！请尽快导出重要对话后清理过期会话');
        }
      } else {
        // CR-4: 非配额错误也做 3 秒节流，防止频繁 saveTabs 失败时 Toast 叠加
        if (now - _lastGenericToastAt > 3000) {
          _lastGenericToastAt = now;
          showToast(`保存失败（${type}），请稍后重试或刷新页面`);
        }
      }
    });

    // 检查 API Key
    const keyPanel = document.getElementById("keyPanel");
    const apiKeyInput = document.getElementById("apiKeyInput");
    if (!state.apiKey) {
      keyPanel.classList.remove("hidden");
    } else {
      apiKeyInput.value = state.apiKey;
    }

    // 日间模式初始化
    const settingsDayModeToggle = document.getElementById('settingsDayModeToggle');
    const savedDayMode = localStorage.getItem("dsDayMode") === "true";
    if (settingsDayModeToggle) {
      settingsDayModeToggle.checked = savedDayMode;
    }
    if (savedDayMode) {
      document.body.classList.add("day-mode");
    }

    // Token 预估显示初始化
    const settingsTokenEstimateToggle = document.getElementById('settingsTokenEstimateToggle');
    const showTokenEstimate = localStorage.getItem("dsShowTokenEstimate") !== "false";
    if (settingsTokenEstimateToggle) {
      settingsTokenEstimateToggle.checked = showTokenEstimate;
    }
    if (!showTokenEstimate) {
      document.body.classList.add("hide-token-estimate");
    }

    // 字号初始化
    const savedFontSize = localStorage.getItem("dsFontSize") || "default";
    applyFontSize(savedFontSize);
    if (document.querySelector('.font-size-option')) {
      updateFontSizeButtons(savedFontSize);
    }

    // 绑定所有事件
    bindSettingsEvents();
    bindTabEvents();
    bindChatEvents();
    bindGroupChatEvents();
    bindCharacterEvents();
    bindPromptEvents();
    bindMarketEvents();
    bindSearchEvents();
    bindStoryArchiveEvents();
    bindFavoritesEvents();
    bindHtmlModeEvents();

    // 全局事件：visibilitychange
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        state.lastPageHiddenAt = Date.now();
        // 后台切出：中止所有正在进行的 tab 发送（每个 tab 有独立的 abortController）
        let aborted = false;
        const map = state.sendingByTab || {};
        for (const tabId in map) {
          const entry = map[tabId];
          if (entry && entry.isSending && entry.abortController) {
            entry.abortReason = 'background';
            try { entry.abortController.abort(); } catch (_) {}
            aborted = true;
          }
        }
        if (aborted) state.shouldToastOnVisible = true;
        return;
      }

      if (state.shouldToastOnVisible) {
        state.shouldToastOnVisible = false;
        showToast('已从后台返回：刚才的生成已中断，可点击"重新生成"继续');
      }
    });

    // 全局事件：触摸手势
    let touchStartX = 0;
    let touchEndX = 0;

    document.addEventListener('touchstart', e => {
      touchStartX = e.changedTouches[0].screenX;
    }, { passive: true });

    document.addEventListener('touchend', e => {
      touchEndX = e.changedTouches[0].screenX;
      const swipeDist = touchEndX - touchStartX;
      if (swipeDist > 50 && touchStartX < 30 && !state.isSidebarOpen) {
        openSidebar();
      }
      if (swipeDist < -50 && state.isSidebarOpen) {
        closeSidebar();
      }
    }, { passive: true });

    // 全局事件：ESC 键关闭面板（统一处理）
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') {
        // 优先检查搜索面板是否打开
        const searchBox = document.getElementById('searchBox');
        if (searchBox && !searchBox.classList.contains('hidden')) {
          clearSearch();
          return;
        }

        const settingsPanel = document.getElementById('settingsPanel');
        const editPanel = document.getElementById('editPanel');
        const renameTabPanel = document.getElementById('renameTabPanel');
        const confirmPanel = document.getElementById('confirmPanel');
        const promptOptimizePreviewPanel = document.getElementById('promptOptimizePreviewPanel');
        const promptPanel = document.getElementById('promptPanel');
        const characterPanel = document.getElementById('characterPanel');
        const createGroupPanel = document.getElementById('createGroupPanel');
        const bgInfoPanel = document.getElementById('bgInfoPanel');
        const characterSelectPanel = document.getElementById('characterSelectPanel');
        const infoPanel = document.getElementById('infoPanel');
        const donatePanel = document.getElementById('donatePanel');
        const downloadPanel = document.getElementById('downloadPanel');
        const promptMarketPanel = document.getElementById('promptMarketPanel');
        const aiGeneratePromptPanel = document.getElementById('aiGeneratePromptPanel');
        const storyArchivePanel = document.getElementById('storyArchivePanel');
        const favoritesPanel = document.getElementById('favoritesPanel');
        const favoritePreviewPanel = document.getElementById('favoritePreviewPanel');

        if (favoritePreviewPanel && !favoritePreviewPanel.classList.contains('hidden')) {
          closeFavoritePreviewPanel();
          return;
        }

        if (settingsPanel && !settingsPanel.classList.contains('hidden')) closeSettingsPanel();
        if (editPanel && !editPanel.classList.contains('hidden')) cancelEdit();
        if (renameTabPanel && !renameTabPanel.classList.contains('hidden')) closeRenameTabPanel();
        if (confirmPanel && !confirmPanel.classList.contains('hidden')) closeConfirmModal(false);
        if (promptOptimizePreviewPanel && !promptOptimizePreviewPanel.classList.contains('hidden')) closeOptimizePreviewPanel();
        if (promptPanel && !promptPanel.classList.contains('hidden')) closePromptPanel();
        if (characterPanel && !characterPanel.classList.contains('hidden')) closeCharacterPanel();
        if (createGroupPanel && !createGroupPanel.classList.contains('hidden')) closeCreateGroupPanel();
        if (bgInfoPanel && !bgInfoPanel.classList.contains('hidden')) closeBgInfoPanel();
        if (characterSelectPanel && !characterSelectPanel.classList.contains('hidden')) characterSelectPanel.classList.add('hidden');
        if (infoPanel && !infoPanel.classList.contains('hidden')) infoPanel.classList.add('hidden');
        if (donatePanel && !donatePanel.classList.contains('hidden')) donatePanel.classList.add('hidden');
        if (downloadPanel && !downloadPanel.classList.contains('hidden')) closeDownloadPanel();
        if (promptMarketPanel && !promptMarketPanel.classList.contains('hidden')) closePromptMarketPanel();
        if (aiGeneratePromptPanel && !aiGeneratePromptPanel.classList.contains('hidden')) closeAiGeneratePanel();
        if (storyArchivePanel && !storyArchivePanel.classList.contains('hidden')) closeStoryArchivePanel();
        if (favoritesPanel && !favoritesPanel.classList.contains('hidden')) closeFavoritesPanel();
      }
    });

    // 页面关闭时立即保存未保存的数据
    window.addEventListener('beforeunload', flushPendingSaveImmediately);

    // 初始渲染
    renderTabs();
    renderChat();
    setTimeout(() => { checkScrollButton(); scrollToBottom(); }, 100);
    updateBgInfoChip();
    const input = document.getElementById("input");
    if (input) input.focus();

    // 启动后后台扫描旧摘要，并按滑动窗口规则做一次性迁移。
    runLegacySummaryMigration();

  } catch (e) {
    console.error('MyDeepSeek 初始化失败:', e);
    try {
      repairData();
    } catch (repairErr) {
      console.error('数据修复失败，执行重置:', repairErr);
      localStorage.removeItem("dsTabs");
      location.reload();
    }
  }
}

// 启动应用
init();
