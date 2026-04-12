document.addEventListener('DOMContentLoaded', function() {
  let dsUserId = localStorage.getItem('ds_user_id');
  if (!dsUserId) {
    dsUserId = 'user_' + Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
    localStorage.setItem('ds_user_id', dsUserId);
  }

  function trackEvent(eventType) {
    const webhookUrl = 'https://bytedance.sg.larkoffice.com/base/automation/webhook/event/GnMPaByLZwehPShLu46lsgQQghd';
    fetch(webhookUrl, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_type: eventType, user_id: dsUserId })
    }).catch(err => { console.log('Tracking info:', err); });
  }

  trackEvent('访问页面');

  let apiKey = localStorage.getItem("dsApiKey");

  let tabData = JSON.parse(localStorage.getItem("dsTabs")) || (() => {
    const oldMsgs = JSON.parse(localStorage.getItem("dsMessages")) || [];
    return { active: "tab1", list: { tab1: { messages: oldMsgs, memoryLimit: "0", title: "" } } };
  })();

  Object.keys(tabData.list).forEach(id => {
    if (Array.isArray(tabData.list[id])) {
      tabData.list[id] = { messages: tabData.list[id], memoryLimit: "0", title: "" };
    } else {
      if (typeof tabData.list[id].title === 'undefined') tabData.list[id].title = "";
      if (typeof tabData.list[id].memoryLimit === 'undefined') tabData.list[id].memoryLimit = "0";
      if (!Array.isArray(tabData.list[id].messages)) tabData.list[id].messages = [];
    }

    tabData.list[id].messages.forEach(msg => {
      if (msg.history && typeof msg.history[0] === 'string') {
        msg.history = msg.history.map(content => ({ content: content, reasoningContent: "" }));
      }
    });
  });

  let editingMessageIndex = -1;
  let isSending = false;
  let abortController = null;
  let abortReason = null;
  let lastPageHiddenAt = 0;
  let shouldToastOnVisible = false;

  function abortStreaming(reason) {
    abortReason = reason;
    if (abortController) {
      try { abortController.abort(); } catch (_) {}
    }
  }

  const PROMPT_STORAGE_KEY = 'dsPrompts';
  let promptData = JSON.parse(localStorage.getItem(PROMPT_STORAGE_KEY)) || [];
  let editingPromptId = null;

  let renamingTabId = null;
  let confirmResolve = null;
  let optimizedCandidateText = '';
  let optimizeInProgress = false;

  const MAX_CONTEXT_TOKENS = 131072;
  function isTokenLimitReached() {
    const currentMsgs = tabData.list[tabData.active].messages || [];
    const payloadMsgs = buildPayloadMessages(currentMsgs);
    let estimatedTokens = 0;
    payloadMsgs.forEach(m => {
      estimatedTokens += estimateTokensByText(m.content);
    });
    return estimatedTokens >= MAX_CONTEXT_TOKENS * 0.98;
  }

  function getTabDisplayName(id) {
    const tab = tabData.list[id];
    if (!tab) return id;
    const customTitle = (tab.title || '').trim();
    return customTitle || `对话 ${id.replace("tab", "")}`;
  }

  const chat = document.getElementById("chat");
  const input = document.getElementById("input");
  const sendBtn = document.getElementById("sendBtn");
  const tabsEl = document.getElementById("tabs");
  const addTab = document.getElementById("addTab");
  const keyPanel = document.getElementById("keyPanel");
  const apiKeyInput = document.getElementById("apiKeyInput");
  const saveKey = document.getElementById("saveKey");
  const editPanel = document.getElementById("editPanel");
  const editTextarea = document.getElementById("editTextarea");
  const editCancelBtn = document.getElementById("editCancelBtn");
  const editSaveBtn = document.getElementById("editSaveBtn");
  const scrollToBottomBtn = document.getElementById("scrollToBottomBtn");
  const modelSelect = document.getElementById("modelSelect");
  const deepThinkToggle = document.getElementById("deepThinkToggle");

  const menuBtn = document.getElementById("menuBtn");
  const sidebar = document.getElementById("sidebar");
  const sidebarOverlay = document.getElementById("sidebarOverlay");
  const inputCounter = document.getElementById("inputCounter");

  const openDonateBtn = document.getElementById("openDonateBtn");
  const donatePanel = document.getElementById("donatePanel");
  const closeDonateBtn = document.getElementById("closeDonateBtn");

  const openInfoBtn = document.getElementById("openInfoBtn");
  const infoPanel = document.getElementById("infoPanel");
  const closeInfoBtn = document.getElementById("closeInfoBtn");

  const openPromptManagerBtn = document.getElementById("openPromptManagerBtn");
  const promptPanel = document.getElementById("promptPanel");
  const closePromptPanelBtn = document.getElementById("closePromptPanelBtn");
  const promptListView = document.getElementById("promptListView");
  const promptFormView = document.getElementById("promptFormView");
  const promptList = document.getElementById("promptList");
  const addPromptBtn = document.getElementById("addPromptBtn");
  const promptTitleInput = document.getElementById("promptTitleInput");
  const promptContentInput = document.getElementById("promptContentInput");
  const cancelPromptEditBtn = document.getElementById("cancelPromptEditBtn");
  const savePromptBtn = document.getElementById("savePromptBtn");
  const optimizePromptBtn = document.getElementById("optimizePromptBtn");

  const settingsBtn = document.getElementById("settingsBtn");
  const settingsPanel = document.getElementById("settingsPanel");
  const settingsCloseBtn = document.getElementById("settingsCloseBtn");
  const settingsApiKeyInput = document.getElementById("settingsApiKeyInput");
  const settingsCopyKeyBtn = document.getElementById("settingsCopyKeyBtn");
  const settingsSaveKeyBtn = document.getElementById("settingsSaveKeyBtn");
  const settingsDayModeToggle = document.getElementById("settingsDayModeToggle");
  const fontSizePreview = document.getElementById("fontSizePreview");
  const settingsMemorySelect = document.getElementById("settingsMemorySelect");
  const settingsMemoryCustom = document.getElementById("settingsMemoryCustom");

  const renameTabPanel = document.getElementById("renameTabPanel");
  const renameTabInput = document.getElementById("renameTabInput");
  const renameTabCancelBtn = document.getElementById("renameTabCancelBtn");
  const renameTabSaveBtn = document.getElementById("renameTabSaveBtn");

  const confirmPanel = document.getElementById("confirmPanel");
  const confirmTitle = document.getElementById("confirmTitle");
  const confirmDesc = document.getElementById("confirmDesc");
  const confirmCancelBtn = document.getElementById("confirmCancelBtn");
  const confirmOkBtn = document.getElementById("confirmOkBtn");

  const downloadPanel = document.getElementById("downloadPanel");
  const downloadCancelBtn = document.getElementById("downloadCancelBtn");
  const downloadAllBtn = document.getElementById("downloadAllBtn");
  const downloadAiOnlyBtn = document.getElementById("downloadAiOnlyBtn");
  const includeReasoningToggle = document.getElementById("includeReasoningToggle");
  let pendingDownloadTabId = null;

  const promptOptimizePreviewPanel = document.getElementById("promptOptimizePreviewPanel");
  const originalPromptPreview = document.getElementById("originalPromptPreview");
  const optimizedPromptPreview = document.getElementById("optimizedPromptPreview");
  const discardOptimizedPromptBtn = document.getElementById("discardOptimizedPromptBtn");
  const applyOptimizedPromptBtn = document.getElementById("applyOptimizedPromptBtn");

  const copyIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
  const deleteIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`;
  const editIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"></path></svg>`;
  const checkIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
  const downloadIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`;
  const renameIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"></path></svg>`;

  if (!apiKey) {
    keyPanel.classList.remove("hidden");
  } else {
    apiKeyInput.value = apiKey;
  }

  function showToast(text) {
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

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      lastPageHiddenAt = Date.now();
      if (isSending && abortController) {
        shouldToastOnVisible = true;
        abortStreaming('background');
      }
      return;
    }

    if (shouldToastOnVisible) {
      shouldToastOnVisible = false;
      showToast('已从后台返回：刚才的生成已中断，可点击“重新生成”继续');
    }
  });

  openDonateBtn.addEventListener("click", () => donatePanel.classList.remove("hidden"));
  closeDonateBtn.addEventListener("click", () => donatePanel.classList.add("hidden"));
  donatePanel.addEventListener("click", (e) => {
    if (e.target === donatePanel) donatePanel.classList.add("hidden");
  });

  openInfoBtn.addEventListener("click", () => infoPanel.classList.remove("hidden"));
  closeInfoBtn.addEventListener("click", () => infoPanel.classList.add("hidden"));
  infoPanel.addEventListener("click", (e) => {
    if (e.target === infoPanel) infoPanel.classList.add("hidden");
  });

  let savedModel = "deepseek-chat";
  modelSelect.value = savedModel;
  deepThinkToggle.checked = false;

  deepThinkToggle.addEventListener("change", (e) => {
    const newModel = e.target.checked ? "deepseek-reasoner" : "deepseek-chat";
    modelSelect.value = newModel;
  });

  const fontSizes = {
    small: '0.875rem',
    smaller: '0.9375rem',
    default: '1rem',
    larger: '1.0625rem',
    large: '1.125rem'
  };

  const savedDayMode = localStorage.getItem("dsDayMode") === "true";
  if (settingsDayModeToggle) {
    settingsDayModeToggle.checked = savedDayMode;
  }
  if (savedDayMode) {
    document.body.classList.add("day-mode");
  }

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

  const savedFontSize = localStorage.getItem("dsFontSize") || "default";
  applyFontSize(savedFontSize);
  if (document.querySelector('.font-size-option')) {
    updateFontSizeButtons(savedFontSize);
  }
  if (fontSizePreview) {
    updateFontSizePreview(savedFontSize);
  }

  let globalMemoryLimit = localStorage.getItem("dsGlobalMemoryLimit") || "0";

  function applyFontSize(size) {
    document.body.classList.remove("font-size-small", "font-size-smaller", "font-size-default", "font-size-larger", "font-size-large");
    document.body.classList.add(`font-size-${size}`);
  }

  function updateFontSizePreview(size) {
    if (fontSizePreview) {
      fontSizePreview.style.fontSize = fontSizes[size];
    }
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

  document.querySelectorAll('.font-size-option').forEach(btn => {
    btn.addEventListener('click', () => {
      const size = btn.getAttribute('data-size');
      applyFontSize(size);
      updateFontSizeButtons(size);
      updateFontSizePreview(size);
      localStorage.setItem("dsFontSize", size);
    });
  });

  function openSettingsPanel() {
    if (settingsApiKeyInput) {
      settingsApiKeyInput.value = apiKey || "";
    }
    const currentFontSize = localStorage.getItem("dsFontSize") || "default";
    const currentDayMode = localStorage.getItem("dsDayMode") === "true";
    if (settingsDayModeToggle) {
      settingsDayModeToggle.checked = currentDayMode;
    }
    updateFontSizeButtons(currentFontSize);
    updateFontSizePreview(currentFontSize);
    
    const currentMemoryLimit = globalMemoryLimit;
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
    closeSidebar();
  }

  function closeSettingsPanel() {
    if (settingsPanel) {
      settingsPanel.classList.add("hidden");
    }
  }

  if (settingsBtn) {
    settingsBtn.addEventListener("click", openSettingsPanel);
  }
  if (settingsCloseBtn) {
    settingsCloseBtn.addEventListener("click", closeSettingsPanel);
  }
  if (settingsPanel) {
    settingsPanel.addEventListener("click", (e) => {
      if (e.target === settingsPanel) closeSettingsPanel();
    });
  }

  if (settingsCopyKeyBtn) {
    settingsCopyKeyBtn.addEventListener("click", () => {
      if (!settingsApiKeyInput) return;
      const key = settingsApiKeyInput.value.trim();
      copyText(key)?.then(() => {
        if (key) showToast("API Key 已复制");
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
      apiKey = newKey;
      localStorage.setItem("dsApiKey", apiKey);
      if (apiKeyInput) {
        apiKeyInput.value = apiKey;
      }
      showToast("API Key 已保存");
      closeSettingsPanel();
    });
  }

  if (settingsMemorySelect) {
    settingsMemorySelect.addEventListener("change", (e) => {
      const val = e.target.value;
      if (val === "custom") {
        if (settingsMemoryCustom) {
          settingsMemoryCustom.classList.remove("hidden");
          settingsMemoryCustom.focus();
          const customVal = parseInt(settingsMemoryCustom.value) || 10;
          settingsMemoryCustom.value = customVal;
          globalMemoryLimit = customVal.toString();
        }
      } else {
        if (settingsMemoryCustom) {
          settingsMemoryCustom.classList.add("hidden");
        }
        globalMemoryLimit = val;
      }
      localStorage.setItem("dsGlobalMemoryLimit", globalMemoryLimit);
      renderChat();
    });
  }

  if (settingsMemoryCustom) {
    settingsMemoryCustom.addEventListener("input", (e) => {
      const val = parseInt(e.target.value);
      if (!isNaN(val) && val >= 0) {
        globalMemoryLimit = val.toString();
        localStorage.setItem("dsGlobalMemoryLimit", globalMemoryLimit);
        renderChat();
      }
    });
  }

  downloadCancelBtn.addEventListener("click", closeDownloadPanel);
  downloadPanel.addEventListener("click", (e) => {
    if (e.target === downloadPanel) closeDownloadPanel();
  });
  downloadAllBtn.addEventListener("click", () => {
    if (pendingDownloadTabId) {
      exportChatToTxt(pendingDownloadTabId, 'all', includeReasoningToggle.checked);
      closeDownloadPanel();
    }
  });
  downloadAiOnlyBtn.addEventListener("click", () => {
    if (pendingDownloadTabId) {
      exportChatToTxt(pendingDownloadTabId, 'ai_only', includeReasoningToggle.checked);
      closeDownloadPanel();
    }
  });

  function saveTabs() {
    localStorage.setItem("dsTabs", JSON.stringify(tabData));
  }

  function savePrompts() {
    localStorage.setItem(PROMPT_STORAGE_KEY, JSON.stringify(promptData));
  }



  let isSidebarOpen = false;

  function openSidebar() {
    isSidebarOpen = true;
    sidebar.classList.remove("-translate-x-full");
    sidebarOverlay.classList.remove("opacity-0", "pointer-events-none");
    sidebarOverlay.classList.add("opacity-100", "pointer-events-auto");
  }

  function closeSidebar() {
    isSidebarOpen = false;
    sidebar.classList.add("-translate-x-full");
    sidebarOverlay.classList.remove("opacity-100", "pointer-events-auto");
    sidebarOverlay.classList.add("opacity-0", "pointer-events-none");
  }

  menuBtn.addEventListener("click", openSidebar);
  sidebarOverlay.addEventListener("click", closeSidebar);

  let touchStartX = 0;
  let touchEndX = 0;

  document.addEventListener('touchstart', e => {
    touchStartX = e.changedTouches[0].screenX;
  }, { passive: true });

  document.addEventListener('touchend', e => {
    touchEndX = e.changedTouches[0].screenX;
    handleSwipe();
  }, { passive: true });

  function handleSwipe() {
    const swipeDist = touchEndX - touchStartX;
    if (swipeDist > 50 && touchStartX < 30 && !isSidebarOpen) {
      openSidebar();
    }
    if (swipeDist < -50 && isSidebarOpen) {
      closeSidebar();
    }
  }

  saveKey.onclick = () => {
    const newKey = apiKeyInput.value.trim();
    if (!newKey || !newKey.startsWith("sk-")) {
      return alert("请输入有效的以sk-开头的API Key！");
    }
    if (newKey.length < 20) {
      alert("API Key长度过短，可能是无效的Key，请检查！");
      return;
    }
    apiKey = newKey;
    localStorage.setItem("dsApiKey", apiKey);
    keyPanel.classList.add("hidden");
    showToast("API Key 已保存");
  };

  function openRenameTabPanel(tabId) {
    renamingTabId = tabId;
    renameTabInput.value = tabData.list[tabId]?.title || '';
    renameTabPanel.classList.remove('hidden');
    setTimeout(() => {
      renameTabInput.focus();
      renameTabInput.select();
    }, 30);
  }

  function closeRenameTabPanel() {
    renamingTabId = null;
    renameTabPanel.classList.add('hidden');
    renameTabInput.value = '';
  }

  function saveRenamedTab() {
    if (!renamingTabId || !tabData.list[renamingTabId]) return;
    const finalName = renameTabInput.value.trim();
    tabData.list[renamingTabId].title = finalName;
    saveTabs();
    renderTabs();
    closeRenameTabPanel();
    showToast(finalName ? '会话名称已更新' : '已恢复默认会话名称');
  }

  function showConfirmModal({ title = '确认操作', desc = '确定继续吗？', okText = '确认', cancelText = '取消' } = {}) {
    confirmTitle.textContent = title;
    confirmDesc.textContent = desc;
    confirmOkBtn.textContent = okText;
    confirmCancelBtn.textContent = cancelText;
    confirmPanel.classList.remove('hidden');

    return new Promise(resolve => {
      confirmResolve = resolve;
    });
  }

  function closeConfirmModal(result) {
    confirmPanel.classList.add('hidden');
    if (confirmResolve) {
      confirmResolve(result);
      confirmResolve = null;
    }
  }

  async function optimizePromptWithAI() {
    if (optimizeInProgress) return;
    const original = promptContentInput.value.trim();

    if (!original) {
      showToast('请先填写指令内容');
      promptContentInput.focus();
      return;
    }

    if (!apiKey) {
      keyPanel.classList.remove("hidden");
      return;
    }

    const confirmed = await showConfirmModal({
      title: '智能优化当前指令',
      desc: '我会在尽量不改变原意的前提下，帮你把当前内容整理得更清晰、更自然，并尽量保持接近原长度。是否继续？',
      okText: '开始优化',
      cancelText: '暂不需要'
    });

    if (!confirmed) return;

    optimizeInProgress = true;
    const oldHtml = optimizePromptBtn.innerHTML;
    optimizePromptBtn.disabled = true;
    optimizePromptBtn.innerHTML = `<div class="loading-spinner"></div>`;

    try {
      const optimized = await requestOptimizedPrompt(original);
      if (!optimized || !optimized.trim()) {
        throw new Error('AI 未返回有效结果');
      }

      optimizedCandidateText = optimized.trim();
      originalPromptPreview.textContent = original;
      optimizedPromptPreview.textContent = optimizedCandidateText;
      promptOptimizePreviewPanel.classList.remove('hidden');
    } catch (e) {
      console.error(e);
      alert('AI 优化失败：' + e.message);
    } finally {
      optimizeInProgress = false;
      optimizePromptBtn.disabled = false;
      optimizePromptBtn.innerHTML = oldHtml;
    }
  }

  async function requestOptimizedPrompt(original) {
    const originalLength = original.length;
    const minLen = Math.max(1, Math.floor(originalLength * 0.9));
    const maxLen = Math.max(minLen, Math.ceil(originalLength * 1.1));
    const approxMaxTokens = Math.max(256, Math.min(1200, Math.ceil(maxLen * 2.2)));

    const messages = [
      {
        role: "system",
        content:
`你是一个擅长优化提示词（Prompt）的助手。

任务要求：
1. 优化用户提供的 prompt，使表达更清晰、结构更自然、指令更明确。
2. 保持用户原意，不要擅自新增明显超出原意的要求。
3. 输出风格应当自然、直接、可立即使用。
4. 控制字数与原文尽量接近，目标范围是原文长度的 90%~110%。
5. 不要解释，不要分析，不要加前言，不要使用标题“优化后”，只输出优化后的 prompt 正文。
6. 如果原文本身就是分点结构，可以保留分点；如果不是，也不要强行过度格式化。`
      },
      {
        role: "user",
        content:
`请帮我优化下面这段 prompt。

原文长度：${originalLength} 字
目标长度范围：${minLen}~${maxLen} 字

原文如下：
${original}`
      }
    ];

    const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "Cache-Control": "no-cache",
        "Pragma": "no-cache"
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages,
        stream: false,
        temperature: 0.5,
        max_tokens: approxMaxTokens
      })
    });

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData.error?.message || '请求失败，请检查 API Key 或稍后重试');
    }

    const data = await res.json();
    let content = data?.choices?.[0]?.message?.content || '';

    content = String(content).trim()
      .replace(/^```[\w-]*\n?/i, '')
      .replace(/\n?```$/, '')
      .trim();

    return content;
  }

  function closeOptimizePreviewPanel() {
    promptOptimizePreviewPanel.classList.add('hidden');
    originalPromptPreview.textContent = '';
    optimizedPromptPreview.textContent = '';
    optimizedCandidateText = '';
  }

  function applyOptimizedPrompt() {
    if (!optimizedCandidateText) {
      closeOptimizePreviewPanel();
      return;
    }
    promptContentInput.value = optimizedCandidateText;
    closeOptimizePreviewPanel();
    showToast('已替换为优化结果');
  }

  function exportChatToTxt(tabId, mode = 'all', includeReasoning = true) {
    const msgs = tabData.list[tabId].messages || [];
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
      
      const roleName = m.role === 'user' ? '我' : 'DeepSeek';
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
    const msgs = tabData.list[tabId].messages || [];
    if (msgs.length === 0) {
      alert("当前对话为空，无法导出。");
      return;
    }
    pendingDownloadTabId = tabId;
    includeReasoningToggle.checked = true;
    downloadPanel.classList.remove("hidden");
  }

  function closeDownloadPanel() {
    downloadPanel.classList.add("hidden");
    pendingDownloadTabId = null;
  }

  function renderTabs() {
    tabsEl.innerHTML = "";
    const tabIds = Object.keys(tabData.list);
    if (tabIds.length === 0) {
      tabData.list = { tab1: { messages: [], title: "" } };
      tabData.active = "tab1";
      saveTabs();
    }

    Object.keys(tabData.list).forEach(id => {
      const tabDiv = document.createElement("div");
      tabDiv.className = `tab ${id === tabData.active ? "active" : ""}`;
      tabDiv.innerHTML = `
        <span class="tab-title" title="${escapeHtml(getTabDisplayName(id))}">${escapeHtml(getTabDisplayName(id))}</span>
        <div class="tab-actions">
          <span class="tab-btn tab-rename" data-id="${id}" title="修改会话名称">${renameIconSvg}</span>
          <span class="tab-btn tab-export" data-id="${id}" title="导出对话">${downloadIconSvg}</span>
          <span class="tab-btn tab-del" data-id="${id}" title="删除对话">×</span>
        </div>
      `;
      tabDiv.addEventListener("click", (e) => {
        if (e.target.closest('.tab-del') || e.target.closest('.tab-export') || e.target.closest('.tab-rename')) return;
        tabData.active = id;
        saveTabs();
        renderChat();
        renderTabs();
        updateInputCounter();
        if(window.innerWidth < 768) closeSidebar();
      });
      tabsEl.appendChild(tabDiv);
    });

    document.querySelectorAll(".tab-rename").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const tabId = btn.dataset.id;
        openRenameTabPanel(tabId);
      });
    });

    document.querySelectorAll(".tab-export").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const exportId = btn.dataset.id;
        openDownloadPanel(exportId);
      });
    });

    document.querySelectorAll(".tab-del").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const delId = btn.dataset.id;
        if (confirm(`确定删除「${getTabDisplayName(delId)}」吗？删除后记录将永久消失！`)) {
          delete tabData.list[delId];

          const remainingTabIds = Object.keys(tabData.list);
          if (remainingTabIds.length === 0) {
            const newId = createNewTab();
            tabData.active = newId;
            return;
          }

          if (delId === tabData.active) {
            tabData.active = remainingTabIds[0];
          }
          saveTabs();
          renderChat();
          renderTabs();
          updateInputCounter();
        }
      });
    });
  }

  function copyText(text) {
    if (!text) return alert("暂无内容可复制");
    
    // 优先使用现代剪贴板API
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(() => {
        console.log("复制成功");
      }).catch(err => {
        // 如果现代API失败，尝试兼容性方法
        fallbackCopyText(text);
      });
    } else {
      // 使用兼容性方法
      fallbackCopyText(text);
    }
  }

  function fallbackCopyText(text) {
    try {
      const textArea = document.createElement("textarea");
      textArea.value = text;
      textArea.style.position = "fixed";
      textArea.style.left = "-999999px";
      textArea.style.top = "-999999px";
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      
      const successful = document.execCommand('copy');
      textArea.remove();
      
      if (successful) {
        console.log("复制成功");
      } else {
        alert("复制失败，请手动复制！");
      }
    } catch (err) {
      alert("复制失败，请手动复制！");
      console.error("复制错误：", err);
    }
  }

  function getLastUserMessageIndex() {
    const currentMsgs = tabData.list[tabData.active].messages || [];
    for (let i = currentMsgs.length - 1; i >= 0; i--) {
      if (currentMsgs[i].role === 'user') return i;
    }
    return -1;
  }

  function scrollToBottom() {
    chat.scrollTo({ top: chat.scrollHeight, behavior: 'smooth' });
  }

  function checkScrollButton() {
    const distanceFromBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight;
    if (distanceFromBottom > 200) {
      scrollToBottomBtn.classList.add('visible');
    } else {
      scrollToBottomBtn.classList.remove('visible');
    }
  }

  function editUserMessage(messageIndex) {
    const currentMsgs = tabData.list[tabData.active].messages || [];
    if (messageIndex < 0 || messageIndex >= currentMsgs.length) return alert("消息索引无效。");
    const targetMessage = currentMsgs[messageIndex];
    if (targetMessage.role !== 'user') return alert("只能编辑用户消息。");

    editingMessageIndex = messageIndex;
    editTextarea.value = targetMessage.content;
    editPanel.classList.remove("hidden");
    editTextarea.focus();
  }

  function regenerateResponse(messageIndex) {
    if (!apiKey) { keyPanel.classList.remove("hidden"); return; }
    const currentMsgs = tabData.list[tabData.active].messages || [];
    if (currentMsgs.length === 0) return alert("当前对话为空，无法重新生成。");
    if (messageIndex < 0 || messageIndex >= currentMsgs.length) return alert("消息索引无效。");
    const targetMessage = currentMsgs[messageIndex];
    if (targetMessage.role !== 'assistant') return alert("只能重新生成AI的回复。");

    fetchAndStreamResponse({ regenerateIndex: messageIndex });
  }

  function renderMarkdown(el, text) {
    if (!text) {
      el.innerHTML = '';
      return;
    }
    const rawHtml = marked.parse(text);
    const safeHtml = DOMPurify.sanitize(rawHtml);
    el.innerHTML = safeHtml;
  }

  function countChars(text) {
    return String(text || '').replace(/\s/g, '').length;
  }

  function estimateTokensByChars(charCount) {
    return Math.ceil(charCount / 1.5);
  }

  function estimateTokensByText(text) {
    return estimateTokensByChars(countChars(text));
  }

  function buildPayloadMessages(messages, endExclusive = messages.length) {
    let payloadMsgs = messages.slice(0, endExclusive).map(m => ({
      role: m.role,
      content: m.content
    }));

    const limit = parseInt(globalMemoryLimit || "0");
    if (limit > 0 && payloadMsgs.length > limit) {
      payloadMsgs = payloadMsgs.slice(-limit);
    }

    return payloadMsgs;
  }

  function buildUserInputMeta(messages, userIndex) {
    const currentMessage = messages[userIndex];
    if (!currentMessage || currentMessage.role !== 'user') return null;

    const payloadMsgs = buildPayloadMessages(messages, userIndex + 1);
    const inputChars = countChars(currentMessage.content);
    const inputTokens = estimateTokensByChars(inputChars);
    const historyTokens = payloadMsgs
      .slice(0, -1)
      .reduce((sum, msg) => sum + estimateTokensByText(msg.content), 0);

    return {
      inputChars,
      inputTokens,
      historyTokens,
      totalInputTokens: inputTokens + historyTokens
    };
  }

  function renderChat() {
    const currentMsgs = tabData.list[tabData.active].messages || [];
    const lastUserMsgIndex = getLastUserMessageIndex();

    chat.innerHTML = "";

    currentMsgs.forEach((m, i) => {
      const isUser = m.role === 'user';
      const isAssistant = m.role === 'assistant';
      const isLastAssistant = isAssistant && i === currentMsgs.length - 1;
      const isLastUserMessage = i === lastUserMsgIndex;

      const msgBox = document.createElement("div");
      msgBox.id = `msg-${i}`;
      msgBox.className = `message-box p-3 rounded-xl ${isUser?'bg-blue-600 ml-auto':'bg-gray-800 mr-auto'} max-w-[85%] text-white`;

      let buttonsHtml = `<button class="delete-btn" data-index="${i}" title="删除">${deleteIconSvg}</button>`;
      if (isAssistant) {
        buttonsHtml += `<button class="copy-btn" data-index="${i}" title="复制">${copyIconSvg}</button>`;
        if (isLastAssistant) buttonsHtml += `<button class="regenerate-btn" data-index="${i}" title="重新生成">↻</button>`;
      } else if (isUser) {
        buttonsHtml += `<button class="copy-btn" data-index="${i}" title="复制">${copyIconSvg}</button>`;
        if (isLastUserMessage) buttonsHtml += `<button class="edit-btn" data-index="${i}" title="编辑">✎</button>`;
      }

      let versionHtml = '';
      if (isAssistant && m.history && m.history.length > 1) {
        const hIndex = m.historyIndex || 0;
        const isFirst = hIndex === 0;
        const isLast = hIndex === m.history.length - 1;
        versionHtml = `
          <div class="version-control">
            <span class="version-btn prev-version-btn ${isFirst ? 'disabled' : ''}" data-index="${i}">❮</span>
            <span>${hIndex + 1} / ${m.history.length}</span>
            <span class="version-btn next-version-btn ${isLast ? 'disabled' : ''}" data-index="${i}">❯</span>
          </div>
        `;
      }

      msgBox.innerHTML = versionHtml + buttonsHtml;

      if (isAssistant && m.reasoningContent) {
        const details = document.createElement('details');
        details.className = "reasoning-details mb-2 border border-gray-700 rounded-lg p-2 bg-gray-900";
        details.open = true;
        details.innerHTML = `<summary class="text-xs text-gray-400 cursor-pointer select-none outline-none">思考过程</summary>`;
        const reasoningDiv = document.createElement('div');
        reasoningDiv.className = "reasoning-content prose prose-invert max-w-none text-sm text-gray-400 mt-2 border-t border-gray-700 pt-2";
        renderMarkdown(reasoningDiv, m.reasoningContent);
        details.appendChild(reasoningDiv);
        msgBox.appendChild(details);
      }

      const contentDiv = document.createElement('div');
      contentDiv.className = "msg-content prose prose-invert max-w-none";
      renderMarkdown(contentDiv, m.content);
      msgBox.appendChild(contentDiv);

      if (isUser) {
        const userInputMeta = buildUserInputMeta(currentMsgs, i);
        if (userInputMeta) {
          const metaDiv = document.createElement('div');
          metaDiv.className = "message-meta user-input-meta mt-2 text-xs";
          metaDiv.textContent = `本次正文 ${userInputMeta.inputChars} 字，约 ${userInputMeta.inputTokens} tokens；历史记忆约 ${userInputMeta.historyTokens} tokens；本轮输入共约 ${userInputMeta.totalInputTokens} tokens`;
          msgBox.appendChild(metaDiv);
        }
      }

      if (isAssistant) {
        const metaDiv = document.createElement('div');
        metaDiv.className = "message-meta assistant-meta mt-2 text-xs text-gray-400";
        const totalChars = countChars(m.reasoningContent) + countChars(m.content);
        const tokenEstimate = estimateTokensByChars(totalChars);
        metaDiv.textContent = `思考 ${countChars(m.reasoningContent)} 字，正文 ${countChars(m.content)} 字，约 ${tokenEstimate} tokens`;
        msgBox.appendChild(metaDiv);

        if (m.generationState === 'interrupted') {
          const statusDiv = document.createElement('div');
          statusDiv.className = "generation-status mt-1 text-xs text-amber-400";
          statusDiv.textContent = '生成中断，可重新生成';
          msgBox.appendChild(statusDiv);
        }
      }

      chat.appendChild(msgBox);
    });

    if (currentMsgs.length > 0 && isTokenLimitReached()) {
      const warningDiv = document.createElement("div");
      warningDiv.className = "text-xs text-gray-500 text-center mt-6 mb-4 px-2";
      warningDiv.innerHTML = `
        当前对话框上下文即将达到上限。建议总结并开启新对话，或调整对话记忆条数：<br>
        <div class="inline-block bg-gray-800 rounded p-2 mt-2 text-left border border-gray-700 relative pr-10 max-w-[90%] mx-auto">
          <span id="promptText" class="text-gray-400 break-all">请帮我把目前为止的故事剧情、出场人物设定、伏笔和当前的主线任务做一个极其详细的总结（约2000字）。</span>
          <button id="copyPromptBtn" class="absolute right-2 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-white bg-gray-700 rounded p-1 transition-colors" title="复制指令">
            ${copyIconSvg}
          </button>
        </div>
      `;
      chat.appendChild(warningDiv);

      const copyPromptBtn = warningDiv.querySelector('#copyPromptBtn');
      if (copyPromptBtn) {
        copyPromptBtn.addEventListener('click', function() {
          const text = document.getElementById('promptText').innerText;
          copyText(text);
          const originalHtml = this.innerHTML;
          this.innerHTML = checkIconSvg;
          setTimeout(() => { this.innerHTML = originalHtml; }, 1500);
        });
      }
    }

    document.querySelectorAll('.copy-btn').forEach(btn => {
      btn.addEventListener('click', function() {
        const index = parseInt(this.getAttribute('data-index'));
        const currentMsgs = tabData.list[tabData.active].messages || [];
        if (currentMsgs[index]) copyText(currentMsgs[index].content);

        const originalHtml = this.innerHTML;
        this.innerHTML = checkIconSvg;
        setTimeout(() => { this.innerHTML = originalHtml; }, 1500);
      });
    });

    document.querySelectorAll('.edit-btn').forEach(btn => {
      btn.addEventListener('click', function() {
        const index = parseInt(this.getAttribute('data-index'));
        editUserMessage(index);
      });
    });

    document.querySelectorAll('.regenerate-btn').forEach(btn => {
      btn.addEventListener('click', function() {
        const index = parseInt(this.getAttribute('data-index'));
        regenerateResponse(index);
      });
    });

    document.querySelectorAll('.delete-btn').forEach(btn => {
      btn.addEventListener('click', function() {
        const index = parseInt(this.getAttribute('data-index'));
        if (confirm("确定删除这条消息吗？")) {
          tabData.list[tabData.active].messages.splice(index, 1);
          saveTabs();
          renderChat();
        }
      });
    });

    document.querySelectorAll('.prev-version-btn').forEach(btn => {
      btn.addEventListener('click', function() {
        if (this.classList.contains('disabled')) return;
        const index = parseInt(this.getAttribute('data-index'));
        const msg = tabData.list[tabData.active].messages[index];
        if (msg.historyIndex > 0) {
          msg.historyIndex--;
          msg.content = msg.history[msg.historyIndex].content;
          msg.reasoningContent = msg.history[msg.historyIndex].reasoningContent;
          msg.generationState = msg.history[msg.historyIndex].state || 'complete';
          saveTabs();
          renderChat();
        }
      });
    });

    document.querySelectorAll('.next-version-btn').forEach(btn => {
      btn.addEventListener('click', function() {
        if (this.classList.contains('disabled')) return;
        const index = parseInt(this.getAttribute('data-index'));
        const msg = tabData.list[tabData.active].messages[index];
        if (msg.historyIndex < msg.history.length - 1) {
          msg.historyIndex++;
          msg.content = msg.history[msg.historyIndex].content;
          msg.reasoningContent = msg.history[msg.historyIndex].reasoningContent;
          msg.generationState = msg.history[msg.historyIndex].state || 'complete';
          saveTabs();
          renderChat();
        }
      });
    });

    chat.scrollTop = chat.scrollHeight;
    setTimeout(checkScrollButton, 50);
    
    // 检查是否需要显示空对话提示
    if (currentMsgs.length === 0) {
      showEmptyChatHint();
    } else {
      hideEmptyChatHint();
    }
  }

  async function saveEditAndRegenerate() {
    const newContent = editTextarea.value.trim();
    if (!newContent) return alert("消息内容不能为空！");
    const currentMsgs = tabData.list[tabData.active].messages || [];
    if (editingMessageIndex < 0 || editingMessageIndex >= currentMsgs.length) return alert("编辑的消息不存在。");

    currentMsgs[editingMessageIndex].content = newContent;
    const messagesToKeep = currentMsgs.slice(0, editingMessageIndex + 1);
    if (messagesToKeep[editingMessageIndex]?.role === 'user') {
      messagesToKeep[editingMessageIndex].inputMeta = buildUserInputMeta(messagesToKeep, editingMessageIndex);
    }
    tabData.list[tabData.active].messages = messagesToKeep;
    saveTabs();

    editPanel.classList.add("hidden");
    editingMessageIndex = -1;
    renderChat();
    await fetchAndStreamResponse();
  }

  function cancelEdit() {
    editPanel.classList.add("hidden");
    editingMessageIndex = -1;
  }

  function autoHeight() {
    input.style.height = "44px";
    const scrollH = input.scrollHeight;
    input.style.height = Math.min(Math.max(scrollH, 44), 88) + "px";
  }

  function updateInputCounter() {
    const text = input.value;
    const charCount = text.length;
    const tokenEstimate = estimateTokensByChars(charCount);
    if (charCount > 0) {
      inputCounter.textContent = `${charCount} 字 / 约 ${tokenEstimate} tokens`;
    } else {
      inputCounter.textContent = "0 字";
    }
  }

  async function generateTitleForCurrentTab() {
    const currentMsgs = tabData.list[tabData.active].messages || [];
    if (currentMsgs.length < 2) return;
    
    const firstUserMsg = currentMsgs.find(m => m.role === 'user');
    if (!firstUserMsg) return;
    
    try {
      const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: "deepseek-chat",
          messages: [
            { role: "user", content: `请为以下对话生成一个简洁、描述性的标题（不超过 15 个字）。只返回标题，不要其他内容。\n\n用户消息：${firstUserMsg.content}` }
          ],
          stream: false,
          temperature: 0.5,
          max_tokens: 50
        })
      });

      if (res.ok) {
        const data = await res.json();
        let title = data?.choices?.[0]?.message?.content || '';
        title = title.trim().replace(/^["「『]|["」』]$/g, '');
        if (title && title.length <= 30) {
          tabData.list[tabData.active].title = title;
          saveTabs();
          renderTabs();
        }
      }
    } catch (e) {
      console.log('生成标题失败，不影响功能', e);
    }
  }

  input.addEventListener("input", () => {
    autoHeight();
    updateInputCounter();
  });
  autoHeight();
  updateInputCounter();

  function createNewTab() {
    const tabIds = Object.keys(tabData.list);
    let maxIdNum = 0;
    tabIds.forEach(id => {
      const num = parseInt(id.replace('tab', ''), 10);
      if (num > maxIdNum) maxIdNum = num;
    });

    const newId = `tab${maxIdNum + 1}`;
    tabData.list[newId] = { messages: [], title: "" };
    tabData.active = newId;
    saveTabs();
    renderChat();
    renderTabs();
    updateInputCounter();
    
    // 新对话显示提示
    showEmptyChatHint();
    
    return newId;
  }

  addTab.onclick = () => {
    createNewTab();
    closeSidebar();
    input.focus();
  };

  async function fetchAndStreamResponse(opts = {}) {
    isSending = true;
    sendBtn.textContent = "停止";
    sendBtn.classList.add("stop-mode");

    abortReason = null;
    abortController = new AbortController();
    trackEvent('发送消息');

    const currentMsgs = tabData.list[tabData.active].messages || [];
    const isRegen = opts.regenerateIndex !== undefined;
    const targetIndex = isRegen ? opts.regenerateIndex : currentMsgs.length;
    const selectedModel = modelSelect.value;

    const payloadMsgs = buildPayloadMessages(currentMsgs, isRegen ? targetIndex : currentMsgs.length);

    const isAtBottom = chat.scrollTop + chat.clientHeight >= chat.scrollHeight - 20;
    let aiMsgDiv;

    if (isRegen) {
      aiMsgDiv = document.getElementById(`msg-${targetIndex}`);
      if (!currentMsgs[targetIndex].history) {
        currentMsgs[targetIndex].history = [{ content: currentMsgs[targetIndex].content, reasoningContent: currentMsgs[targetIndex].reasoningContent || "", state: currentMsgs[targetIndex].generationState || 'complete' }];
        currentMsgs[targetIndex].historyIndex = 0;
      }
      currentMsgs[targetIndex].history.push({ content: "", reasoningContent: "", state: "generating" });
      currentMsgs[targetIndex].historyIndex = currentMsgs[targetIndex].history.length - 1;
      currentMsgs[targetIndex].content = "";
      currentMsgs[targetIndex].reasoningContent = "";
      currentMsgs[targetIndex].generationState = "generating";

      const contentDiv = aiMsgDiv.querySelector('.msg-content');
      if (contentDiv) contentDiv.textContent = "";
      const reasoningDetails = aiMsgDiv.querySelector('.reasoning-details');
      if (reasoningDetails) reasoningDetails.remove();
      const metaEl = aiMsgDiv.querySelector('.assistant-meta');
      if (metaEl) metaEl.remove();
      const statusEl = aiMsgDiv.querySelector('.generation-status');
      if (statusEl) statusEl.remove();
    } else {
      aiMsgDiv = document.createElement("div");
      aiMsgDiv.id = `msg-${targetIndex}`;
      aiMsgDiv.className = "message-box p-3 rounded-xl bg-gray-800 mr-auto max-w-[85%] text-white";
      aiMsgDiv.innerHTML = `<button class="copy-btn" title="复制">${copyIconSvg}</button><div class="msg-content prose prose-invert max-w-none"></div>`;

      const promptWarning = chat.querySelector('.text-xs.text-gray-500.text-center');
      if (promptWarning) {
        chat.insertBefore(aiMsgDiv, promptWarning);
      } else {
        chat.appendChild(aiMsgDiv);
      }
    }

    if (isAtBottom) chat.scrollTop = chat.scrollHeight;

    let fullContent = "";
    let fullReasoningContent = "";
    let hasReasoning = false;
    let reasoningContentDiv = null;
    let finalizeState = "complete";

    function markInterrupted() {
      finalizeState = "interrupted";
    }

    function isBackgroundRelatedError(err) {
      if (abortReason === "background") return true;
      if (Date.now() - lastPageHiddenAt > 6000) return false;
      const msg = String(err && err.message ? err.message : "");
      if (!msg) return true;
      return /(load failed|failed to fetch|networkerror|cancelled|canceled)/i.test(msg);
    }

    try {
      const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
          "Cache-Control": "no-cache",
          "Pragma": "no-cache"
        },
        body: JSON.stringify({
          model: selectedModel,
          messages: payloadMsgs,
          stream: true,
          temperature: 0.7,
          max_tokens: 4096
        }),
        signal: abortController.signal
      });

      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(`API请求失败：${errorData.error?.message || '请检查API Key是否有效'}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");

        buffer = lines.pop();

        for (const line of lines) {
          if (line.trim() === "") continue;
          if (!line.startsWith("data: ")) continue;

          const dataStr = line.slice(6);
          if (dataStr === "[DONE]") {
            finalizeMessage(finalizeState);
            return;
          }

          try {
            const data = JSON.parse(dataStr);
            const delta = data.choices[0].delta;

            if (delta.reasoning_content) {
              if (!hasReasoning) {
                hasReasoning = true;
                const details = document.createElement('details');
                details.className = "reasoning-details mb-2 border border-gray-700 rounded-lg p-2 bg-gray-900";
                details.open = true;
                details.innerHTML = `<summary class="text-xs text-gray-400 cursor-pointer select-none outline-none">思考过程</summary><div class="reasoning-content prose prose-invert max-w-none text-sm text-gray-400 mt-2 border-t border-gray-700 pt-2"></div>`;
                const msgContentDiv = aiMsgDiv.querySelector('.msg-content');
                aiMsgDiv.insertBefore(details, msgContentDiv);
                reasoningContentDiv = details.querySelector('.reasoning-content');
              }
              fullReasoningContent += delta.reasoning_content;
              renderMarkdown(reasoningContentDiv, fullReasoningContent);
            }

            if (delta.content) {
              fullContent += delta.content;
              const contentDiv = aiMsgDiv.querySelector('.msg-content');
              if (contentDiv) {
                renderMarkdown(contentDiv, fullContent);
              }
            }

            const currentIsAtBottom = chat.scrollTop + chat.clientHeight >= chat.scrollHeight - 20;
            if (currentIsAtBottom) chat.scrollTop = chat.scrollHeight;
          } catch (e) {
            continue;
          }
        }
      }
      finalizeMessage(finalizeState);

    } catch (e) {
      if (e.name === 'AbortError') {
        if (abortReason === 'background' || abortReason === 'manual') markInterrupted();
        finalizeMessage(finalizeState);
      } else if (isBackgroundRelatedError(e)) {
        markInterrupted();
        finalizeMessage(finalizeState);
      } else {
        const contentDiv = aiMsgDiv.querySelector('.msg-content');
        if (contentDiv) {
          contentDiv.innerHTML = `<span class="text-red-400">❌ 错误：${e.message}</span>`;
        }
        console.error("发送消息错误：", e);

        if (e.message.includes("API请求失败") || e.message.includes("Key")) {
          setTimeout(() => {
            if (confirm("检测到API Key可能无效，是否立即修改？")) {
              openSettingsPanel();
            }
          }, 1000);
        }
      }
    } finally {
      isSending = false;
      sendBtn.textContent = "发送";
      sendBtn.classList.remove("stop-mode");
      abortController = null;
    }

    function finalizeMessage(state = "complete") {
      if (isRegen) {
        currentMsgs[targetIndex].generationState = state;
        currentMsgs[targetIndex].content = fullContent;
        currentMsgs[targetIndex].reasoningContent = fullReasoningContent;
        currentMsgs[targetIndex].history[currentMsgs[targetIndex].historyIndex] = { content: fullContent, reasoningContent: fullReasoningContent, state };
      } else {
        currentMsgs.push({
          role: "assistant",
          content: fullContent,
          reasoningContent: fullReasoningContent,
          generationState: state,
          history: [{ content: fullContent, reasoningContent: fullReasoningContent, state }],
          historyIndex: 0
        });
      }
      tabData.list[tabData.active].messages = currentMsgs;
      saveTabs();
      renderChat();
    }
  }

  async function sendMessage() {
    const text = input.value.trim();
    if (!text) { input.focus(); return; }
    if (!apiKey) { keyPanel.classList.remove("hidden"); return; }

    const currentMsgs = tabData.list[tabData.active].messages || [];
    const isFirstMessage = currentMsgs.length === 0;
    currentMsgs.push({ role: "user", content: text });
    currentMsgs[currentMsgs.length - 1].inputMeta = buildUserInputMeta(currentMsgs, currentMsgs.length - 1);
    tabData.list[tabData.active].messages = currentMsgs;
    saveTabs();
    renderChat();

    input.value = "";
    autoHeight();
    updateInputCounter();
    await fetchAndStreamResponse();
    
    if (isFirstMessage) {
      generateTitleForCurrentTab();
    }
  }

  function openPromptPanel() {
    promptPanel.classList.remove('hidden');
    showPromptListView();
    renderPromptList();
  }

  function closePromptPanel() {
    promptPanel.classList.add('hidden');
  }

  function showPromptListView() {
    promptListView.classList.remove('hidden');
    promptFormView.classList.add('hidden');
    editingPromptId = null;
    promptTitleInput.value = '';
    promptContentInput.value = '';
  }

  function showPromptFormView(prompt = null) {
    promptListView.classList.add('hidden');
    promptFormView.classList.remove('hidden');

    if (prompt) {
      editingPromptId = prompt.id;
      promptTitleInput.value = prompt.title || '';
      promptContentInput.value = prompt.content || '';
    } else {
      editingPromptId = null;
      promptTitleInput.value = '';
      promptContentInput.value = '';
    }

    setTimeout(() => promptTitleInput.focus(), 50);
  }

  function renderPromptList() {
    promptList.innerHTML = '';

    if (!promptData.length) {
      promptList.innerHTML = `
        <div class="prompt-empty">
          <div class="text-base mb-2">还没有保存任何指令</div>
          <div class="text-sm text-gray-500">你可以新建一些常用指令，比如翻译、润色、总结、角色设定等。</div>
        </div>
      `;
      return;
    }

    promptData.forEach(item => {
      const div = document.createElement('div');
      div.className = 'prompt-item';

      const contentText = item.content || '';
      const preview = contentText.length > 100
        ? contentText.slice(0, 100) + '...'
        : contentText;

      div.innerHTML = `
        <div class="prompt-item-header">
          <div class="flex-1 min-w-0">
            <div class="prompt-title">${escapeHtml(item.title || '未命名指令')}</div>
            <div class="prompt-preview">${escapeHtml(preview)}</div>
          </div>
          <div class="prompt-actions">
            <button class="prompt-use-btn" data-id="${item.id}">新建会话并插入指令</button>
            <button class="prompt-icon-btn prompt-copy-btn" data-id="${item.id}" title="复制内容">${copyIconSvg}</button>
            <button class="prompt-icon-btn prompt-edit-btn2" data-id="${item.id}" title="编辑指令">${editIconSvg}</button>
            <button class="prompt-icon-btn prompt-delete-btn2 delete" data-id="${item.id}" title="删除指令">${deleteIconSvg}</button>
          </div>
        </div>
      `;

      promptList.appendChild(div);
    });

    document.querySelectorAll('.prompt-use-btn').forEach(btn => {
      btn.addEventListener('click', function() {
        const id = this.dataset.id;
        const item = promptData.find(p => p.id === id);
        if (!item) return;
        insertPromptToNewChat(item.content || '');
      });
    });

    document.querySelectorAll('.prompt-copy-btn').forEach(btn => {
      btn.addEventListener('click', function() {
        const id = this.dataset.id;
        const item = promptData.find(p => p.id === id);
        if (!item) return;
        copyText(item.content || '');
        const old = this.innerHTML;
        this.innerHTML = checkIconSvg;
        setTimeout(() => this.innerHTML = old, 1200);
      });
    });

    document.querySelectorAll('.prompt-edit-btn2').forEach(btn => {
      btn.addEventListener('click', function() {
        const id = this.dataset.id;
        const item = promptData.find(p => p.id === id);
        if (!item) return;
        showPromptFormView(item);
      });
    });

    document.querySelectorAll('.prompt-delete-btn2').forEach(btn => {
      btn.addEventListener('click', function() {
        const id = this.dataset.id;
        const item = promptData.find(p => p.id === id);
        if (!item) return;
        if (!confirm(`确定删除指令「${item.title || '未命名指令'}」吗？`)) return;
        promptData = promptData.filter(p => p.id !== id);
        savePrompts();
        renderPromptList();
      });
    });
  }

  function insertPromptToNewChat(text) {
    if (!text) return;
    createNewTab();
    input.value = text;
    autoHeight();
    closePromptPanel();
    closeSidebar();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function savePromptItem() {
    const rawTitle = promptTitleInput.value.trim();
    const title = rawTitle || '未命名指令';
    const content = promptContentInput.value.trim();

    if (!content) {
      alert('请输入指令内容');
      promptContentInput.focus();
      return;
    }

    if (editingPromptId) {
      const idx = promptData.findIndex(p => p.id === editingPromptId);
      if (idx > -1) {
        promptData[idx].title = title;
        promptData[idx].content = content;
        promptData[idx].updatedAt = Date.now();
      }
    } else {
      promptData.unshift({
        id: 'prompt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        title,
        content,
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
    }

    savePrompts();
    showPromptListView();
    renderPromptList();
  }

  openPromptManagerBtn.addEventListener('click', () => {
    closeSidebar();
    openPromptPanel();
  });

  closePromptPanelBtn.addEventListener('click', closePromptPanel);
  promptPanel.addEventListener('click', (e) => {
    if (e.target === promptPanel) closePromptPanel();
  });

  addPromptBtn.addEventListener('click', () => showPromptFormView());
  cancelPromptEditBtn.addEventListener('click', showPromptListView);
  savePromptBtn.addEventListener('click', savePromptItem);
  optimizePromptBtn.addEventListener('click', optimizePromptWithAI);

  renameTabCancelBtn.addEventListener('click', closeRenameTabPanel);
  renameTabSaveBtn.addEventListener('click', saveRenamedTab);
  renameTabPanel.addEventListener('click', (e) => {
    if (e.target === renameTabPanel) closeRenameTabPanel();
  });
  renameTabInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveRenamedTab();
  });

  confirmCancelBtn.addEventListener('click', () => closeConfirmModal(false));
  confirmOkBtn.addEventListener('click', () => closeConfirmModal(true));
  confirmPanel.addEventListener('click', (e) => {
    if (e.target === confirmPanel) closeConfirmModal(false);
  });

  discardOptimizedPromptBtn.addEventListener('click', closeOptimizePreviewPanel);
  applyOptimizedPromptBtn.addEventListener('click', applyOptimizedPrompt);
  promptOptimizePreviewPanel.addEventListener('click', (e) => {
    if (e.target === promptOptimizePreviewPanel) closeOptimizePreviewPanel();
  });

  sendBtn.addEventListener("click", () => {
    if (isSending) {
      abortStreaming('manual');
    } else {
      sendMessage();
    }
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!isSending) {
        sendMessage();
      }
    }
  });

  editCancelBtn.addEventListener("click", cancelEdit);
  editSaveBtn.addEventListener("click", saveEditAndRegenerate);
  editPanel.addEventListener("click", function(e) { if (e.target === editPanel) cancelEdit(); });

  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      if (!editPanel.classList.contains('hidden')) cancelEdit();
      if (!renameTabPanel.classList.contains('hidden')) closeRenameTabPanel();
      if (!confirmPanel.classList.contains('hidden')) closeConfirmModal(false);
      if (!promptOptimizePreviewPanel.classList.contains('hidden')) closeOptimizePreviewPanel();
      if (!promptPanel.classList.contains('hidden')) closePromptPanel();
    }
  });

  scrollToBottomBtn.addEventListener("click", scrollToBottom);
  chat.addEventListener("scroll", checkScrollButton);

  // 指令市场预设指令
  let MARKET_PROMPTS = [];

  // 从 prompt.txt 加载指令
  async function loadPromptsFromFile() {
    try {
      const response = await fetch('./prompt.txt');
      if (!response.ok) {
        throw new Error('无法加载 prompt.txt');
      }
      const text = await response.text();
      const parts = text.split('##########');
      MARKET_PROMPTS = parts
        .map(part => part.trim())
        .filter(part => part.length > 0)
        .map(content => ({ content }));
    } catch (e) {
      console.error('加载 prompt.txt 失败，使用默认指令', e);
      // 如果加载失败，使用默认指令
      MARKET_PROMPTS = [
        { content: "请与我对话..." }
      ];
    }
  }

  // 指令市场相关元素
  const openPromptMarketBtn = document.getElementById('openPromptMarketBtn');
  const promptMarketPanel = document.getElementById('promptMarketPanel');
  const closePromptMarketBtn = document.getElementById('closePromptMarketBtn');
  const refreshPromptMarketBtn = document.getElementById('refreshPromptMarketBtn');
  const promptMarketContent = document.getElementById('promptMarketContent');
  const saveToPromptManagerBtn = document.getElementById('saveToPromptManagerBtn');
  const createChatWithPromptBtn = document.getElementById('createChatWithPromptBtn');

  // 智能生成指令相关元素
  const aiGeneratePromptBtn = document.getElementById('aiGeneratePromptBtn');
  const aiGeneratePromptPanel = document.getElementById('aiGeneratePromptPanel');
  const closeAiGenerateBtn = document.getElementById('closeAiGenerateBtn');
  const cancelAiGenerateBtn = document.getElementById('cancelAiGenerateBtn');
  const confirmAiGenerateBtn = document.getElementById('confirmAiGenerateBtn');
  const aiPromptInput = document.getElementById('aiPromptInput');
  const aiGenerateBtnText = document.getElementById('aiGenerateBtnText');
  const aiGenerateSpinner = document.getElementById('aiGenerateSpinner');

  let currentMarketPrompt = null;
  let lastShownPromptIndex = -1;

  // 空对话提示相关元素
  const emptyChatHint = document.getElementById('emptyChatHint');
  const openMarketFromHint = document.getElementById('openMarketFromHint');

  // 显示/隐藏空对话提示
  function showEmptyChatHint() {
    emptyChatHint.classList.remove('hidden');
  }

  function hideEmptyChatHint() {
    emptyChatHint.classList.add('hidden');
  }



  // 随机获取一个指令
  function getRandomPrompt() {
    let newIndex;
    do {
      newIndex = Math.floor(Math.random() * MARKET_PROMPTS.length);
    } while (newIndex === lastShownPromptIndex && MARKET_PROMPTS.length > 1);
    
    lastShownPromptIndex = newIndex;
    return MARKET_PROMPTS[newIndex];
  }

  // 渲染指令市场内容
  function renderMarketPrompt() {
    currentMarketPrompt = getRandomPrompt();
    promptMarketContent.value = currentMarketPrompt.content;
  }

  // 刷新指令市场（带动画效果）
  function refreshMarketPrompt() {
    refreshPromptMarketBtn.classList.add('spinning');
    setTimeout(() => {
      renderMarketPrompt();
      refreshPromptMarketBtn.classList.remove('spinning');
    }, 300);
  }

  // 智能生成标题
  function generatePromptTitle(content) {
    const cleanContent = content.trim();
    
    // 移除常见的开头词
    let text = cleanContent
      .replace(/^(请|现在|咱们|我们|你是|我是|来玩|假设|假如|如果)\s*/, '')
      .replace(/^(【|「|『)/, '')
      .replace(/^(》|」|』)/, '');
    
    // 提取第一句（句号、感叹号、问号或换行之前的内容）
    let firstSentence = text.split(/[。！？\n]/)[0].trim();
    
    // 如果没有有效内容，使用未命名指令
    if (!firstSentence || firstSentence.length === 0) {
      return '未命名指令';
    }
    
    // 对于角色扮演类内容，提取角色
    if (firstSentence.includes('扮演') || firstSentence.includes('是一个') || firstSentence.includes('是我的')) {
      const roleMatch = firstSentence.match(/扮演(.+?)(，|。|！|$)/) || 
                        firstSentence.match(/是一个(.+?)(，|。|！|$)/) ||
                        firstSentence.match(/是我的(.+?)(，|。|！|$)/);
      if (roleMatch && roleMatch[1]) {
        const role = roleMatch[1].trim();
        if (role.length <= 10) {
          return role;
        }
      }
    }
    
    // 对于游戏类内容，尝试提取游戏名称
    if (firstSentence.includes('游戏') || firstSentence.includes('挑战') || firstSentence.includes('玩')) {
      const gameMatch = firstSentence.match(/(?:来玩|玩|我们玩|来玩一个|玩一个)?(.+?)(?:游戏|挑战|小游戏)(，|。|！|$)/);
      if (gameMatch && gameMatch[1]) {
        const gameName = gameMatch[1].trim();
        if (gameName && gameName.length > 0) {
          return gameName.length <= 15 ? gameName : gameName.substring(0, 15) + '...';
        }
      }
    }
    
    // 默认返回前15个字
    let title = firstSentence;
    if (title.length > 15) {
      title = title.substring(0, 15) + '...';
    }
    
    return title || '未命名指令';
  }

  // 保存到指令管理
  function saveCurrentPromptToManager() {
    const content = promptMarketContent.value.trim();
    if (!content) {
      showToast('指令内容不能为空');
      return;
    }
    
    const title = generatePromptTitle(content);
    
    promptData.unshift({
      id: 'prompt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      title: title,
      content: content,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    
    savePrompts();
    showToast('已保存到指令管理');
  }

  // 新建对话并插入指令
  function createChatWithMarketPrompt() {
    const content = promptMarketContent.value.trim();
    if (!content) {
      showToast('指令内容不能为空');
      return;
    }
    
    createNewTab();
    input.value = content;
    autoHeight();
    closePromptMarketPanel();
    closeSidebar();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  // 打开指令市场面板
  async function openPromptMarketPanel() {
    promptMarketPanel.classList.remove('hidden');
    // 如果还没有加载指令，先加载
    if (MARKET_PROMPTS.length === 0) {
      await loadPromptsFromFile();
    }
    renderMarketPrompt();
  }

  // 关闭指令市场面板
  function closePromptMarketPanel() {
    promptMarketPanel.classList.add('hidden');
  }

  // 事件监听
  openPromptMarketBtn.addEventListener('click', () => {
    closeSidebar();
    openPromptMarketPanel();
  });

  // 空对话提示点击打开指令市场
  openMarketFromHint.addEventListener('click', () => {
    openPromptMarketPanel();
  });

  closePromptMarketBtn.addEventListener('click', closePromptMarketPanel);
  promptMarketPanel.addEventListener('click', (e) => {
    if (e.target === promptMarketPanel) closePromptMarketPanel();
  });

  refreshPromptMarketBtn.addEventListener('click', refreshMarketPrompt);
  saveToPromptManagerBtn.addEventListener('click', saveCurrentPromptToManager);
  createChatWithPromptBtn.addEventListener('click', createChatWithMarketPrompt);

  // ESC键关闭
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      if (!promptMarketPanel.classList.contains('hidden')) closePromptMarketPanel();
      if (!aiGeneratePromptPanel.classList.contains('hidden')) closeAiGeneratePanel();
    }
  });

  // 智能生成指令相关函数
  function openAiGeneratePanel() {
    aiPromptInput.value = '';
    aiGeneratePromptPanel.classList.remove('hidden');
    setTimeout(() => aiPromptInput.focus(), 50);
  }

  function closeAiGeneratePanel() {
    aiGeneratePromptPanel.classList.add('hidden');
  }

  async function generatePromptWithAI() {
    const userInput = aiPromptInput.value.trim();
    if (!userInput) {
      alert('请输入关键词或描述');
      aiPromptInput.focus();
      return;
    }

    if (!apiKey) {
      keyPanel.classList.remove("hidden");
      return;
    }

    // 显示loading状态
    aiGenerateBtnText.textContent = '生成中...';
    aiGenerateSpinner.classList.remove('hidden');
    confirmAiGenerateBtn.disabled = true;

    try {
      const generatedPrompt = await requestGeneratedPrompt(userInput);
      if (!generatedPrompt || !generatedPrompt.trim()) {
        throw new Error('AI 未返回有效结果');
      }

      // 将生成的指令添加到指令市场，并显示
      currentMarketPrompt = { content: generatedPrompt.trim() };
      promptMarketContent.value = currentMarketPrompt.content;

      // 关闭生成面板
      closeAiGeneratePanel();

      showToast('指令生成成功！');
    } catch (e) {
      console.error(e);
      alert('AI 生成失败：' + e.message);
    } finally {
      // 恢复按钮状态
      aiGenerateBtnText.textContent = '生成指令';
      aiGenerateSpinner.classList.add('hidden');
      confirmAiGenerateBtn.disabled = false;
    }
  }

  async function requestGeneratedPrompt(userInput) {
    const messages = [
      {
        role: "user",
        content: `请生成跟AI进行角色扮演的prompt，仅生成Prompt（约80-120字），不要说别的。用户的输入为：${userInput}`
      }
    ];

    const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "Cache-Control": "no-cache",
        "Pragma": "no-cache"
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages,
        stream: false,
        temperature: 0.8,
        max_tokens: 300
      })
    });

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData.error?.message || '请求失败，请检查 API Key 或稍后重试');
    }

    const data = await res.json();
    let content = data?.choices?.[0]?.message?.content || '';

    content = String(content).trim()
      .replace(/^```[\w-]*\n?/i, '')
      .replace(/\n?```$/, '')
      .trim();

    return content;
  }

  // 智能生成指令事件监听
  aiGeneratePromptBtn.addEventListener('click', openAiGeneratePanel);
  closeAiGenerateBtn.addEventListener('click', closeAiGeneratePanel);
  cancelAiGenerateBtn.addEventListener('click', closeAiGeneratePanel);
  aiGeneratePromptPanel.addEventListener('click', (e) => {
    if (e.target === aiGeneratePromptPanel) closeAiGeneratePanel();
  });
  confirmAiGenerateBtn.addEventListener('click', generatePromptWithAI);

  // 页面加载时预加载指令
  loadPromptsFromFile();

  renderTabs();
  renderChat();
  setTimeout(checkScrollButton, 100);
  input.focus();
});
