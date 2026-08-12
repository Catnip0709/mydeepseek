/**
 * storage.js — 数据持久化模块
 *
 * 负责 localStorage 的读写、存储用量统计、数据构建等。
 */

import {
  state, CHARACTER_STORAGE_KEY, PROMPT_STORAGE_KEY, FAVORITES_STORAGE_KEY,
  getMaxContextTokens, MEMORY_STRATEGY_WINDOW, MEMORY_STRATEGY_FULL,
  encodeTabData, decodeTabData, storageRecoveryState, readPageLock, isPageLockStale, canModifyPersistedData
} from './state.js?v=6';
import { formatBytes, estimateTokensByText, countChars, estimateTokensByChars, generateMessageId, isHtmlRelatedMessage } from './utils.js?v=6';
import { SUMMARY_RECENT_RAW_COUNT, SUMMARY_FORMAT_VERSION } from './memory-config.js?v=6';

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
  // localStorage 的实际硬配额由浏览器决定，5MB 仅作为跨浏览器的保守安全线。
  const safetyLimit = 5 * 1024 * 1024;
  const rawPercent = Math.round((totalUsed / safetyLimit) * 100);
  const isWarning = rawPercent >= 95;

  const storageUsageText = document.getElementById('storageUsageText');
  const storageWarningIcon = document.getElementById('storageWarningIcon');

  if (storageUsageText) {
    storageUsageText.textContent = rawPercent > 100
      ? `本地存储约 ${formatBytes(totalUsed)}（已超 5MB 安全线）`
      : `本地存储约 ${formatBytes(totalUsed)}/5MB 安全线(${rawPercent}%)`;
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

function getStoredValueBytes(key) {
  return (localStorage.getItem(key) || '').length * 2;
}

function getCorruptedBackupKeys() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (
      key === 'dsTabs_corrupted_backup' ||
      key?.startsWith('dsTabs_corrupted_backup_') ||
      key?.startsWith('dsTabs_recovery_session_corrupted_backup_')
    ) {
      keys.push(key);
    }
  }
  return keys;
}

export function getRecoverableStorageInfo() {
  const recoveryKey = 'dsTabs_recovery_session';
  const recoveryFingerprint = localStorage.getItem(recoveryKey);
  const recoveryPresent = recoveryFingerprint != null;
  const backupKeys = getCorruptedBackupKeys();
  return {
    recoveryPresent,
    recoveryBytes: recoveryPresent ? getStoredValueBytes(recoveryKey) : 0,
    recoveryFingerprint,
    backupCount: backupKeys.length,
    backupBytes: backupKeys.reduce((sum, key) => sum + getStoredValueBytes(key), 0),
    cleanupBlocked: state.isReadOnlyPage || storageRecoveryState.dsTabsReadFailed
  };
}

export function isStorageFull() {
  const totalUsed = getStorageUsedBytes();
  // 达到安全线后提前阻止继续扩张；真正的写入上限仍以浏览器是否抛出配额异常为准。
  return totalUsed / (5 * 1024 * 1024) >= 0.99;
}

// ========== 数据保存（防抖） ==========

let _saveDebounceTimer = null;
let _pendingSaveTypes = new Set(); // 支持多种类型同时待保存
const SAVE_DEBOUNCE_MS = 300;
const _recoverySessionTabIds = new Map();

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

function cloneTabData(tabData) {
  return JSON.parse(JSON.stringify(tabData));
}

function appendRecoveryTabs(targetData, recoveryData) {
  const target = targetData?.list;
  const recovery = recoveryData?.list;
  if (!target || !recovery) return false;

  Object.entries(recovery).forEach(([id, tab], index) => {
    let targetId = id;
    while (target[targetId]) {
      targetId = `recovery_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 7)}`;
    }
    target[targetId] = tab;
  });
  return true;
}

