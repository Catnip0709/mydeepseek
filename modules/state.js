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

// ========== dsTabs 压缩存储编解码 ==========
//
// 写入 localStorage 前用 lz-string 压缩，读取后解压；内存中始终是普通对象。
// 压缩串带前缀 COMPRESSED_PREFIX 以便与历史明文数据区分，实现无缝迁移。
const COMPRESSED_PREFIX = 'LZ1:';
const PAGE_LOCK_KEY = 'dsActivePageLock';
const PAGE_LOCK_TTL_MS = 15000;
const PAGE_INSTANCE_ID = `page_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

export const storageRecoveryState = {
  dsTabsReadFailed: false,
  dsTabsReadError: null,
  recoverySessionPresent: localStorage.getItem('dsTabs_recovery_session') != null,
  persistenceRisk: false
};

export async function detectStoragePersistenceRisk() {
  try {
    const probeKey = '__mydeepseek_storage_probe__';
    localStorage.setItem(probeKey, String(Date.now()));
    const probeOk = localStorage.getItem(probeKey) != null;
    localStorage.removeItem(probeKey);
    if (!probeOk) {
      storageRecoveryState.persistenceRisk = true;
      return true;
    }

    // 无痕/隐私环境无法稳定识别，只把极低配额视为风险信号，避免误报。
    // 阈值需低于常见移动端浏览器正常配额（iOS Safari ≈ 5MB 属正常），因此设为 2MB。
    if (navigator.storage?.estimate) {
      const estimate = await navigator.storage.estimate();
      const quota = Number(estimate?.quota || 0);
      if (quota > 0 && quota < 2 * 1024 * 1024) {
        storageRecoveryState.persistenceRisk = true;
      }
    }
  } catch (_) {
    storageRecoveryState.persistenceRisk = true;
  }
  return storageRecoveryState.persistenceRisk;
}

export function getPageInstanceId() {
  return PAGE_INSTANCE_ID;
}

export function canModifyPersistedData() {
  return !state.isReadOnlyPage;
}

export function readPageLock() {
  try {
    const raw = localStorage.getItem(PAGE_LOCK_KEY);
    if (!raw) return null;
    const lock = JSON.parse(raw);
    if (!lock?.id || !Number.isFinite(lock.ts)) return null;
    return lock;
  } catch (_) {
    return null;
  }
}

export function isPageLockStale(lock = readPageLock()) {
  return !lock || Date.now() - lock.ts > PAGE_LOCK_TTL_MS;
}

export function acquirePageLock(force = false) {
  const current = readPageLock();
  if (!force && current && current.id !== PAGE_INSTANCE_ID && !isPageLockStale(current)) {
    return false;
  }
  try {
    localStorage.setItem(PAGE_LOCK_KEY, JSON.stringify({ id: PAGE_INSTANCE_ID, ts: Date.now() }));
    const verified = readPageLock();
    return verified?.id === PAGE_INSTANCE_ID;
  } catch (_) {
    return false;
  }
}

export function refreshPageLock() {
  const current = readPageLock();
  if (!current || current.id !== PAGE_INSTANCE_ID) return false;
  try {
    localStorage.setItem(PAGE_LOCK_KEY, JSON.stringify({ id: PAGE_INSTANCE_ID, ts: Date.now() }));
    return true;
  } catch (_) {
    return false;
  }
}

export function releasePageLock() {
  const current = readPageLock();
  if (!current || current.id !== PAGE_INSTANCE_ID) return;
  try { localStorage.removeItem(PAGE_LOCK_KEY); } catch (_) {}
}

// 将对象序列化并压缩为可安全存入 localStorage 的字符串。
// 若运行环境缺少 LZString（CDN 加载失败），降级为明文，保证功能不中断。
export function encodeTabData(obj) {
  const json = JSON.stringify(obj);
  if (typeof LZString === 'undefined' || !LZString.compressToUTF16) {
    return json;
  }
  return COMPRESSED_PREFIX + LZString.compressToUTF16(json);
}

// 将 localStorage 中的原始字符串解码为对象。
// 兼容两种来源：带前缀的压缩串、历史明文 JSON。解析失败抛出由调用方兜底。
export function decodeTabData(raw) {
  if (typeof raw !== 'string') return JSON.parse(raw);
  if (raw.startsWith(COMPRESSED_PREFIX)) {
    const compressed = raw.slice(COMPRESSED_PREFIX.length);
    const json = (typeof LZString !== 'undefined' && LZString.decompressFromUTF16)
      ? LZString.decompressFromUTF16(compressed)
      : null;
    // decompressFromUTF16 对损坏输入会返回 null 或空串，两者都视为解压失败
    if (!json) throw new Error('dsTabs 解压失败');
    return JSON.parse(json);
  }
  // 历史明文数据：直接解析（首次保存后会自动迁移为压缩格式）
  return JSON.parse(raw);
}

function readJsonWithFallback(key, fallbackFactory, options = {}) {
  const {
    validate = () => true,
    resetMessage = `${key} 数据损坏，已重置`,
    persistFallback = true,
    decode = JSON.parse,
    encode = JSON.stringify,
    preserveOnFailure = false
  } = options;

  const fallbackValue = fallbackFactory();
  const raw = localStorage.getItem(key);
  if (raw == null) {
    if (persistFallback) localStorage.setItem(key, encode(fallbackValue));
    return fallbackValue;
  }

  let parseError = null;
  try {
    const parsed = decode(raw);
    if (validate(parsed)) return parsed;
    console.warn(`${resetMessage}：数据结构无效`);
  } catch (e) {
    parseError = e;
    console.warn(`${resetMessage}:`, e);
  }

  // 聊天主数据解析失败时绝不自动覆盖主 key，避免把仍可恢复的数据替换为空白会话。
  if (preserveOnFailure) {
    storageRecoveryState.dsTabsReadFailed = key === 'dsTabs';
    storageRecoveryState.dsTabsReadError = parseError;
    try {
      localStorage.setItem(`${key}_corrupted_backup`, raw);
    } catch (_) {
      // 备份失败也不能继续覆盖主数据；保留原 key 供用户后续恢复。
    }
    return fallbackValue;
  }

  // 非主聊天数据沿用历史行为：解析失败时备份后写入 fallback。
  if (persistFallback) {
    try {
      localStorage.setItem(`${key}_corrupted_backup`, raw);
    } catch (_) {
      // 备份失败（多为配额不足）不应阻断启动，忽略
    }
    localStorage.setItem(key, encode(fallbackValue));
  }
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
const VALID_MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro'];
function readSelectedModel() {
  const stored = localStorage.getItem('dsSelectedModel');
  return VALID_MODELS.includes(stored) ? stored : 'deepseek-v4-flash';
}

// 深度思考开关
function readDeepThink() {
  return localStorage.getItem('dsDeepThink') === 'true';
}

// 去 AI 味（普通对话）开关
function readHumanizeNormalChat() {
  return localStorage.getItem('dsHumanizeNormalChat') === 'true';
}

const initialTabData = readJsonWithFallback(
  'dsTabs',
  buildDefaultTabData,
  {
    validate: value => !!(value && typeof value === 'object' && value.list && typeof value.list === 'object'),
    resetMessage: 'dsTabs 数据损坏，已重置为空白会话',
    decode: decodeTabData,
    encode: encodeTabData,
    preserveOnFailure: true
  }
);
const initialTabDataStorageFingerprint = localStorage.getItem('dsTabs');

// 集中的可变状态对象
export const state = {
  // 用户ID
  dsUserId: _dsUserId,
  pageInstanceId: PAGE_INSTANCE_ID,
  isReadOnlyPage: false,
  tabDataStorageFingerprint: initialTabDataStorageFingerprint,

  // API Key
  apiKey: localStorage.getItem("dsApiKey"),

  // 模型选择
  selectedModel: readSelectedModel(),

  // 深度思考
  deepThink: readDeepThink(),

  // 去 AI 味（普通对话）
  humanizeNormalChat: readHumanizeNormalChat(),

  // 记忆策略
  memoryStrategy: readMemoryStrategy(),

  // Tab 数据
  tabData: initialTabData,

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

export const MAX_CONTEXT_TOKENS_V4 = 1048576;  // V4: 1M

/**
 * 获取当前生效的模型 ID 和额外参数。
 * - V4 + 深度思考 → model: 选中的 V4, thinkingType: 'enabled', reasoningEffort: 'max'
 * - V4 + 非深度思考 → model: 选中的 V4, thinkingType: null
 */
export function getEffectiveModel() {
  return {
    model: state.selectedModel,
    thinkingType: state.deepThink ? 'enabled' : null,
    reasoningEffort: state.deepThink ? 'max' : null
  };
}

/**
 * 根据当前选择的模型返回对应的上下文 token 上限。
 * V4 系列（Flash / Pro）→ 1M。
 */
export function getMaxContextTokens() {
  return MAX_CONTEXT_TOKENS_V4;
}

export const CHARACTER_STORAGE_KEY = 'dsCharacters';
export const PROMPT_STORAGE_KEY = 'dsPrompts';
export const FAVORITES_STORAGE_KEY = 'dsFavorites';
