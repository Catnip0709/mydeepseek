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

function readJsonWithFallback(key, fallbackFactory, options = {}) {
  const {
    validate = () => true,
    resetMessage = `${key} 数据损坏，已重置`,
    persistFallback = true
  } = options;

  const fallbackValue = fallbackFactory();
  const raw = localStorage.getItem(key);
  if (raw == null) {
    if (persistFallback) localStorage.setItem(key, JSON.stringify(fallbackValue));
    return fallbackValue;
  }

  try {
    const parsed = JSON.parse(raw);
    if (validate(parsed)) return parsed;
    console.warn(`${resetMessage}：数据结构无效`);
  } catch (e) {
    console.warn(`${resetMessage}:`, e);
  }

  if (persistFallback) localStorage.setItem(key, JSON.stringify(fallbackValue));
  return fallbackValue;
}

function buildDefaultTabData() {
  const oldMsgs = readJsonWithFallback(
    'dsMessages',
    () => [],
    {
      validate: Array.isArray,
      resetMessage: 'dsMessages 数据损坏，已重置'
    }
  );
  return { active: "tab1", list: { tab1: { messages: oldMsgs, memoryLimit: "0", title: "", storyArchive: null } } };
}

// 记忆策略常量
export const MEMORY_STRATEGY_WINDOW = 'window';  // 滑动窗口摘要（省 token）
export const MEMORY_STRATEGY_FULL = 'full';      // 全量发送（默认，不摘要，用户自行承担 token）

// 读取记忆策略配置
function readMemoryStrategy() {
  const stored = localStorage.getItem('dsMemoryStrategy');
  if (stored === MEMORY_STRATEGY_WINDOW || stored === MEMORY_STRATEGY_FULL) {
    return stored;
  }
  return MEMORY_STRATEGY_FULL; // 默认全量
}

// 模型选择
const VALID_MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-chat'];
function readSelectedModel() {
  const stored = localStorage.getItem('dsSelectedModel');
  return VALID_MODELS.includes(stored) ? stored : 'deepseek-v4-flash';
}

// 深度思考开关
function readDeepThink() {
  return localStorage.getItem('dsDeepThink') === 'true';
}

// 集中的可变状态对象
export const state = {
  // 用户ID
  dsUserId: _dsUserId,

  // API Key
  apiKey: localStorage.getItem("dsApiKey"),

  // 模型选择
  selectedModel: readSelectedModel(),

  // 深度思考
  deepThink: readDeepThink(),

  // 记忆策略
  memoryStrategy: readMemoryStrategy(),

  // Tab 数据
  tabData: readJsonWithFallback(
    'dsTabs',
    buildDefaultTabData,
    {
      validate: value => !!(value && typeof value === 'object' && value.list && typeof value.list === 'object'),
      resetMessage: 'dsTabs 数据损坏，已重置为空白会话'
    }
  ),

  // 角色卡数据
  characterData: readJsonWithFallback(
    'dsCharacters',
    () => [],
    {
      validate: Array.isArray,
      resetMessage: 'dsCharacters 数据损坏，已重置'
    }
  ),

  // 指令数据
  promptData: readJsonWithFallback(
    'dsPrompts',
    () => [],
    {
      validate: Array.isArray,
      resetMessage: 'dsPrompts 数据损坏，已重置'
    }
  ),

  // 收藏数据
  favoriteData: readJsonWithFallback(
    'dsFavorites',
    () => [],
    {
      validate: Array.isArray,
      resetMessage: 'dsFavorites 数据损坏，已重置'
    }
  ),

  // 编辑状态
  editingMessageIndex: -1,
  editingCharacterId: null,
  editingPromptId: null,
  renamingTabId: null,

  // 发送状态（按 tab 隔离：每个 tab 独立维护 isSending / abortController / abortReason /
  // isPreparingTextAttachment）。顶层 state.isSending / state.abortController /
  // state.abortReason / state.isPreparingTextAttachment 已改为访问器，等价于读写
  // "当前 active tab" 的状态，保持与历史代码兼容。
  sendingByTab: Object.create(null),

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

  // 剧情档案馆
  archiveGenerationTabId: null,
  archiveAbortController: null,

  // 待发送 txt 附件（pendingTextAttachment 本身与当前 active tab 绑定，不按 tab 区分）
  pendingTextAttachment: null,
};

// ========== 按 tab 隔离的发送状态 helper ==========

function _ensureTabSending(tabId) {
  if (!tabId) return null;
  let entry = state.sendingByTab[tabId];
  if (!entry) {
    entry = state.sendingByTab[tabId] = {
      isSending: false,
      abortController: null,
      abortReason: null,
      isPreparingTextAttachment: false
    };
  }
  return entry;
}

export function getTabSending(tabId) {
  return _ensureTabSending(tabId);
}

export function isTabSending(tabId) {
  const entry = state.sendingByTab[tabId];
  return !!(entry && (entry.isSending || entry.isPreparingTextAttachment));
}

export function isAnyTabSending() {
  for (const k in state.sendingByTab) {
    const e = state.sendingByTab[k];
    if (e && (e.isSending || e.isPreparingTextAttachment)) return true;
  }
  return false;
}