function readRecoverySessionRaw() {
  const raw = localStorage.getItem('dsTabs_recovery_session');
  if (!raw) return { raw: null, data: null };
  try {
    const data = decodeTabData(raw);
    return data && data.list && typeof data.list === 'object'
      ? { raw, data }
      : { raw, data: null };
  } catch (_) {
    return { raw, data: null };
  }
}

function writeRecoverySession(currentData) {
  const { raw, data: existing } = readRecoverySessionRaw();
  if (raw && !existing) {
    // 既有恢复区无法解析时，先备份原始值；备份失败则拒绝覆盖唯一副本。
    localStorage.setItem(`dsTabs_recovery_session_corrupted_backup_${Date.now()}`, raw);
  }

  const next = existing ? cloneTabData(existing) : { active: currentData.active, list: {} };
  Object.entries(currentData.list || {}).forEach(([id, tab], index) => {
    let targetId = _recoverySessionTabIds.get(id) || id;
    while (next.list[targetId] && _recoverySessionTabIds.get(id) !== targetId) {
      targetId = `recovery_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 7)}`;
    }
    next.list[targetId] = tab;
    _recoverySessionTabIds.set(id, targetId);
  });
  localStorage.setItem('dsTabs_recovery_session', encodeTabData(next));
  storageRecoveryState.recoverySessionPresent = true;
  return true;
}

