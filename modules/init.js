/**
 * init.js — 应用入口模块
 *
 * 负责初始化调用、全局事件绑定、数据修复逻辑。
 * 所有模块在此汇聚，由 index.html 作为 ES Module 入口加载。
 */

import { state, storageRecoveryState, acquirePageLock, refreshPageLock, releasePageLock, readPageLock, isPageLockStale, getPageInstanceId, detectStoragePersistenceRisk, canModifyPersistedData } from './state.js?v=5';
import { trackEvent } from './utils.js?v=5';
import {
  initializeData, repairData, flushPendingSaveImmediately, onPersistError,
  getRecoverySession, getRecoverableStorageInfo, mergeRecoverySession,
  discardRecoverySession, saveRecoverySessionSnapshot
} from './storage.js?v=5';
import { register } from './core.js?v=5';
import { renderChat, cancelEdit, checkScrollButton, scrollToBottom, rebindChatButtons, updateInputCounter, clearPendingTextAttachment, updateComposerPrimaryButtonState, closeComposerActionMenu } from './chat.js?v=5';
import { renderTabs, invalidateTabCache } from './tabs.js?v=5';
import {
  closeSettingsPanel, closeRenameTabPanel, closeConfirmModal, closeDownloadPanel,
  showToast, applyFontSize, updateFontSizeButtons, openSidebar, closeSidebar, closeCleanupChoicePanel,
  showConfirmModal
} from './panels.js?v=5';
import {
  bindSettingsEvents, applyDeepThinkState, forceToggleDeepThinkFromUI,
  syncDeepThinkFromInput, refreshRecoverableStorageInfo
} from './settings.js?v=5';
import { bindTabEvents } from './tabs.js?v=5';
import { bindChatEvents } from './chat.js?v=5';
import { bindGroupChatEvents, closeCreateGroupPanel, openCreateGroupPanel, closeBgInfoPanel, updateBgInfoChip } from './groupchat.js?v=5';
import { bindCharacterEvents, closeCharacterPanel, openCharacterPanel, getCharacterColor, getCharacterById, createCharacterChatTab, openCharacterSelectPanel } from './character.js?v=5';
import { bindPromptEvents, closeOptimizePreviewPanel, closePromptPanel } from './prompts.js?v=5';
import { bindMarketEvents, closePromptMarketPanel, closeAiGeneratePanel } from './market.js?v=5';
import { bindSearchEvents, clearSearch } from './search.js?v=5';
import { migrateLegacySummariesOnInit, migrateLegacySummaryForTab } from './summary.js?v=5';
import { bindStoryArchiveEvents, closeStoryArchivePanel, openStoryArchivePanel, markStoryArchiveStale } from './archive.js?v=5';
import { bindFavoritesEvents, closeFavoritePreviewPanel, closeFavoritesPanel, openFavoritesPanel, renderFavoritesPanel } from './favorites.js?v=5';
import { bindHtmlModeEvents } from './htmlmode.js?v=5';

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
register('refreshRecoverableStorageInfo', refreshRecoverableStorageInfo);

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

function applyPageAccessState() {
  const banner = document.getElementById('multiPageReadonlyBanner');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('sendBtn');
  const addTab = document.getElementById('addTab');
  const readonly = !canModifyPersistedData();
  const readonlyText = storageRecoveryState.dsTabsReadFailed
    ? '本地聊天数据暂不可读取，请刷新后再操作'
    : '当前页面只读，请切换到操作页面';
  if (banner) banner.classList.toggle('hidden', !readonly);
  if (input) {
    input.disabled = readonly;
    input.placeholder = readonly ? readonlyText : '输入消息...';
  }
  if (sendBtn) {
    if (readonly) {
      if (!sendBtn.dataset.origTitle) sendBtn.dataset.origTitle = sendBtn.title;
      sendBtn.title = readonlyText;
    } else {
      sendBtn.title = sendBtn.dataset.origTitle || sendBtn.title;
    }
    sendBtn.disabled = readonly;
  }
  if (addTab) addTab.disabled = readonly;
}

