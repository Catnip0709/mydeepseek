/**
 * storage.js — 数据持久化模块
 *
 * 负责 localStorage 的读写、存储用量统计、数据构建等。
 */

import { state, CHARACTER_STORAGE_KEY, PROMPT_STORAGE_KEY, FAVORITES_STORAGE_KEY, getMaxContextTokens, MEMORY_STRATEGY_WINDOW, MEMORY_STRATEGY_FULL } from './state.js';
import { formatBytes, estimateTokensByText, countChars, estimateTokensByChars, generateMessageId, isHtmlRelatedMessage } from './utils.js';
import { SUMMARY_RECENT_RAW_COUNT, SUMMARY_FORMAT_VERSION } from './memory-config.js';

// ========== 存储用量统计 ==========

function getStorageUsedBytes() {
  let totalUsed = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key) {
      totalUsed += (localStorage.getItem(key) || '').length * 2; // UTF-16 每字符2字节
    }
  }
  return totalUsed;
}

export function updateStorageUsage() {
  const totalUsed = getStorageUsedBytes();
  const limit = 5 * 1024 * 1024; // 5MB
  const percent = Math.min(Math.round((totalUsed / limit) * 100), 100);
  const isWarning = percent >= 95;

  const storageUsageText = document.getElementById('storageUsageText');
  const storageWarningIcon = document.getElementById('storageWarningIcon');

  if (storageUsageText) {
    storageUsageText.textContent = '本地存储容量 ' + formatBytes(totalUsed) + '/5MB(' + percent + '%)';
  }

  if (storageWarningIcon) {
    if (isWarning) {
      storageUsageText?.classList.add('storage-warning');
      storageWarningIcon.classList.remove('hidden');
    } else {
      storageUsageText?.classList.remove('storage-warning');
      storageWarningIcon.classList.add('hidden');
    }
  }
}

export function isStorageFull() {
  const totalUsed = getStorageUsedBytes();
  return totalUsed / (5 * 1024 * 1024) >= 0.99;
}

// ========== 数据保存（防抖） ==========

let _saveDebounceTimer = null;
let _pendingSaveTypes = new Set(); // 支持多种类型同时待保存
const SAVE_DEBOUNCE_MS = 300;

// 配额/持久化错误监听器（由上层注册，用于回滚或弹 Toast）
const _persistErrorListeners = new Set();

export function onPersistError(fn) {
  if (typeof fn === 'function') _persistErrorListeners.add(fn);
  return () => _persistErrorListeners.delete(fn);
}

function _notifyPersistError(type, err) {
  const isQuota = err && (
    err.name === 'QuotaExceededError' ||
    err.code === 22 ||
    err.code === 1014 ||
    /quota|exceed/i.test(String(err.message || ''))
  );
  for (const fn of _persistErrorListeners) {
    try { fn({ type, error: err, isQuota }); } catch (_) {}
  }
}

function _flushPendingSave() {
  // 先把待保存集合 swap 出来，避免 flush 执行期间新加入的保存被意外清空（竞态修复）
  const typesToFlush = _pendingSaveTypes;
  _pendingSaveTypes = new Set();
  _saveDebounceTimer = null;

  const failedSaveTypes = new Set();
  let wroteAnyData = false;

  if (typesToFlush.has('tabs')) {
    try {
      localStorage.setItem("dsTabs", JSON.stringify(state.tabData));
      wroteAnyData = true;
    } catch (e) {
      console.error('保存对话数据失败:', e);
      failedSaveTypes.add('tabs');
      _notifyPersistError('tabs', e);
    }
  }
  if (typesToFlush.has('characters')) {
    try {
      localStorage.setItem(CHARACTER_STORAGE_KEY, JSON.stringify(state.characterData));
      wroteAnyData = true;
    } catch (e) {
      console.error('保存角色数据失败:', e);
      failedSaveTypes.add('characters');
      _notifyPersistError('characters', e);
    }
  }
  if (typesToFlush.has('prompts')) {
    try {
      localStorage.setItem(PROMPT_STORAGE_KEY, JSON.stringify(state.promptData));
      wroteAnyData = true;
    } catch (e) {
      console.error('保存指令数据失败:', e);
      failedSaveTypes.add('prompts');
      _notifyPersistError('prompts', e);
    }
  }
  if (typesToFlush.has('favorites')) {
    try {
      localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(state.favoriteData));
      wroteAnyData = true;
    } catch (e) {
      console.error('保存收藏数据失败:', e);
      failedSaveTypes.add('favorites');
      _notifyPersistError('favorites', e);
    }
  }
  if (wroteAnyData || typesToFlush.size > 0) {
    updateStorageUsage();
  }

  // 把失败项以及 flush 过程中新加入的待保存合并回去
  if (failedSaveTypes.size > 0 || _pendingSaveTypes.size > 0) {
    for (const t of failedSaveTypes) _pendingSaveTypes.add(t);
    // 失败项不立即重试（避免死循环），仅保留在待保存集合中，留待下次手动触发或下一次 saveXxx 带起
  }
}

