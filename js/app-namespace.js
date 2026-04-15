// app-namespace.js - 全局共享命名空间
(function() {
  'use strict';

  // 生成用户唯一 ID
  const dsUserId = localStorage.getItem('dsUserId') || (function() {
    const id = 'u_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
    localStorage.setItem('dsUserId', id);
    return id;
  })();

  window.App = {
    // 用户 ID
    dsUserId: dsUserId,

    // API Key
    apiKey: localStorage.getItem('deepseekApiKey') || '',

    // 标签页数据
    tabData: null, // 在 app-storage.js 中初始化

    // 角色卡数据
    characterData: [],

    // 指令数据
    promptData: [],

    // 发送状态
    isSending: false,
    abortController: null,
    abortReason: null,
    editingMessageIndex: -1,

    // UI 状态
    lastPageHiddenAt: 0,
    shouldToastOnVisible: false,
    renamingTabId: null,
    confirmResolve: null,
    optimizedCandidateText: '',
    optimizeInProgress: false,
    searchQuery: '',
    searchResults: [],
    currentSearchIndex: -1,
    currentMarketPrompt: null,
    lastShownPromptIndex: -1,
    pendingDownloadTabId: null,
    selectedGroupCharacterIds: null,
    editingCharacterId: null,

    // 缓存
    _tabDomCache: {},
    _mdCache: new Map(),
    _MD_CACHE_MAX: 500,

    // 常量
    MAX_CONTEXT_TOKENS: 131072,
    CHARACTER_COLORS: ['#ef4444','#3b82f6','#22c55e','#eab308','#a855f7','#ec4899','#14b8a6','#f97316'],

    // 设置
    globalMemoryLimit: '0',
    savedModel: localStorage.getItem('dsModel') || 'deepseek-chat',

    // ---- 跨模块函数引用（由各模块注册）----
    callLLM: null,
    callLLMJSON: null,
    saveTabs: null,
    savePrompts: null,
    saveCharacters: null,
    updateStorageUsage: null,
    isStorageFull: null,
    showToast: null,
    escapeHtml: null,
    copyText: null,
    openSidebar: null,
    closeSidebar: null,
    openSettingsPanel: null,
    closeSettingsPanel: null,
    showConfirmModal: null,
    closeConfirmModal: null,
    getCharacterById: null,
    getCharacterColor: null,
    renderChat: null,
    renderTabs: null,
    rebindChatButtons: null,
    renderMarkdown: null,
    createNewTab: null,
    invalidateTabCache: null,
    escapeRegExp: null,
    isCurrentSearchResult: null,
    countChars: null,
    estimateTokensByChars: null,
    estimateTokensByText: null,
    buildPayloadMessages: null,
    buildUserInputMeta: null,
    autoHeight: null,
    updateInputCounter: null,
    loadPromptsFromFile: null,
    trackEvent: null,

    // SVG 图标
    icons: {}
  };
})();