export function setTabSending(tabId, patch) {
  const entry = _ensureTabSending(tabId);
  if (!entry) return null;
  Object.assign(entry, patch);
  return entry;
}

export function clearTabSending(tabId) {
  if (tabId && state.sendingByTab[tabId]) {
    const prev = state.sendingByTab[tabId];
    // CR-7: 若仍持有未 abort 的 controller，先 abort 再 reset，避免调用者忘记 abort 导致泄漏；
    // 重复 abort() 是幂等的（AbortController 规范允许多次调用）。
    if (prev.abortController) {
      try {
        if (!prev.abortController.signal.aborted) {
          prev.abortController.abort();
        }
      } catch (_) {}
    }
    // 注意：这里整体替换 entry 对象，外部若缓存了旧 entry 引用不会受影响，但也看不到新状态。
    // 调用方如需继续读取中止后的状态，请在 clearTabSending 之前读取 prev.abortReason。
    state.sendingByTab[tabId] = {
      isSending: false,
      abortController: null,
      abortReason: null,
      isPreparingTextAttachment: false
    };
  }
}

export function abortTabSending(tabId, reason) {
  const entry = state.sendingByTab[tabId];
  if (!entry) return false;
  entry.abortReason = reason;
  if (entry.abortController) {
    try { entry.abortController.abort(); } catch (_) {}
  }
  return true;
}

// ========== 顶层 state.isSending / abortController / abortReason / isPreparingTextAttachment ==========
// 作为"当前 active tab"的便捷访问器，保持历史代码兼容性。
// 注意：读写这些字段等价于读写 active tab 的对应字段。

function _activeTabId() {
  return state.tabData && state.tabData.active;
}

Object.defineProperty(state, 'isSending', {
  configurable: true,
  enumerable: true,
  get() {
    const entry = state.sendingByTab[_activeTabId()];
    return !!(entry && entry.isSending);
  },
  set(v) {
    const tabId = _activeTabId();
    if (!tabId) return;
    _ensureTabSending(tabId).isSending = !!v;
  }
});

Object.defineProperty(state, 'abortController', {
  configurable: true,
  enumerable: true,
  get() {
    const entry = state.sendingByTab[_activeTabId()];
    return entry ? entry.abortController : null;
  },
  set(v) {
    const tabId = _activeTabId();
    if (!tabId) return;
    _ensureTabSending(tabId).abortController = v;
  }
});

Object.defineProperty(state, 'abortReason', {
  configurable: true,
  enumerable: true,
  get() {
    const entry = state.sendingByTab[_activeTabId()];
    return entry ? entry.abortReason : null;
  },
  set(v) {
    const tabId = _activeTabId();
    if (!tabId) return;
    _ensureTabSending(tabId).abortReason = v;
  }
});

Object.defineProperty(state, 'isPreparingTextAttachment', {
  configurable: true,
  enumerable: true,
  get() {
    const entry = state.sendingByTab[_activeTabId()];
    return !!(entry && entry.isPreparingTextAttachment);
  },
  set(v) {
    const tabId = _activeTabId();
    if (!tabId) return;
    _ensureTabSending(tabId).isPreparingTextAttachment = !!v;
  }
});

// 常量
export const CHARACTER_COLORS = ['#f87171', '#60a5fa', '#34d399', '#fbbf24', '#a78bfa', '#f472b6', '#38bdf8', '#fb923c'];

export const MAX_CONTEXT_TOKENS_V3 = 131072;   // V3.2: 128K
export const MAX_CONTEXT_TOKENS_V4 = 1048576;  // V4: 1M

/**
 * 获取当前生效的模型 ID 和额外参数。
 * - V3.2 + 深度思考 → model: 'deepseek-chat', thinkingType: 'enabled'
 * - V3.2 + 非深度思考 → model: 'deepseek-chat', thinkingType: null
 * - V4 + 深度思考 → model: 选中的 V4, thinkingType: 'enabled', reasoningEffort: 'max'
 * - V4 + 非深度思考 → model: 选中的 V4, thinkingType: null
 */
export function getEffectiveModel() {
  const model = state.selectedModel;
  const isV4 = model.startsWith('deepseek-v4');
  return {
    model,
    thinkingType: state.deepThink ? 'enabled' : null,
    reasoningEffort: state.deepThink && isV4 ? 'max' : null
  };
}

/**
 * 判断当前是否为 V4 模型
 */
export function isV4Model() {
  return state.selectedModel.startsWith('deepseek-v4');
}

/**
 * 根据当前选择的模型返回对应的上下文 token 上限。
 * V4 系列（Flash / Pro）→ 1M，V3.2 → 128K。
 */
export function getMaxContextTokens() {
  return isV4Model() ? MAX_CONTEXT_TOKENS_V4 : MAX_CONTEXT_TOKENS_V3;
}

export const CHARACTER_STORAGE_KEY = 'dsCharacters';
export const PROMPT_STORAGE_KEY = 'dsPrompts';
export const FAVORITES_STORAGE_KEY = 'dsFavorites';