export function saveTabs() {
  _pendingSaveTypes.add('tabs');
  if (_saveDebounceTimer) clearTimeout(_saveDebounceTimer);
  _saveDebounceTimer = setTimeout(_flushPendingSave, SAVE_DEBOUNCE_MS);
}

export function saveCharacters() {
  _pendingSaveTypes.add('characters');
  if (_saveDebounceTimer) clearTimeout(_saveDebounceTimer);
  _saveDebounceTimer = setTimeout(_flushPendingSave, SAVE_DEBOUNCE_MS);
}

export function savePrompts() {
  _pendingSaveTypes.add('prompts');
  if (_saveDebounceTimer) clearTimeout(_saveDebounceTimer);
  _saveDebounceTimer = setTimeout(_flushPendingSave, SAVE_DEBOUNCE_MS);
}

export function saveFavorites() {
  _pendingSaveTypes.add('favorites');
  if (_saveDebounceTimer) clearTimeout(_saveDebounceTimer);
  _saveDebounceTimer = setTimeout(_flushPendingSave, SAVE_DEBOUNCE_MS);
}

export function flushPendingSaveImmediately() {
  if (_saveDebounceTimer) clearTimeout(_saveDebounceTimer);
  _flushPendingSave();
}

// ========== Token 限制检查 ==========

export function isTokenLimitReached(tabId = state.tabData.active) {
  const currentMsgs = state.tabData.list[tabId]?.messages || [];
  const payloadMsgs = buildPayloadMessages(currentMsgs, currentMsgs.length, tabId);
  let estimatedTokens = 0;
  payloadMsgs.forEach(m => {
    estimatedTokens += estimateTokensByText(m.content);
  });
  return estimatedTokens >= getMaxContextTokens() * 0.98;
}

// ========== Tab 显示名 ==========

export function getTabDisplayName(id) {
  const tab = state.tabData.list[id];
  if (!tab) return id;
  const customTitle = (tab.title || '').trim();
  if (customTitle) return customTitle;
  if (tab.type === 'single-character' && tab.characterId) {
    const char = state.characterData.find(c => c.id === tab.characterId);
    return char ? char.name : `对话 ${id.replace("tab", "")}`;
  }
  return `对话 ${id.replace("tab", "")}`;
}

// ========== 构建发送给 LLM 的消息列表 ==========

