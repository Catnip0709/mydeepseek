// app-storage.js - 数据存储与管理
(function() {
  'use strict';
  const App = window.App;

  // ========== 常量 ==========
  App.CHARACTER_STORAGE_KEY = 'dsCharacters';
  App.PROMPT_STORAGE_KEY = 'dsPrompts';
  App.MAX_CONTEXT_TOKENS = 131072;

  // ========== 初始化 tabData ==========
  try {
    App.tabData = JSON.parse(localStorage.getItem('dsTabs')) || (() => {
      const oldMsgs = JSON.parse(localStorage.getItem('dsMessages')) || [];
      return { active: 'tab1', list: { tab1: { messages: oldMsgs, memoryLimit: '0', title: '' } } };
    })();
  } catch (e) {
    App.tabData = { active: 'tab1', list: { tab1: { messages: [], memoryLimit: '0', title: '' } } };
  }

  // 兼容旧数据格式
  Object.keys(App.tabData.list).forEach(id => {
    if (Array.isArray(App.tabData.list[id])) {
      App.tabData.list[id] = { messages: App.tabData.list[id], memoryLimit: '0', title: '' };
    } else {
      if (typeof App.tabData.list[id].title === 'undefined') App.tabData.list[id].title = '';
      if (typeof App.tabData.list[id].memoryLimit === 'undefined') App.tabData.list[id].memoryLimit = '0';
      if (!Array.isArray(App.tabData.list[id].messages)) App.tabData.list[id].messages = [];
    }

    App.tabData.list[id].messages.forEach(msg => {
      if (msg.history && typeof msg.history[0] === 'string') {
        msg.history = msg.history.map(content => ({ content: content, reasoningContent: '' }));
      }
    });
  });

  // ========== 初始化 characterData ==========
  try {
    const rawCharData = JSON.parse(localStorage.getItem(App.CHARACTER_STORAGE_KEY));
    App.characterData = Array.isArray(rawCharData) ? rawCharData : [];
  } catch (e) {
    console.warn('dsCharacters 数据损坏，已重置:', e);
    App.characterData = [];
  }

  // ========== 初始化 promptData ==========
  try {
    const rawPromptData = JSON.parse(localStorage.getItem(App.PROMPT_STORAGE_KEY));
    App.promptData = Array.isArray(rawPromptData) ? rawPromptData : [];
  } catch (e) {
    console.warn('dsPrompts 数据损坏，已重置:', e);
    App.promptData = [];
  }

  // ========== 辅助函数 ==========
  App.formatBytes = function(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  };

  App.countChars = function(text) {
    return String(text || '').replace(/\s/g, '').length;
  };

  App.estimateTokensByChars = function(charCount) {
    return Math.ceil(charCount / 1.5);
  };

  App.estimateTokensByText = function(text) {
    return App.estimateTokensByChars(App.countChars(text));
  };

  // ========== 存储保存函数 ==========
  App.saveTabs = function() {
    localStorage.setItem('dsTabs', JSON.stringify(App.tabData));
    App.updateStorageUsage();
  };

  App.saveCharacters = function() {
    localStorage.setItem(App.CHARACTER_STORAGE_KEY, JSON.stringify(App.characterData));
    App.updateStorageUsage();
  };

  App.savePrompts = function() {
    localStorage.setItem(App.PROMPT_STORAGE_KEY, JSON.stringify(App.promptData));
    App.updateStorageUsage();
  };

  // ========== 存储用量 ==========
  App.updateStorageUsage = function() {
    let totalUsed = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key) {
        totalUsed += (localStorage.getItem(key) || '').length * 2; // UTF-16 每字符2字节
      }
    }
    const limit = 5 * 1024 * 1024; // 5MB
    const percent = Math.min(Math.round((totalUsed / limit) * 100), 100);
    const isWarning = percent >= 95;

    if (App.storageUsageText) {
      App.storageUsageText.textContent = '本地存储容量 ' + App.formatBytes(totalUsed) + '/5MB(' + percent + '%)';
    }

    if (isWarning) {
      if (App.storageUsageText) App.storageUsageText.classList.add('storage-warning');
      if (App.storageWarningIcon) App.storageWarningIcon.classList.remove('hidden');
    } else {
      if (App.storageUsageText) App.storageUsageText.classList.remove('storage-warning');
      if (App.storageWarningIcon) App.storageWarningIcon.classList.add('hidden');
    }
  };

  App.isStorageFull = function() {
    let totalUsed = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key) {
        totalUsed += (localStorage.getItem(key) || '').length * 2;
      }
    }
    return totalUsed / (5 * 1024 * 1024) >= 0.99;
  };

  // ========== Token 限制检测 ==========
  App.isTokenLimitReached = function() {
    const currentMsgs = App.tabData.list[App.tabData.active].messages || [];
    const payloadMsgs = App.buildPayloadMessages(currentMsgs);
    let estimatedTokens = 0;
    payloadMsgs.forEach(m => {
      estimatedTokens += App.estimateTokensByText(m.content);
    });
    return estimatedTokens >= App.MAX_CONTEXT_TOKENS * 0.98;
  };

  // ========== Tab 显示名 ==========
  App.getTabDisplayName = function(id) {
    const tab = App.tabData.list[id];
    if (!tab) return id;
    const customTitle = (tab.title || '').trim();
    return customTitle || '对话 ' + id.replace('tab', '');
  };

  // ========== 构建请求消息 ==========
  App.buildPayloadMessages = function(messages, endExclusive) {
    if (endExclusive === undefined) endExclusive = messages.length;
    let payloadMsgs = messages.slice(0, endExclusive).map(m => ({
      role: m.role,
      content: m.content
    }));

    const limit = parseInt(App.globalMemoryLimit || '0');
    if (limit > 0 && payloadMsgs.length > limit) {
      payloadMsgs = payloadMsgs.slice(-limit);
    }

    return payloadMsgs;
  };

  App.buildUserInputMeta = function(messages, userIndex) {
    const currentMessage = messages[userIndex];
    if (!currentMessage || currentMessage.role !== 'user') return null;

    const payloadMsgs = App.buildPayloadMessages(messages, userIndex + 1);
    const inputChars = App.countChars(currentMessage.content);
    const inputTokens = App.estimateTokensByChars(inputChars);
    const historyTokens = payloadMsgs
      .slice(0, -1)
      .reduce((sum, msg) => sum + App.estimateTokensByText(msg.content), 0);

    return {
      inputChars,
      inputTokens,
      historyTokens,
      totalInputTokens: inputTokens + historyTokens
    };
  };
})();
