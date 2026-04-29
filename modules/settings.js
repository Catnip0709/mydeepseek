/**
 * settings.js — 设置面板模块
 *
 * 管理设置面板、API Key 管理、下载导出、字体设置事件绑定等。
 */

import { state, MEMORY_STRATEGY_WINDOW, MEMORY_STRATEGY_FULL } from './state.js';
import { copyText, checkIconSvg } from './utils.js';
import { getTabDisplayName, updateStorageUsage, isTokenLimitReached } from './storage.js';
import {
  showToast, openSettingsPanel, closeSettingsPanel, applyFontSize,
  updateFontSizeButtons, closeRenameTabPanel, saveRenamedTab,
  closeConfirmModal, closeDownloadPanel, hideReplyBar,
  openSidebar, closeSidebar
} from './panels.js';
import { renderChat } from './chat.js';
import { renderTabs } from './tabs.js';
import { call as coreCall } from './core.js';

export function applyDeepThinkState(nextChecked, source = 'manual') {
  const deepThinkToggle = document.getElementById('deepThinkToggle');
  if (!deepThinkToggle) return;

  // 互斥：HTML 模式开启时，拒绝"开启深度思考"的动作（关闭动作放行）
  // 使用同步 require 避免循环依赖时死锁：通过全局变量透传 htmlmode 的状态
  if (nextChecked && source !== 'html-mode-auto-off') {
    const htmlModeOn = !!window.__mydeepseek_htmlModeOn;
    if (htmlModeOn) {
      // 回滚 UI
      deepThinkToggle.checked = false;
      state.deepThink = false;
      try { showToast('预览网页模式下无法开启深度思考'); } catch (_) {}
      return;
    }
  }

  deepThinkToggle.checked = !!nextChecked;
  state.deepThink = !!nextChecked;
  localStorage.setItem('dsDeepThink', String(state.deepThink));
}

export function forceToggleDeepThinkFromUI(event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  const deepThinkToggle = document.getElementById('deepThinkToggle');
  if (!deepThinkToggle) return false;

  // 互斥拦截：HTML 模式开启时，忽略点击
  if (window.__mydeepseek_htmlModeOn && !deepThinkToggle.checked) {
    try { showToast('预览网页模式下无法开启深度思考'); } catch (_) {}
    return false;
  }

  applyDeepThinkState(!deepThinkToggle.checked, 'inline-ui');
  return false;
}

export function syncDeepThinkFromInput(checked) {
  applyDeepThinkState(!!checked, 'inline-input-change');
}

// ========== API Key 验证（内部函数） ==========

function validateApiKey(key) {
  if (!key || !key.startsWith("sk-")) {
    return alert("请输入有效的以sk-开头的API Key！");
  }
  if (key.length < 20) {
    alert("API Key长度过短，可能是无效的Key，请检查！");
    return false;
  }
  return true;
}

// ========== 导出功能 ==========