export function buildPayloadMessages(messages, endExclusive = messages.length, tabId = state.tabData.active) {
  const currentTab = state.tabData.list[tabId];

  const parseBannedWords = (raw) => String(raw || '')
    .split(/[\n,，、;；]+/)
    .map(w => w.trim())
    .filter(Boolean);

  const buildBannedWordsRule = (raw) => {
    const words = parseBannedWords(raw);
    if (!words.length) return '';
    return [
      '【写作偏好硬规则】',
      `- 全文禁止出现以下词语：${words.join('、')}`,
      '- 如果自然想写到这些词，必须换一种表达',
      '- 输出前自检一遍，若出现禁用词原文，先改写后再输出'
    ].join('\n');
  };

  // 全量模式：不使用摘要，直接发送全部消息
  if (state.memoryStrategy === MEMORY_STRATEGY_FULL) {
    let payloadMsgs = messages.slice(0, endExclusive).filter(m => !isHtmlRelatedMessage(m)).map(m => ({
      role: m.role,
      content: m.content
    }));

    // 构建背景信息
    let bgInfoParts = [];
    if (currentTab && currentTab.userRoleName) {
      bgInfoParts.push(`用户在对话中的角色是「${currentTab.userRoleName}」，请以此称呼用户。`);
    }
    if (currentTab && currentTab.storyBackground) {
      bgInfoParts.push(`当前对话背景：${currentTab.storyBackground}`);
    }
    const bannedWordsRule = buildBannedWordsRule(currentTab?.bannedWords || '');
    if (bannedWordsRule) {
      bgInfoParts.push(bannedWordsRule);
    }

    // 单角色聊天：注入角色 system prompt
    if (currentTab && currentTab.type === 'single-character' && currentTab.characterId) {
      const char = state.characterData.find(c => c.id === currentTab.characterId);
      if (char) {
        let systemPrompt = buildCharacterSystemPrompt(char);
        if (bgInfoParts.length > 0) {
          systemPrompt += '\n\n' + bgInfoParts.join('\n');
        }
        payloadMsgs.unshift({ role: "system", content: systemPrompt });
      }
    } else {
      // 单聊等其他类型：注入背景信息
      if (bgInfoParts.length > 0) {
        payloadMsgs.unshift({ role: "system", content: bgInfoParts.join('\n\n') });
      }
    }

    return payloadMsgs;
  }

  // 滑动窗口模式：有摘要时只取摘要覆盖位置之后的消息
  let payloadMsgs;
  const hasUsableSummary = currentTab ? tabHasUsableSummary(currentTab) : false;
  const effectiveSummaryCover = hasUsableSummary ? getNormalizedSummaryCover(currentTab) : 0;
  if (currentTab && hasUsableSummary) {
    const safeEnd = Math.min(endExclusive, messages.length);
    const startIdx = Math.min(effectiveSummaryCover, safeEnd);
    if (startIdx < safeEnd) {
      // 正常情况：摘要 + 近期消息
      payloadMsgs = messages.slice(startIdx, safeEnd).filter(m => !isHtmlRelatedMessage(m)).map(m => ({
        role: m.role,
        content: m.content
      }));
    } else {
      // 异常情况：摘要覆盖了全部消息，回退到发送全部消息
      payloadMsgs = messages.slice(0, safeEnd).filter(m => !isHtmlRelatedMessage(m)).map(m => ({
        role: m.role,
        content: m.content
      }));
    }
  } else {
    payloadMsgs = messages.slice(0, endExclusive).filter(m => !isHtmlRelatedMessage(m)).map(m => ({
      role: m.role,
      content: m.content
    }));
  }

  // 构建背景信息（所有会话类型通用）
  let bgInfoParts = [];
  if (currentTab && currentTab.userRoleName) {
    bgInfoParts.push(`用户在对话中的角色是「${currentTab.userRoleName}」，请以此称呼用户。`);
  }
  if (currentTab && currentTab.storyBackground) {
    bgInfoParts.push(`当前对话背景：${currentTab.storyBackground}`);
  }
  const bannedWordsRule = buildBannedWordsRule(currentTab?.bannedWords || '');
  if (bannedWordsRule) {
    bgInfoParts.push(bannedWordsRule);
  }

  // 单角色聊天：注入角色 system prompt + 摘要
  if (currentTab && currentTab.type === 'single-character' && currentTab.characterId) {
    const char = state.characterData.find(c => c.id === currentTab.characterId);
    if (char) {
      let systemPrompt = buildCharacterSystemPrompt(char);
      if (hasUsableSummary) {
        systemPrompt += `\n\n【对话记忆摘要】\n${currentTab.summary}`;
      }
      if (bgInfoParts.length > 0) {
        systemPrompt += '\n\n' + bgInfoParts.join('\n');
      }
      payloadMsgs.unshift({ role: "system", content: systemPrompt });
    }
  } else {
    // 单聊等其他类型：注入摘要 + 背景信息
    let systemParts = [];
    if (currentTab && hasUsableSummary) {
      systemParts.push(`【对话记忆摘要】\n${currentTab.summary}`);
    }
    if (bgInfoParts.length > 0) {
      systemParts.push(...bgInfoParts);
    }
    if (systemParts.length > 0) {
      payloadMsgs.unshift({ role: "system", content: systemParts.join('\n\n') });
    }
  }

  return payloadMsgs;
}

// ========== 构建角色 System Prompt ==========

