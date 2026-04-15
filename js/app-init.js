// app-init.js - 初始化入口与全局事件
document.addEventListener('DOMContentLoaded', function() {
  'use strict';
  const App = window.App;

  // ========== DOM 元素引用 ==========
  const settingsPanel = document.getElementById('settingsPanel');
  const editPanel = document.getElementById('editPanel');
  const renameTabPanel = document.getElementById('renameTabPanel');
  const confirmPanel = document.getElementById('confirmPanel');
  const promptOptimizePreviewPanel = document.getElementById('promptOptimizePreviewPanel');
  const promptPanel = document.getElementById('promptPanel');
  const promptMarketPanel = document.getElementById('promptMarketPanel');
  const aiGeneratePromptPanel = document.getElementById('aiGeneratePromptPanel');
  const characterPanel = document.getElementById('characterPanel');
  const characterEditPanel = document.getElementById('characterEditPanel');
  const createGroupPanel = document.getElementById('createGroupPanel');
  const searchBox = document.getElementById('searchBox');
  const searchInput = document.getElementById('searchInput');
  const donatePanel = document.getElementById('donatePanel');
  const infoPanel = document.getElementById('infoPanel');
  const input = document.getElementById('input');

  // ========== 初始渲染 ==========
  App.renderTabs();
  App.renderChat();
  App.updateInputCounter();
  App.loadPromptsFromFile();
  setTimeout(function() {
    if (typeof App.checkScrollButton === 'function') App.checkScrollButton();
  }, 100);
  if (input) input.focus();

  // ========== 全局键盘事件 ==========

  // ESC 关闭所有面板（后打开的先关闭）
  document.addEventListener('keydown', function(e) {
    if (e.key !== 'Escape') return;

    // 搜索框
    if (searchBox && !searchBox.classList.contains('hidden')) {
      e.preventDefault();
      if (typeof App.closeSearch === 'function') App.closeSearch();
      return;
    }
    // AI 生成指令面板
    if (aiGeneratePromptPanel && !aiGeneratePromptPanel.classList.contains('hidden')) {
      e.preventDefault();
      if (typeof App.closeAiGeneratePanel === 'function') App.closeAiGeneratePanel();
      return;
    }
    // 指令市场面板
    if (promptMarketPanel && !promptMarketPanel.classList.contains('hidden')) {
      e.preventDefault();
      if (typeof App.closePromptMarketPanel === 'function') App.closePromptMarketPanel();
      return;
    }
    // 角色编辑面板
    if (characterEditPanel && !characterEditPanel.classList.contains('hidden')) {
      e.preventDefault();
      if (typeof App.hideCharacterEditForm === 'function') App.hideCharacterEditForm();
      return;
    }
    // 创建群聊面板
    if (createGroupPanel && !createGroupPanel.classList.contains('hidden')) {
      e.preventDefault();
      if (typeof App.closeCreateGroupPanel === 'function') App.closeCreateGroupPanel();
      return;
    }
    // 角色面板
    if (characterPanel && !characterPanel.classList.contains('hidden')) {
      e.preventDefault();
      if (typeof App.closeCharacterPanel === 'function') App.closeCharacterPanel();
      return;
    }
    // 指令优化预览面板
    if (promptOptimizePreviewPanel && !promptOptimizePreviewPanel.classList.contains('hidden')) {
      e.preventDefault();
      if (typeof App.closeOptimizePreviewPanel === 'function') App.closeOptimizePreviewPanel();
      return;
    }
    // 指令面板
    if (promptPanel && !promptPanel.classList.contains('hidden')) {
      e.preventDefault();
      if (typeof App.closePromptPanel === 'function') App.closePromptPanel();
      return;
    }
    // 确认对话框
    if (confirmPanel && !confirmPanel.classList.contains('hidden')) {
      e.preventDefault();
      if (typeof App.closeConfirmModal === 'function') App.closeConfirmModal(false);
      return;
    }
    // 重命名标签面板
    if (renameTabPanel && !renameTabPanel.classList.contains('hidden')) {
      e.preventDefault();
      if (typeof App.closeRenameTabPanel === 'function') App.closeRenameTabPanel();
      return;
    }
    // 编辑面板
    if (editPanel && !editPanel.classList.contains('hidden')) {
      e.preventDefault();
      if (typeof App.cancelEdit === 'function') App.cancelEdit();
      return;
    }
    // 设置面板
    if (settingsPanel && !settingsPanel.classList.contains('hidden')) {
      e.preventDefault();
      if (typeof App.closeSettingsPanel === 'function') App.closeSettingsPanel();
      return;
    }
    // 捐赠面板
    if (donatePanel && !donatePanel.classList.contains('hidden')) {
      e.preventDefault();
      donatePanel.classList.add('hidden');
      return;
    }
    // 信息面板
    if (infoPanel && !infoPanel.classList.contains('hidden')) {
      e.preventDefault();
      infoPanel.classList.add('hidden');
      return;
    }
  });

  // Ctrl+F 快捷键打开搜索
  document.addEventListener('keydown', function(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      if (typeof App.openSearch === 'function') App.openSearch();
    }
  });

  // ========== 页面可见性变化 ==========
  document.addEventListener('visibilitychange', function() {
    if (document.hidden) {
      App.lastPageHiddenAt = Date.now();
      if (App.isSending && App.abortController) {
        App.shouldToastOnVisible = true;
        if (typeof App.abortStreaming === 'function') App.abortStreaming('background');
      }
      return;
    }

    if (App.shouldToastOnVisible) {
      App.shouldToastOnVisible = false;
      if (typeof App.showToast === 'function') {
        App.showToast('已从后台返回：刚才的生成已中断，可点击"重新生成"继续');
      }
    }
  });

  // ========== 错误恢复 ==========
  window.addEventListener('error', function(e) {
    // 捕获未处理的错误，尝试恢复
    console.error('MyDeepSeek 运行时错误:', e.error || e.message);
  });

  // DOMContentLoaded 回调末尾的错误恢复（初始化失败时修复数据）
  try {
    // 验证 tabData 结构完整性
    if (App.tabData && App.tabData.list) {
      Object.keys(App.tabData.list).forEach(function(id) {
        const tab = App.tabData.list[id];
        if (Array.isArray(tab)) {
          // 旧格式：messages 直接是数组
          App.tabData.list[id] = { messages: tab, memoryLimit: '0', title: '' };
        } else {
          // 确保字段完整
          tab.messages = Array.isArray(tab.messages) ? tab.messages : [];
          tab.memoryLimit = tab.memoryLimit || '0';
          tab.title = tab.title || '';
          // 修复消息结构
          tab.messages.forEach(function(msg) {
            if (!msg.role) msg.role = 'user';
            if (!msg.content) msg.content = '';
            if (msg.history && typeof msg.history[0] === 'string') {
              msg.history = msg.history.map(function(c) {
                return { content: c, reasoningContent: '' };
              });
            }
            if (msg.historyIndex === undefined) msg.historyIndex = 0;
            if (!msg.generationState) msg.generationState = 'complete';
          });
        }
      });
      // 确保 active 指向有效的标签
      if (App.tabData.active && !App.tabData.list[App.tabData.active]) {
        const firstKey = Object.keys(App.tabData.list)[0];
        if (firstKey) App.tabData.active = firstKey;
      }
      App.saveTabs();
    }
  } catch (initErr) {
    console.error('MyDeepSeek 初始化失败:', initErr);
    try {
      const raw = localStorage.getItem('dsTabs');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.list && typeof parsed.list === 'object') {
        Object.keys(parsed.list).forEach(function(id) {
          const tab = parsed.list[id];
          if (Array.isArray(tab)) {
            parsed.list[id] = { messages: tab, memoryLimit: '0', title: '' };
          } else {
            tab.messages = Array.isArray(tab.messages) ? tab.messages : [];
            tab.memoryLimit = tab.memoryLimit || '0';
            tab.title = tab.title || '';
            tab.messages.forEach(function(msg) {
              if (!msg.role) msg.role = 'user';
              if (!msg.content) msg.content = '';
              if (msg.history && typeof msg.history[0] === 'string') {
                msg.history = msg.history.map(function(c) { return { content: c, reasoningContent: '' }; });
              }
              if (msg.historyIndex === undefined) msg.historyIndex = 0;
              if (!msg.generationState) msg.generationState = 'complete';
            });
          }
        });
        if (parsed.active && !parsed.list[parsed.active]) {
          const firstKey = Object.keys(parsed.list)[0];
          if (firstKey) parsed.active = firstKey;
        }
        localStorage.setItem('dsTabs', JSON.stringify(parsed));
        location.reload();
      } else {
        throw new Error('tabData 结构无效');
      }
    } catch (repairErr) {
      console.error('数据修复失败，执行重置:', repairErr);
      localStorage.removeItem('dsTabs');
      location.reload();
    }
  }
});
