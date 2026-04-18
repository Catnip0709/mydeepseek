/**
 * state.js — 共享状态模块
 *
 * 所有跨模块共享的可变状态集中在此文件。
 * 本模块不导入任何其他模块，避免循环依赖。
 *
 * 使用一个 state 对象来持有所有可变状态，这样其他模块可以通过
 * import { state } from './state.js' 来读写状态。
 */

// 用户ID（初始化时生成并持久化）
let _dsUserId = localStorage.getItem('ds_user_id');
if (!_dsUserId) {
  _dsUserId = 'user_' + Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
  localStorage.setItem('ds_user_id', _dsUserId);
}

// 集中的可变状态对象
export const state = {
  // 用户ID
  dsUserId: _dsUserId,

  // API Key
  apiKey: localStorage.getItem("dsApiKey"),

  // Tab 数据
  tabData: JSON.parse(localStorage.getItem("dsTabs")) || (() => {
    const oldMsgs = JSON.parse(localStorage.getItem("dsMessages")) || [];
    return { active: "tab1", list: { tab1: { messages: oldMsgs, memoryLimit: "0", title: "" } } };
  })(),

  // 角色卡数据
  characterData: (() => {
    try {
      const rawCharData = JSON.parse(localStorage.getItem('dsCharacters'));
      return Array.isArray(rawCharData) ? rawCharData : [];
    } catch (e) {
      console.warn('dsCharacters 数据损坏，已重置:', e);
      return [];
    }
  })(),

  // 指令数据
  promptData: (() => {
    try {
      const rawPromptData = JSON.parse(localStorage.getItem('dsPrompts'));
      return Array.isArray(rawPromptData) ? rawPromptData : [];
    } catch (e) {
      console.warn('dsPrompts 数据损坏，已重置:', e);
      return [];
    }
  })(),

  // 编辑状态
  editingMessageIndex: -1,
  editingCharacterId: null,
  editingPromptId: null,
  renamingTabId: null,

  // 发送状态
  isSending: false,
  abortController: null,
  abortReason: null,

  // 确认弹窗
  confirmResolve: null,

  // 指令优化
  optimizedCandidateText: '',
  optimizeInProgress: false,

  // 搜索
  searchQuery: '',
  searchResults: [],
  currentSearchIndex: -1,

  // 群聊角色选择
  selectedGroupCharacterIds: new Set(),

  // 导出面板
  pendingDownloadTabId: null,

  // 侧边栏
  isSidebarOpen: false,

  // 页面可见性
  lastPageHiddenAt: 0,
  shouldToastOnVisible: false,

  // Tab DOM 缓存
  _tabDomCache: {},

  // 回复引用
  replyTarget: null,

  // 指令市场
  currentMarketPrompt: null,
  lastShownPromptIndex: -1,
};

// 常量
export const CHARACTER_COLORS = ['#f87171', '#60a5fa', '#34d399', '#fbbf24', '#a78bfa', '#f472b6', '#38bdf8', '#fb923c'];

export const MAX_CONTEXT_TOKENS = 131072;

export const CHARACTER_STORAGE_KEY = 'dsCharacters';
export const PROMPT_STORAGE_KEY = 'dsPrompts';