export function buildCharacterSystemPrompt(char) {
  return `你是${char.name}。
性格：${char.personality || '无特殊设定'}
背景：${char.background || '无'}
外貌：${char.appearance || '无'}
说话风格：${char.speakingStyle || '自然'}
口头禅参考（仅供参考语气，不要刻意堆砌）：${(char.catchphrases || []).join('、') || '无'}

规则：
- 你需要始终以${char.name}的身份和性格进行回复
- 保持角色一致性，不要脱离角色设定
- 用自然的对话方式回复，不要过于生硬
- 如果有动作、神态、视线、停顿等描写，请单独放在一行，并使用全角括号包裹，例如：\n（抬眸看了你一眼）
- 若有台词，请放在动作描写下一行；不要把动作和台词糊成一整段`;
}

// ========== 构建用户输入元信息 ==========

export function buildUserInputMeta(messages, userIndex, tabId = state.tabData.active) {
  const currentMessage = messages[userIndex];
  if (!currentMessage || currentMessage.role !== 'user') return null;

  const currentTab = state.tabData.list[tabId];
  const hasSummary = currentTab && tabHasUsableSummary(currentTab);

  const payloadMsgs = buildPayloadMessages(messages, userIndex + 1, tabId);
  const inputChars = countChars(currentMessage.content);
  const inputTokens = estimateTokensByChars(inputChars);
  const historyTokens = payloadMsgs
    .slice(0, -1)
    .reduce((sum, msg) => sum + estimateTokensByText(msg.content), 0);

  return {
    inputChars,
    inputTokens,
    historyTokens,
    totalInputTokens: inputTokens + historyTokens,
    hasSummary
  };
}

// ========== 生成新 Tab ID ==========

export function generateNewTabId() {
  const tabIds = Object.keys(state.tabData.list);
  let maxIdNum = 0;
  tabIds.forEach(id => {
    const num = parseInt(id.replace('tab', ''), 10);
    if (num > maxIdNum) maxIdNum = num;
  });
  return `tab${maxIdNum + 1}`;
}

function getMaxAllowedSummaryCover(tab) {
  const msgCount = Array.isArray(tab?.messages) ? tab.messages.length : 0;
  return Math.max(msgCount - SUMMARY_RECENT_RAW_COUNT, 0);
}

function getMaxLegacySummaryCover(tab) {
  const msgCount = Array.isArray(tab?.messages) ? tab.messages.length : 0;
  return Math.max(msgCount, 0);
}

export function tabHasCurrentSummaryVersion(tab) {
  return !!(tab && tab.summary && tab.summaryVersion === SUMMARY_FORMAT_VERSION);
}

export function getNormalizedSummaryCover(tab) {
  if (!tab || !tab.summary || !tabHasCurrentSummaryVersion(tab)) return 0;
  const currentCover = Number.isFinite(tab.summaryCoversUpTo) ? tab.summaryCoversUpTo : 0;
  return Math.max(Math.min(currentCover, getMaxAllowedSummaryCover(tab)), 0);
}

export function tabHasUsableSummary(tab) {
  if (!tab || !tab.summary || !tabHasCurrentSummaryVersion(tab)) return false;
  const normalizedCover = getNormalizedSummaryCover(tab);
  if (normalizedCover <= 0) return false;
  return normalizedCover === tab.summaryCoversUpTo;
}

export function normalizeTabSummaryState(tab) {
  if (!tab) return;

  if (!tab.summary) {
    tab.summary = '';
    tab.summaryCoversUpTo = 0;
    tab.summaryVersion = '';
    return;
  }

  if (tabHasCurrentSummaryVersion(tab)) {
    tab.summaryCoversUpTo = getNormalizedSummaryCover(tab);
  } else {
    const currentCover = Number.isFinite(tab.summaryCoversUpTo) ? tab.summaryCoversUpTo : 0;
    tab.summaryCoversUpTo = Math.max(Math.min(currentCover, getMaxLegacySummaryCover(tab)), 0);
  }
}

// ========== 数据初始化与修复 ==========