function _flushPendingSave(requestedTypes = null) {
  // 指定类型时只从全局队列中取出这些类型，避免一次事务误提交其他数据。
  // 未指定时沿用批量 flush 行为。
  let typesToFlush;
  if (requestedTypes) {
    typesToFlush = new Set();
    requestedTypes.forEach(type => {
      if (_pendingSaveTypes.delete(type)) typesToFlush.add(type);
    });
  } else {
    typesToFlush = _pendingSaveTypes;
    _pendingSaveTypes = new Set();
  }
  _saveDebounceTimer = null;

  // 快照 flush 开始时的可写状态：tabs 分支在检测到指纹冲突时会设置 isReadOnlyPage=true，
  // 该状态污染会导致同一 flush 周期内后续 characters/prompts/favorites 被误跳过。
  // 因此各类型保存分支统一使用快照值，tabs 冲突仅影响 tabs 自身。
  const startedWritable = canModifyPersistedData();

  const failedSaveTypes = new Set();
  const persistedTypes = new Set();
  let wroteAnyData = false;
  let tabsSaved = false;

  if (typesToFlush.has('tabs')) {
    try {
      if (!startedWritable) {
        failedSaveTypes.add('tabs');
        _notifyPersistError('tabs', new Error('当前页面为只读页面，未保存聊天数据'));
      } else if (storageRecoveryState.dsTabsReadFailed) {
        failedSaveTypes.add('tabs');
        _notifyPersistError('tabs', new Error('原 dsTabs 暂不可读取，已暂停自动保存，避免空白数据覆盖原聊天记录'));
      } else {
        const encoded = encodeTabData(state.tabData);
        const latestRaw = localStorage.getItem('dsTabs');
        if (latestRaw !== state.tabDataStorageFingerprint) {
          // 跨页冲突：把当前内存数据尽量落到恢复区（下次启动会弹合并），再切只读。
          try {
            writeRecoverySession(state.tabData);
          } catch (e) {
            failedSaveTypes.add('tabs');
            state.hasUnprotectedMemoryData = true;
            _notifyPersistError('tabs', e);
          }
          state.isReadOnlyPage = true;
          if (!failedSaveTypes.has('tabs')) {
            _notifyPersistError('tabs', new Error('检测到其他页面已更新聊天数据，当前页面已切换为只读，未落盘的内容已进入恢复区'));
          }
        } else {
          localStorage.setItem('dsTabs', encoded);
          state.tabDataStorageFingerprint = encoded;
          wroteAnyData = true;
          tabsSaved = true;
          persistedTypes.add('tabs');
        }
      }
    } catch (e) {
      console.error('保存对话数据失败:', e);
      failedSaveTypes.add('tabs');
      _notifyPersistError('tabs', e);
    }
  }
  // 非 tabs 类型：仅依赖 flush 开始时的快照。tabs 分支即使因指纹冲突转为只读，
  // 也只影响 tabs 自身；角色/指令/收藏并无跨页指纹，与冲突无关，本轮最后一次
  // 落盘必须放行，否则用户的角色/指令/收藏修改会被静默丢失。
  const canSaveNonTabs = startedWritable;
  if (typesToFlush.has('characters')) {
    try {
      if (!canSaveNonTabs) {
        failedSaveTypes.add('characters');
        _notifyPersistError('characters', new Error('当前页面为只读页面，未保存角色数据'));
      } else {
        localStorage.setItem(CHARACTER_STORAGE_KEY, JSON.stringify(state.characterData));
        wroteAnyData = true;
        persistedTypes.add('characters');
      }
    } catch (e) {
      console.error('保存角色数据失败:', e);
      failedSaveTypes.add('characters');
      _notifyPersistError('characters', e);
    }
  }
  if (typesToFlush.has('prompts')) {
    try {
      if (!canSaveNonTabs) {
        failedSaveTypes.add('prompts');
        _notifyPersistError('prompts', new Error('当前页面为只读页面，未保存指令数据'));
      } else {
        localStorage.setItem(PROMPT_STORAGE_KEY, JSON.stringify(state.promptData));
        wroteAnyData = true;
        persistedTypes.add('prompts');
      }
    } catch (e) {
      console.error('保存指令数据失败:', e);
      failedSaveTypes.add('prompts');
      _notifyPersistError('prompts', e);
    }
  }
  if (typesToFlush.has('favorites')) {
    try {
      if (!canSaveNonTabs) {
        failedSaveTypes.add('favorites');
        _notifyPersistError('favorites', new Error('当前页面为只读页面，未保存收藏数据'));
      } else {
        localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(state.favoriteData));
        wroteAnyData = true;
        persistedTypes.add('favorites');
      }
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
  const hasUnrelatedPendingTypes = _pendingSaveTypes.size > 0;
  for (const t of failedSaveTypes) _pendingSaveTypes.add(t);
  // 仅为隔离在本次事务之外的待保存项恢复定时器；失败项不自动重试，避免死循环。
  if (hasUnrelatedPendingTypes && !_saveDebounceTimer) {
    _saveDebounceTimer = setTimeout(_flushPendingSave, SAVE_DEBOUNCE_MS);
  }

  return {
    tabsSaved,
    savedTypes: [...persistedTypes],
    failedTypes: [...failedSaveTypes]
  };
}

export function saveTabs() {
  if (state.isReadOnlyPage || storageRecoveryState.dsTabsReadFailed) return;
  _pendingSaveTypes.add('tabs');
  if (_saveDebounceTimer) clearTimeout(_saveDebounceTimer);
  _saveDebounceTimer = setTimeout(_flushPendingSave, SAVE_DEBOUNCE_MS);
}

export function saveCharacters() {
  if (!canModifyPersistedData()) return;
  _pendingSaveTypes.add('characters');
  if (_saveDebounceTimer) clearTimeout(_saveDebounceTimer);
  _saveDebounceTimer = setTimeout(_flushPendingSave, SAVE_DEBOUNCE_MS);
}

export function savePrompts() {
  if (!canModifyPersistedData()) return;
  _pendingSaveTypes.add('prompts');
  if (_saveDebounceTimer) clearTimeout(_saveDebounceTimer);
  _saveDebounceTimer = setTimeout(_flushPendingSave, SAVE_DEBOUNCE_MS);
}

export function saveFavorites() {
  if (!canModifyPersistedData()) return;
  _pendingSaveTypes.add('favorites');
  if (_saveDebounceTimer) clearTimeout(_saveDebounceTimer);
  _saveDebounceTimer = setTimeout(_flushPendingSave, SAVE_DEBOUNCE_MS);
}

export function flushPendingSaveImmediately(types = null) {
  if (_saveDebounceTimer) clearTimeout(_saveDebounceTimer);
  const requestedTypes = Array.isArray(types) ? new Set(types) : null;
  return _flushPendingSave(requestedTypes);
}

export function hasUnpersistedTabChanges() {
  if (storageRecoveryState.dsTabsReadFailed) return false;
  try {
    return _pendingSaveTypes.has('tabs') ||
      encodeTabData(state.tabData) !== state.tabDataStorageFingerprint;
  } catch (_) {
    // 无法确认时宁可进入恢复区，避免把真实的未保存修改误判为无变化。
    return true;
  }
}

export function getRecoverySession() {
  return readRecoverySessionRaw().data;
}

export function saveRecoverySessionSnapshot() {
  if (storageRecoveryState.dsTabsReadFailed) return false;
  try {
    writeRecoverySession(state.tabData);
    return true;
  } catch (_) {
    return false;
  }
}

export function mergeRecoverySession() {
  if (!canModifyPersistedData()) return false;
  const recovery = getRecoverySession();
  if (!recovery) return false;
  const merged = cloneTabData(state.tabData);
  if (!appendRecoveryTabs(merged, recovery)) return false;

  const originalTabData = state.tabData;
  state.tabData = merged;
  saveTabs();
  const { tabsSaved } = flushPendingSaveImmediately();
  if (!tabsSaved) {
    state.tabData = originalTabData;
    return false;
  }

  try { localStorage.removeItem('dsTabs_recovery_session'); } catch (_) {}
  _recoverySessionTabIds.clear();
  storageRecoveryState.recoverySessionPresent = false;
  updateStorageUsage();
  return true;
}

export function discardRecoverySession(expectedFingerprint = null) {
  if (state.isReadOnlyPage || storageRecoveryState.dsTabsReadFailed) return false;
  try {
    const lock = readPageLock();
    if (!lock || lock.id !== state.pageInstanceId || isPageLockStale(lock)) return false;
    const currentFingerprint = localStorage.getItem('dsTabs_recovery_session');
    if (expectedFingerprint == null || currentFingerprint !== expectedFingerprint) return false;
    localStorage.removeItem('dsTabs_recovery_session');
    if (localStorage.getItem('dsTabs_recovery_session') != null) return false;
    _recoverySessionTabIds.clear();
    storageRecoveryState.recoverySessionPresent = false;
    updateStorageUsage();
    return true;
  } catch (_) {
    return false;
  }
}

export function clearCorruptedBackups() {
  if (state.isReadOnlyPage || storageRecoveryState.dsTabsReadFailed) {
    return { cleared: 0, bytesFreed: 0, blocked: true };
  }

  let cleared = 0;
  let bytesFreed = 0;
  getCorruptedBackupKeys().forEach(key => {
    const bytes = getStoredValueBytes(key);
    try {
      localStorage.removeItem(key);
      if (localStorage.getItem(key) == null) {
        cleared += 1;
        bytesFreed += bytes;
      }
    } catch (_) {}
  });
  updateStorageUsage();
  return { cleared, bytesFreed, blocked: false };
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
- 如果有动作、神态、视线、停顿等描写，请单独放在一行，使用全角括号包裹，例如：\n（抬眸看了你一眼）
- 若有台词，请放在动作描写下一行；不要把动作和台词糊成一整段
- 统一使用简体中文输出，不要使用任何外语`;
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
  const parsed = decodeTabData(raw);
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
    try {
      localStorage.setItem(`dsTabs_corrupted_backup_${Date.now()}`, raw);
    } catch (_) {
      // 备份失败时仍不应清空原数据；后续 setItem 若失败会进入外层 catch。
    }
    localStorage.setItem("dsTabs", encodeTabData(parsed));
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