export function exportChatToTxt(tabId, mode = 'all', includeReasoning = true) {
  const msgs = state.tabData.list[tabId].messages || [];
  if (msgs.length === 0) {
    alert("当前对话为空，无法导出。");
    return;
  }

  let txtContent = `${getTabDisplayName(tabId)} - ${new Date().toLocaleString()}\n`;
  txtContent += `==================================================\n\n`;

  msgs.forEach(m => {
    if (mode === 'ai_only' && m.role === 'user') {
      return;
    }

    const currentTab = state.tabData.list[tabId];
    const isSingleChar = currentTab && currentTab.type === 'single-character';
    const charName = isSingleChar && currentTab.characterId ? (state.characterData.find(c => c.id === currentTab.characterId) || {}).name || 'DeepSeek' : 'DeepSeek';
    const roleName = m.role === 'user' ? '我' : (m.role === 'character' ? (m.characterName || '角色') : charName);
    txtContent += `【${roleName}】:\n`;

    if (includeReasoning && m.reasoningContent) {
      txtContent += `[思考过程]:\n${m.reasoningContent}\n\n`;
      txtContent += `[正文]:\n`;
    }

    txtContent += `${m.content}\n\n`;
    txtContent += `--------------------------------------------------\n\n`;
  });

  const blob = new Blob([txtContent], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const modeSuffix = mode === 'ai_only' ? '_AI回复' : '';
  const reasoningSuffix = includeReasoning ? '' : '_不含思考';
  const safeName = getTabDisplayName(tabId).replace(/[\\/:*?"<>|]/g, '_');
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safeName}${modeSuffix}${reasoningSuffix}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ========== 设置面板事件绑定 ==========

export function bindSettingsEvents() {
  const settingsBtn = document.getElementById('settingsBtn');
  const settingsCloseBtn = document.getElementById('settingsCloseBtn');
  const settingsPanel = document.getElementById('settingsPanel');
  const settingsCopyKeyBtn = document.getElementById('settingsCopyKeyBtn');
  const settingsSaveKeyBtn = document.getElementById('settingsSaveKeyBtn');
  const settingsApiKeyInput = document.getElementById('settingsApiKeyInput');
  const settingsDayModeToggle = document.getElementById('settingsDayModeToggle');
  const settingsTokenEstimateToggle = document.getElementById('settingsTokenEstimateToggle');
  const menuBtn = document.getElementById('menuBtn');
  const sidebarOverlay = document.getElementById('sidebarOverlay');
  const renameTabCancelBtn = document.getElementById('renameTabCancelBtn');
  const renameTabSaveBtn = document.getElementById('renameTabSaveBtn');
  const renameTabPanel = document.getElementById('renameTabPanel');
  const renameTabInput = document.getElementById('renameTabInput');
  const confirmCancelBtn = document.getElementById('confirmCancelBtn');
  const confirmOkBtn = document.getElementById('confirmOkBtn');
  const confirmPanel = document.getElementById('confirmPanel');
  const downloadCancelBtn = document.getElementById('downloadCancelBtn');
  const downloadPanel = document.getElementById('downloadPanel');
  const downloadAllBtn = document.getElementById('downloadAllBtn');
  const downloadAiOnlyBtn = document.getElementById('downloadAiOnlyBtn');
  const includeReasoningToggle = document.getElementById('includeReasoningToggle');
  const storageWarningIcon = document.getElementById('storageWarningIcon');
  const openDonateBtn = document.getElementById('openDonateBtn');
  const donatePanel = document.getElementById('donatePanel');
  const closeDonateBtn = document.getElementById('closeDonateBtn');
  const openInfoBtn = document.getElementById('openInfoBtn');
  const infoPanel = document.getElementById('infoPanel');
  const closeInfoBtn = document.getElementById('closeInfoBtn');
  const keyPanel = document.getElementById('keyPanel');
  const apiKeyInput = document.getElementById('apiKeyInput');
  const saveKey = document.getElementById('saveKey');
  const replyBarCancel = document.getElementById('replyBarCancel');
  const modelSelect = document.getElementById('modelSelect');
  const deepThinkToggle = document.getElementById('deepThinkToggle');
  const deepThinkChip = deepThinkToggle ? deepThinkToggle.closest('.deepthink-chip') : null;

  function triggerLegacySummaryMigrationAfterKeySaved() {
    coreCall('runLegacySummaryMigration');
  }

  // 侧边栏
  if (menuBtn) menuBtn.addEventListener("click", openSidebar);
  if (sidebarOverlay) sidebarOverlay.addEventListener("click", closeSidebar);

  // 设置面板
  if (settingsBtn) settingsBtn.addEventListener("click", openSettingsPanel);
  if (settingsCloseBtn) settingsCloseBtn.addEventListener("click", closeSettingsPanel);
  if (settingsPanel) settingsPanel.addEventListener("click", (e) => {
    if (e.target === settingsPanel) closeSettingsPanel();
  });

  // 设置 - 复制 API Key
  if (settingsCopyKeyBtn) {
    settingsCopyKeyBtn.addEventListener("click", () => {
      if (!settingsApiKeyInput) return;
      const key = settingsApiKeyInput.value.trim();
      copyText(key)?.then(() => {
        if (key) {
          showToast("API Key 已复制");
          const originalHtml = settingsCopyKeyBtn.innerHTML;
          settingsCopyKeyBtn.innerHTML = checkIconSvg;
          setTimeout(() => { settingsCopyKeyBtn.innerHTML = originalHtml; }, 1500);
        }
      });
    });
  }

  // 设置 - 保存 API Key
  if (settingsSaveKeyBtn) {
    settingsSaveKeyBtn.addEventListener("click", () => {
      if (!settingsApiKeyInput) return;
      const newKey = settingsApiKeyInput.value.trim();
      if (!validateApiKey(newKey)) return;
      state.apiKey = newKey;
      localStorage.setItem("dsApiKey", state.apiKey);
      updateStorageUsage();
      if (apiKeyInput) {
        apiKeyInput.value = state.apiKey;
      }
      triggerLegacySummaryMigrationAfterKeySaved();
      showToast("API Key 已保存");
      closeSettingsPanel();
    });
  }

  // 设置 - 日间模式
  if (settingsDayModeToggle) {
    settingsDayModeToggle.addEventListener("change", (e) => {
      const isDayMode = e.target.checked;
      if (isDayMode) {
        document.body.classList.add("day-mode");
      } else {
        document.body.classList.remove("day-mode");
      }
      localStorage.setItem("dsDayMode", isDayMode.toString());
    });
  }

  // 设置 - Token 预估显示
  if (settingsTokenEstimateToggle) {
    settingsTokenEstimateToggle.addEventListener("change", (e) => {
      const show = e.target.checked;
      if (show) {
        document.body.classList.remove("hide-token-estimate");
      } else {
        document.body.classList.add("hide-token-estimate");
      }
      localStorage.setItem("dsShowTokenEstimate", show.toString());
    });
  }

  // 设置 - 记忆策略
  const memoryStrategyWindow = document.getElementById('memoryStrategyWindow');
  const memoryStrategyFull = document.getElementById('memoryStrategyFull');
  
  // 初始化选中状态
  if (state.memoryStrategy === MEMORY_STRATEGY_FULL) {
    if (memoryStrategyFull) memoryStrategyFull.checked = true;
  } else {
    if (memoryStrategyWindow) memoryStrategyWindow.checked = true;
  }
  
  // 绑定事件
  if (memoryStrategyWindow) {
    memoryStrategyWindow.addEventListener("change", (e) => {
      if (e.target.checked) {
        state.memoryStrategy = MEMORY_STRATEGY_WINDOW;
        localStorage.setItem("dsMemoryStrategy", MEMORY_STRATEGY_WINDOW);
      }
    });
  }
  if (memoryStrategyFull) {
    memoryStrategyFull.addEventListener("change", (e) => {
      if (e.target.checked) {
        state.memoryStrategy = MEMORY_STRATEGY_FULL;
        localStorage.setItem("dsMemoryStrategy", MEMORY_STRATEGY_FULL);
      }
    });
  }

  // 字号选择
  document.querySelectorAll('.font-size-option').forEach(btn => {
    btn.addEventListener('click', () => {
      const size = btn.getAttribute('data-size');
      applyFontSize(size);
      updateFontSizeButtons(size);
      localStorage.setItem("dsFontSize", size);
    });
  });

  // 重命名面板
  if (renameTabCancelBtn) renameTabCancelBtn.addEventListener('click', closeRenameTabPanel);
  if (renameTabSaveBtn) renameTabSaveBtn.addEventListener('click', () => {
    saveRenamedTab();
    renderTabs();
  });
  if (renameTabPanel) renameTabPanel.addEventListener('click', (e) => {
    if (e.target === renameTabPanel) closeRenameTabPanel();
  });
  if (renameTabInput) renameTabInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      saveRenamedTab();
      renderTabs();
    }
  });

  // 确认弹窗
  if (confirmCancelBtn) confirmCancelBtn.addEventListener('click', () => closeConfirmModal(false));
  if (confirmOkBtn) confirmOkBtn.addEventListener('click', () => closeConfirmModal(true));
  if (confirmPanel) confirmPanel.addEventListener('click', (e) => {
    if (e.target === confirmPanel) closeConfirmModal(false);
  });

  // 导出面板
  if (downloadCancelBtn) downloadCancelBtn.addEventListener('click', closeDownloadPanel);
  if (downloadPanel) downloadPanel.addEventListener('click', (e) => {
    if (e.target === downloadPanel) closeDownloadPanel();
  });
  if (downloadAllBtn) downloadAllBtn.addEventListener('click', () => {
    if (state.pendingDownloadTabId) {
      exportChatToTxt(state.pendingDownloadTabId, 'all', includeReasoningToggle?.checked);
      closeDownloadPanel();
    }
  });
  if (downloadAiOnlyBtn) downloadAiOnlyBtn.addEventListener('click', () => {
    if (state.pendingDownloadTabId) {
      exportChatToTxt(state.pendingDownloadTabId, 'ai_only', includeReasoningToggle?.checked);
      closeDownloadPanel();
    }
  });

  // 存储警告
  if (storageWarningIcon) {
    storageWarningIcon.addEventListener('click', function() {
      alert('当前聊天内容接近本地存储上限，请及时导出并清理过期会话。');
    });
  }

  // 捐赠面板
  if (openDonateBtn) openDonateBtn.addEventListener("click", () => donatePanel.classList.remove("hidden"));
  if (closeDonateBtn) closeDonateBtn.addEventListener("click", () => donatePanel.classList.add("hidden"));
  if (donatePanel) donatePanel.addEventListener("click", (e) => {
    if (e.target === donatePanel) donatePanel.classList.add("hidden");
  });

  // 信息面板
  if (openInfoBtn) openInfoBtn.addEventListener("click", () => infoPanel.classList.remove("hidden"));
  if (closeInfoBtn) closeInfoBtn.addEventListener("click", () => infoPanel.classList.add("hidden"));
  if (infoPanel) infoPanel.addEventListener("click", (e) => {
    if (e.target === infoPanel) infoPanel.classList.add("hidden");
  });

  // API Key 面板
  if (saveKey) {
    saveKey.onclick = () => {
      const newKey = apiKeyInput.value.trim();
      if (!validateApiKey(newKey)) return;
      state.apiKey = newKey;
      localStorage.setItem("dsApiKey", state.apiKey);
      updateStorageUsage();
      keyPanel.classList.add("hidden");
      triggerLegacySummaryMigrationAfterKeySaved();
      showToast("API Key 已保存");
    };
  }

  // 回复引用条取消
  if (replyBarCancel) replyBarCancel.addEventListener('click', hideReplyBar);

  // 模型选择
  const modelChoiceRadios = document.querySelectorAll('input[name="modelChoice"]');
  if (modelChoiceRadios.length) {
    // 初始化选中状态
    modelChoiceRadios.forEach(radio => {
      radio.checked = radio.value === state.selectedModel;
    });
    // 监听切换
    modelChoiceRadios.forEach(radio => {
      radio.addEventListener('change', (e) => {
        state.selectedModel = e.target.value;
        localStorage.setItem('dsSelectedModel', state.selectedModel);
        // 切换模型后，若当前对话已超过新模型的上下文上限，立即刷新渲染以显示警告
        if (isTokenLimitReached()) {
          renderChat();
        }
      });
    });
  }

  // 深度思考开关
  if (deepThinkToggle) {
    let suppressNextNativeChange = false;

    applyDeepThinkState(state.deepThink, 'init');

    if (deepThinkChip) {
      const toggleFromChip = (source = 'chip-click') => {
        suppressNextNativeChange = true;
        applyDeepThinkState(!deepThinkToggle.checked, source);
      };

      deepThinkChip.addEventListener('click', (e) => {
        if (e.target === deepThinkToggle) return;
        e.preventDefault();
        e.stopPropagation();
        toggleFromChip('chip-click');
      });

      document.addEventListener('pointerdown', (e) => {
        const chip = e.target.closest('.deepthink-chip');
        if (!chip || chip !== deepThinkChip) return;
        if (e.target === deepThinkToggle) return;
        e.preventDefault();
        toggleFromChip('delegated-pointerdown');
      }, true);
    }
    deepThinkToggle.addEventListener("change", (e) => {
      if (suppressNextNativeChange) {
        suppressNextNativeChange = false;
        return;
      }
      applyDeepThinkState(e.target.checked, 'native-change');
    });
  }

  // 旧的 modelSelect 同步（保持兼容，隐藏的 select 也同步状态）
  if (modelSelect) {
    modelSelect.value = "deepseek-chat";
  }
}