export function initializeData() {
  const validMessageIdsByTab = new Map();
  let shouldSaveTabsAfterInit = false;
  let shouldSaveFavoritesAfterInit = false;

  // 修复 tabData 结构
  Object.keys(state.tabData.list).forEach(id => {
    if (Array.isArray(state.tabData.list[id])) {
      state.tabData.list[id] = { messages: state.tabData.list[id], memoryLimit: "0", title: "", summary: "", summaryCoversUpTo: 0, summaryVersion: '', storyArchive: null };
    } else {
      if (typeof state.tabData.list[id].title === 'undefined') state.tabData.list[id].title = "";
      if (typeof state.tabData.list[id].memoryLimit === 'undefined') state.tabData.list[id].memoryLimit = "0";
      if (typeof state.tabData.list[id].summary === 'undefined') state.tabData.list[id].summary = "";
      if (typeof state.tabData.list[id].summaryCoversUpTo === 'undefined') state.tabData.list[id].summaryCoversUpTo = 0;
      if (typeof state.tabData.list[id].summaryVersion === 'undefined') state.tabData.list[id].summaryVersion = "";
      if (typeof state.tabData.list[id].storyArchive === 'undefined') state.tabData.list[id].storyArchive = null;
      if (!Array.isArray(state.tabData.list[id].messages)) state.tabData.list[id].messages = [];
      normalizeTabSummaryState(state.tabData.list[id]);
    }

    state.tabData.list[id].messages.forEach(msg => {
      if (!msg.id) {
        msg.id = generateMessageId();
        shouldSaveTabsAfterInit = true;
      }
      if (msg.history && typeof msg.history[0] === 'string') {
        msg.history = msg.history.map(content => ({ content: content, reasoningContent: "" }));
        shouldSaveTabsAfterInit = true;
      }
    });
    validMessageIdsByTab.set(id, new Set(state.tabData.list[id].messages.map(msg => msg.id).filter(Boolean)));
  });

  const normalizedFavorites = Array.isArray(state.favoriteData)
    ? state.favoriteData.filter(item => {
        if (!item || typeof item !== 'object') return false;
        if (!item.id || !item.tabId || !item.messageId) return false;
        const validIds = validMessageIdsByTab.get(item.tabId);
        return !!validIds && validIds.has(item.messageId);
      })
    : [];
  if (normalizedFavorites.length !== state.favoriteData.length) {
    shouldSaveFavoritesAfterInit = true;
  }
  state.favoriteData = normalizedFavorites;

  // 初始化存储用量
  updateStorageUsage();
  if (shouldSaveTabsAfterInit) saveTabs();
  if (shouldSaveFavoritesAfterInit) saveFavorites();
}

// ========== 数据修复（错误恢复时使用） ==========

export function repairData() {
  const raw = localStorage.getItem("dsTabs");
  const parsed = JSON.parse(raw);
  if (parsed && parsed.list && typeof parsed.list === 'object') {
    Object.keys(parsed.list).forEach(function(id) {
      const tab = parsed.list[id];
      if (Array.isArray(tab)) {
        parsed.list[id] = { messages: tab, memoryLimit: "0", title: "", summary: "", summaryCoversUpTo: 0, summaryVersion: '', storyArchive: null };
      } else {
        tab.messages = Array.isArray(tab.messages) ? tab.messages : [];
        tab.memoryLimit = tab.memoryLimit || "0";
        tab.title = tab.title || "";
        tab.summary = tab.summary || "";
        tab.summaryCoversUpTo = tab.summaryCoversUpTo || 0;
        tab.summaryVersion = tab.summaryVersion || "";
        if (typeof tab.storyArchive === 'undefined') tab.storyArchive = null;
        normalizeTabSummaryState(tab);
        tab.messages.forEach(function(msg) {
          if (!msg.id) msg.id = generateMessageId();
          if (!msg.role) msg.role = 'user';
          if (!msg.content) msg.content = '';
          if (msg.history && typeof msg.history[0] === 'string') {
            msg.history = msg.history.map(function(c) { return { content: c, reasoningContent: "" }; });
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
    localStorage.setItem("dsTabs", JSON.stringify(parsed));
    // 收藏修复：基于修复后的 parsed 数据验证 messageId 是否有效
    const validMessageIdsByTab = new Map();
    Object.keys(parsed.list).forEach(function(id) {
      const tab = parsed.list[id];
      if (Array.isArray(tab.messages)) {
        validMessageIdsByTab.set(id, new Set(tab.messages.map(function(msg) { return msg.id; }).filter(Boolean)));
      }
    });
    const repairedFavorites = Array.isArray(state.favoriteData)
      ? state.favoriteData.filter(function(item) {
          if (!item || !item.id || !item.tabId || !item.messageId) return false;
          const validIds = validMessageIdsByTab.get(item.tabId);
          return !!validIds && validIds.has(item.messageId);
        })
      : [];
    localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(repairedFavorites));
    location.reload();
  } else {
    throw new Error('tabData 结构无效');
  }
}