function initializePageLock() {
  // 启动时如果发现现存锁其实已经过期（原页面崩溃/被杀未释放锁），直接强制接管，
  // 避免存量用户被"幽灵锁"卡在只读横幅上。
  const existingLock = readPageLock();
  const shouldForceAcquire = isPageLockStale(existingLock);
  state.isReadOnlyPage = !acquirePageLock(shouldForceAcquire);
  applyPageAccessState();

  const takeoverBtn = document.getElementById('takeoverPageBtn');
  if (takeoverBtn) {
    takeoverBtn.addEventListener('click', () => {
      if (!acquirePageLock(true)) {
        showToast('暂时无法接管，请稍后重试');
        return;
      }
      // 抢锁成功后立即 reload：reload 期间浏览器会停止执行当前脚本，
      // 避免留出"看似可写但内存快照过期"的窗口导致脏写覆盖。
      location.reload();
    });
  }

  window.addEventListener('storage', event => {
    if (event.key !== 'dsActivePageLock') return;
    const lock = readPageLock();
    if (lock?.id && lock.id !== getPageInstanceId()) {
      if (!state.isReadOnlyPage) {
        // 让位前尽力把内存中的修改落到恢复区，保证不丢数据。
        flushPendingSaveImmediately();
        saveRecoverySessionSnapshot();
      }
      state.isReadOnlyPage = true;
      applyPageAccessState();
      return;
    }
    if (!lock && state.isReadOnlyPage && acquirePageLock()) {
      state.isReadOnlyPage = false;
      applyPageAccessState();
      location.reload();
    }
  });

  const heartbeat = window.setInterval(() => {
    if (!state.isReadOnlyPage) {
      if (!refreshPageLock()) {
        // 锁丢失：直接把当前内存数据写入恢复区，避开指纹冲突导致的静默丢失；
        // 下次启动会引导用户合并恢复。
        saveRecoverySessionSnapshot();
        state.isReadOnlyPage = true;
        applyPageAccessState();
        showToast('操作权限已转移到另一个页面，未保存内容已存入恢复区');
      }
    } else {
      // 只读状态下也定期检查锁是否过期（例如原操作页崩溃未释放锁），
      // 过期则自动接管并刷新，避免用户被永久卡在只读状态。
      const lock = readPageLock();
      if (isPageLockStale(lock) && acquirePageLock()) {
        state.isReadOnlyPage = false;
        applyPageAccessState();
        location.reload();
      }
    }
  }, 3000);

  // 前台可见时补一次心跳，减小后台节流醒来后被"抢锁"的窗口。
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!state.isReadOnlyPage) refreshPageLock();
  });

  // pagehide 在 iOS Safari 上比 beforeunload 更可靠。
  const releaseOnHide = () => {
    window.clearInterval(heartbeat);
    releasePageLock();
  };
  window.addEventListener('pageshow', event => {
    if (event.persisted) location.reload();
  });
  window.addEventListener('pagehide', releaseOnHide);
  window.addEventListener('beforeunload', releaseOnHide);
}

function init() {
  try {
    initializePageLock();
    // 事件埋点
    trackEvent('访问页面');

    // 数据初始化与修复
    initializeData();

    // 监听存储持久化错误（配额满等），给用户可见化提示，避免静默吞错导致以为消息已保存
    let _lastQuotaToastAt = 0;
    let _lastGenericToastAt = 0;
    onPersistError(({ type, isQuota }) => {
      const now = Date.now();
      if (type === 'tabs' && state.isReadOnlyPage) {
        applyPageAccessState();
      }
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

    if (storageRecoveryState.dsTabsReadFailed) {
      showToast('本地聊天数据暂时无法读取，已保护原数据；请刷新或导出恢复区后再处理');
    }
    if (storageRecoveryState.recoverySessionPresent) {
      if (storageRecoveryState.dsTabsReadFailed) {
        showToast('检测到恢复区聊天记录，但主聊天数据暂时无法读取；已保护两份数据，请勿继续覆盖');
      } else if (getRecoverySession()) {
        setTimeout(async () => {
          const recoveryInfo = getRecoverableStorageInfo();
          const recoveryAction = await showConfirmModal({
            title: '发现可恢复的聊天记录',
            desc: '检测到之前异常会话产生的聊天记录。合并后会追加为新的会话，不会覆盖当前记录。',
            okText: '合并恢复',
            cancelText: '暂不处理',
            secondaryText: '删除恢复数据'
          });
          if (recoveryAction === true) {
            if (!canModifyPersistedData()) {
              showToast('当前页面只读，暂不能合并；请先切换到操作页面');
            } else if (mergeRecoverySession()) {
              renderTabs();
              renderChat();
              showToast('恢复区聊天记录已合并');
            } else {
              showToast('本次未能合并恢复区，数据仍保留在本地，可稍后重试');
            }
          } else if (recoveryAction === 'secondary') {
            const shouldDiscard = await showConfirmModal({
              title: '确认删除恢复数据',
              desc: '恢复区中的聊天记录将永久删除，且无法撤销。当前正常会话不会受到影响。',
              okText: '确认删除',
              cancelText: '保留数据'
            });
            if (shouldDiscard) {
              if (discardRecoverySession(recoveryInfo.recoveryFingerprint)) {
                showToast('恢复区聊天记录已删除');
              } else {
                showToast('恢复数据已变化或当前页面已失去操作权，请重新确认');
              }
            }
          }
        }, 0);
      }
    }
    detectStoragePersistenceRisk().then(risky => {
      if (risky) {
        showToast('当前浏览环境可能不会长期保存聊天记录，建议不要使用无痕模式，并及时导出重要对话');
      }
    }).catch(() => {});

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
        const cleanupChoicePanel = document.getElementById('cleanupChoicePanel');
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
        if (cleanupChoicePanel && !cleanupChoicePanel.classList.contains('hidden')) closeCleanupChoicePanel();
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
      console.error('数据修复失败，已保留原始 dsTabs:', repairErr);
      try {
        const corrupted = localStorage.getItem("dsTabs");
        if (corrupted != null) localStorage.setItem("dsTabs_corrupted_backup", corrupted);
      } catch (_) {}
      try {
        showToast('数据修复失败，已保留原始聊天数据；请先导出 localStorage 后再手动处理');
      } catch (_) {
        alert('数据修复失败，已保留原始聊天数据；请先导出 localStorage 后再手动处理');
      }
    }
  }
}

// 启动应用
init();
