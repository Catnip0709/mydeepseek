// app-settings.js - 设置面板、导出、侧边栏、确认弹窗
(function() {
  'use strict';
  const App = window.App;

  // ==================== DOM 元素 ====================

  // 侧边栏
  const menuBtn = document.getElementById("menuBtn");
  const sidebar = document.getElementById("sidebar");
  const sidebarOverlay = document.getElementById("sidebarOverlay");

  // 设置面板
  const settingsBtn = document.getElementById("settingsBtn");
  const settingsPanel = document.getElementById("settingsPanel");
  const settingsCloseBtn = document.getElementById("settingsCloseBtn");
  const settingsApiKeyInput = document.getElementById("settingsApiKeyInput");
  const settingsCopyKeyBtn = document.getElementById("settingsCopyKeyBtn");
  const settingsSaveKeyBtn = document.getElementById("settingsSaveKeyBtn");
  const settingsDayModeToggle = document.getElementById("settingsDayModeToggle");
  const settingsTokenEstimateToggle = document.getElementById("settingsTokenEstimateToggle");
  const settingsMemorySelect = document.getElementById("settingsMemorySelect");
  const settingsMemoryCustom = document.getElementById("settingsMemoryCustom");

  // 确认弹窗
  const confirmPanel = document.getElementById("confirmPanel");
  const confirmTitle = document.getElementById("confirmTitle");
  const confirmDesc = document.getElementById("confirmDesc");
  const confirmCancelBtn = document.getElementById("confirmCancelBtn");
  const confirmOkBtn = document.getElementById("confirmOkBtn");

  // 导出面板
  const downloadPanel = document.getElementById("downloadPanel");
  const downloadCancelBtn = document.getElementById("downloadCancelBtn");
  const downloadAllBtn = document.getElementById("downloadAllBtn");
  const downloadAiOnlyBtn = document.getElementById("downloadAiOnlyBtn");
  const includeReasoningToggle = document.getElementById("includeReasoningToggle");

  // SVG 图标
  const checkIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;

  // ==================== 内部变量 ====================
  let isSidebarOpen = false;
  let touchStartX = 0;
  let touchEndX = 0;

  // ==================== 侧边栏 ====================

  App.openSidebar = function() {
    isSidebarOpen = true;
    sidebar.classList.remove("-translate-x-full");
    sidebarOverlay.classList.remove("opacity-0", "pointer-events-none");
    sidebarOverlay.classList.add("opacity-100", "pointer-events-auto");
  };

  App.closeSidebar = function() {
    isSidebarOpen = false;
    sidebar.classList.add("-translate-x-full");
    sidebarOverlay.classList.remove("opacity-100", "pointer-events-auto");
    sidebarOverlay.classList.add("opacity-0", "pointer-events-none");
  };

  function handleSwipe() {
    const swipeDist = touchEndX - touchStartX;
    if (swipeDist > 50 && touchStartX < 30 && !isSidebarOpen) {
      App.openSidebar();
    }
    if (swipeDist < -50 && isSidebarOpen) {
      App.closeSidebar();
    }
  }

  // ==================== 字体大小 ====================

  function applyFontSize(size) {
    document.body.classList.remove("font-size-small", "font-size-smaller", "font-size-default", "font-size-larger", "font-size-large");
    document.body.classList.add(`font-size-${size}`);
  }

  function updateFontSizeButtons(activeSize) {
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

  // ==================== 设置面板 ====================

  App.openSettingsPanel = function() {
    if (settingsApiKeyInput) {
      settingsApiKeyInput.value = App.apiKey || "";
    }
    const currentFontSize = localStorage.getItem("dsFontSize") || "default";
    const currentDayMode = localStorage.getItem("dsDayMode") === "true";
    if (settingsDayModeToggle) {
      settingsDayModeToggle.checked = currentDayMode;
    }
    updateFontSizeButtons(currentFontSize);

    const currentMemoryLimit = App.globalMemoryLimit;
    if (settingsMemorySelect) {
      if (["0", "200", "100", "50"].includes(currentMemoryLimit)) {
        settingsMemorySelect.value = currentMemoryLimit;
        if (settingsMemoryCustom) {
          settingsMemoryCustom.classList.add("hidden");
        }
      } else {
        settingsMemorySelect.value = "custom";
        if (settingsMemoryCustom) {
          settingsMemoryCustom.value = currentMemoryLimit;
          settingsMemoryCustom.classList.remove("hidden");
        }
      }
    }

    if (settingsPanel) {
      settingsPanel.classList.remove("hidden");
    }
    App.closeSidebar();
  };

  App.closeSettingsPanel = function() {
    if (settingsPanel) {
      settingsPanel.classList.add("hidden");
    }
  };

  // ==================== 确认弹窗 ====================

  App.showConfirmModal = function({ title = '确认操作', desc = '确定继续吗？', okText = '确认', cancelText = '取消' } = {}) {
    confirmTitle.textContent = title;
    confirmDesc.textContent = desc;
    confirmOkBtn.textContent = okText;
    confirmCancelBtn.textContent = cancelText;
    confirmPanel.classList.remove('hidden');

    return new Promise(resolve => {
      App.confirmResolve = resolve;
    });
  };

  App.closeConfirmModal = function(result) {
    confirmPanel.classList.add('hidden');
    if (App.confirmResolve) {
      App.confirmResolve(result);
      App.confirmResolve = null;
    }
  };

  // ==================== 导出功能 ====================

  function exportChatToTxt(tabId, mode = 'all', includeReasoning = true) {
    const msgs = App.tabData.list[tabId].messages || [];
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

      const roleName = m.role === 'user' ? '我' : (m.role === 'character' ? (m.characterName || '角色') : 'DeepSeek');
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

  function openDownloadPanel(tabId) {
    const msgs = App.tabData.list[tabId].messages || [];
    if (msgs.length === 0) {
      alert("当前对话为空，无法导出。");
      return;
    }
    App.pendingDownloadTabId = tabId;
    includeReasoningToggle.checked = true;
    downloadPanel.classList.remove("hidden");
  }

  function closeDownloadPanel() {
    downloadPanel.classList.add("hidden");
    App.pendingDownloadTabId = null;
  }

  App.openDownloadPanel = openDownloadPanel;

  // ==================== 内部辅助函数 ====================

  function getTabDisplayName(id) {
    const tab = App.tabData.list[id];
    if (!tab) return id;
    const customTitle = (tab.title || '').trim();
    return customTitle || `对话 ${id.replace("tab", "")}`;
  }

  // ==================== 初始化设置 ====================

  // 日间模式初始化
  const savedDayMode = localStorage.getItem("dsDayMode") === "true";
  if (settingsDayModeToggle) {
    settingsDayModeToggle.checked = savedDayMode;
  }
  if (savedDayMode) {
    document.body.classList.add("day-mode");
  }

  // Token 估算显示初始化
  const showTokenEstimate = localStorage.getItem("dsShowTokenEstimate") !== "false";
  if (settingsTokenEstimateToggle) {
    settingsTokenEstimateToggle.checked = showTokenEstimate;
  }
  if (!showTokenEstimate) {
    document.body.classList.add("hide-token-estimate");
  }

  // 字体大小初始化
  const savedFontSize = localStorage.getItem("dsFontSize") || "default";
  applyFontSize(savedFontSize);
  if (document.querySelector('.font-size-option')) {
    updateFontSizeButtons(savedFontSize);
  }

  // ==================== 事件绑定 ====================

  // 侧边栏事件
  menuBtn.addEventListener("click", App.openSidebar);
  sidebarOverlay.addEventListener("click", App.closeSidebar);

  document.addEventListener('touchstart', e => {
    touchStartX = e.changedTouches[0].screenX;
  }, { passive: true });

  document.addEventListener('touchend', e => {
    touchEndX = e.changedTouches[0].screenX;
    handleSwipe();
  }, { passive: true });

  // 设置面板事件
  if (settingsBtn) {
    settingsBtn.addEventListener("click", App.openSettingsPanel);
  }
  if (settingsCloseBtn) {
    settingsCloseBtn.addEventListener("click", App.closeSettingsPanel);
  }
  if (settingsPanel) {
    settingsPanel.addEventListener("click", (e) => {
      if (e.target === settingsPanel) App.closeSettingsPanel();
    });
  }

  if (settingsCopyKeyBtn) {
    settingsCopyKeyBtn.addEventListener("click", () => {
      if (!settingsApiKeyInput) return;
      const key = settingsApiKeyInput.value.trim();
      App.copyText(key)?.then(() => {
        if (key) {
          App.showToast("API Key 已复制");
          const originalHtml = settingsCopyKeyBtn.innerHTML;
          settingsCopyKeyBtn.innerHTML = checkIconSvg;
          setTimeout(() => { settingsCopyKeyBtn.innerHTML = originalHtml; }, 1500);
        }
      });
    });
  }

  if (settingsSaveKeyBtn) {
    settingsSaveKeyBtn.addEventListener("click", () => {
      if (!settingsApiKeyInput) return;
      const newKey = settingsApiKeyInput.value.trim();
      if (!newKey || !newKey.startsWith("sk-")) {
        return alert("请输入有效的以sk-开头的API Key！");
      }
      if (newKey.length < 20) {
        alert("API Key长度过短，可能是无效的Key，请检查！");
        return;
      }
      App.apiKey = newKey;
      localStorage.setItem("dsApiKey", App.apiKey);
      App.updateStorageUsage();
      const apiKeyInput = document.getElementById("apiKeyInput");
      if (apiKeyInput) {
        apiKeyInput.value = App.apiKey;
      }
      App.showToast("API Key 已保存");
      App.closeSettingsPanel();
    });
  }

  // 日间模式切换
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

  // Token 估算显示切换
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

  // 字体大小按钮
  document.querySelectorAll('.font-size-option').forEach(btn => {
    btn.addEventListener('click', () => {
      const size = btn.getAttribute('data-size');
      applyFontSize(size);
      updateFontSizeButtons(size);
      localStorage.setItem("dsFontSize", size);
    });
  });

  // 记忆限制选择
  if (settingsMemorySelect) {
    settingsMemorySelect.addEventListener("change", (e) => {
      const val = e.target.value;
      if (val === "custom") {
        if (settingsMemoryCustom) {
          settingsMemoryCustom.classList.remove("hidden");
          settingsMemoryCustom.focus();
          const customVal = parseInt(settingsMemoryCustom.value) || 10;
          settingsMemoryCustom.value = customVal;
          App.globalMemoryLimit = customVal.toString();
        }
      } else {
        if (settingsMemoryCustom) {
          settingsMemoryCustom.classList.add("hidden");
        }
        App.globalMemoryLimit = val;
      }
      localStorage.setItem("dsGlobalMemoryLimit", App.globalMemoryLimit);
      App.renderChat();
    });
  }

  if (settingsMemoryCustom) {
    settingsMemoryCustom.addEventListener("input", (e) => {
      const val = parseInt(e.target.value);
      if (!isNaN(val) && val >= 0) {
        App.globalMemoryLimit = val.toString();
        localStorage.setItem("dsGlobalMemoryLimit", App.globalMemoryLimit);
        App.renderChat();
      }
    });
  }

  // 确认弹窗事件
  confirmCancelBtn.addEventListener('click', () => App.closeConfirmModal(false));
  confirmOkBtn.addEventListener('click', () => App.closeConfirmModal(true));
  confirmPanel.addEventListener('click', (e) => {
    if (e.target === confirmPanel) App.closeConfirmModal(false);
  });

  // 导出面板事件
  downloadCancelBtn.addEventListener("click", closeDownloadPanel);
  downloadPanel.addEventListener("click", (e) => {
    if (e.target === downloadPanel) closeDownloadPanel();
  });
  downloadAllBtn.addEventListener("click", () => {
    if (App.pendingDownloadTabId) {
      exportChatToTxt(App.pendingDownloadTabId, 'all', includeReasoningToggle.checked);
      closeDownloadPanel();
    }
  });
  downloadAiOnlyBtn.addEventListener("click", () => {
    if (App.pendingDownloadTabId) {
      exportChatToTxt(App.pendingDownloadTabId, 'ai_only', includeReasoningToggle.checked);
      closeDownloadPanel();
    }
  });
})();
