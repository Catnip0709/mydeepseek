/**
 * storage.js — 数据持久化模块
 *
 * 负责 localStorage 的读写、存储用量统计、数据构建等。
 */

import { state, CHARACTER_STORAGE_KEY, PROMPT_STORAGE_KEY, MAX_CONTEXT_TOKENS } from './state.js';
import { formatBytes, estimateTokensByText, countChars, estimateTokensByChars } from './utils.js';

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
let _pendingSaveType = null; // 'tabs' | 'characters' | 'prompts' | null
const SAVE_DEBOUNCE_MS = 300;

function _flushPendingSave() {
  if (_pendingSaveType === 'tabs') {
    localStorage.setItem("dsTabs", JSON.stringify(state.tabData));
  } else if (_pendingSaveType === 'characters') {
    localStorage.setItem(CHARACTER_STORAGE_KEY, JSON.stringify(state.characterData));
  } else if (_pendingSaveType === 'prompts') {
    localStorage.setItem(PROMPT_STORAGE_KEY, JSON.stringify(state.promptData));
  }
  if (_pendingSaveType) {
    updateStorageUsage();
  }
  _pendingSaveType = null;
  _saveDebounceTimer = null;
}

export function saveTabs() {
  _pendingSaveType = 'tabs';
  if (_saveDebounceTimer) clearTimeout(_saveDebounceTimer);
  _saveDebounceTimer = setTimeout(_flushPendingSave, SAVE_DEBOUNCE_MS);
}

export function saveCharacters() {
  _pendingSaveType = 'characters';
  if (_saveDebounceTimer) clearTimeout(_saveDebounceTimer);
  _saveDebounceTimer = setTimeout(_flushPendingSave, SAVE_DEBOUNCE_MS);
}

export function savePrompts() {
  _pendingSaveType = 'prompts';
  if (_saveDebounceTimer) clearTimeout(_saveDebounceTimer);
  _saveDebounceTimer = setTimeout(_flushPendingSave, SAVE_DEBOUNCE_MS);
}

export function flushPendingSaveImmediately() {
  if (_saveDebounceTimer) clearTimeout(_saveDebounceTimer);
  _flushPendingSave();
}

// ========== Token 限制检查 ==========

export function isTokenLimitReached() {
  const currentMsgs = state.tabData.list[state.tabData.active].messages || [];
  const payloadMsgs = buildPayloadMessages(currentMsgs);
  let estimatedTokens = 0;
  payloadMsgs.forEach(m => {
    estimatedTokens += estimateTokensByText(m.content);
  });
  return estimatedTokens >= MAX_CONTEXT_TOKENS * 0.98;
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

export function buildPayloadMessages(messages, endExclusive = messages.length) {
  let payloadMsgs = messages.slice(0, endExclusive).map(m => ({
    role: m.role,
    content: m.content
  }));

  const limit = parseInt(state.globalMemoryLimit || "0");
  if (limit > 0 && payloadMsgs.length > limit) {
    payloadMsgs = payloadMsgs.slice(-limit);
  }

  const currentTab = state.tabData.list[state.tabData.active];

  // 构建背景信息（所有会话类型通用）
  let bgInfoParts = [];
  if (currentTab && currentTab.userRoleName) {
    bgInfoParts.push(`用户在对话中的角色是「${currentTab.userRoleName}」，请以此称呼用户。`);
  }
  if (currentTab && currentTab.storyBackground) {
    bgInfoParts.push(`当前对话背景：${currentTab.storyBackground}`);
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
  } else if (bgInfoParts.length > 0) {
    // 单聊等其他类型：注入背景信息
    payloadMsgs.unshift({ role: "system", content: bgInfoParts.join('\n') });
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
- 用自然的对话方式回复，不要过于生硬`;
}

// ========== 构建用户输入元信息 ==========

export function buildUserInputMeta(messages, userIndex) {
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

// ========== 数据初始化与修复 ==========

export function initializeData() {
  // 修复 tabData 结构
  Object.keys(state.tabData.list).forEach(id => {
    if (Array.isArray(state.tabData.list[id])) {
      state.tabData.list[id] = { messages: state.tabData.list[id], memoryLimit: "0", title: "" };
    } else {
      if (typeof state.tabData.list[id].title === 'undefined') state.tabData.list[id].title = "";
      if (typeof state.tabData.list[id].memoryLimit === 'undefined') state.tabData.list[id].memoryLimit = "0";
      if (!Array.isArray(state.tabData.list[id].messages)) state.tabData.list[id].messages = [];
    }

    state.tabData.list[id].messages.forEach(msg => {
      if (msg.history && typeof msg.history[0] === 'string') {
        msg.history = msg.history.map(content => ({ content: content, reasoningContent: "" }));
      }
    });
  });

  // 初始化存储用量
  updateStorageUsage();
}

// ========== 数据修复（错误恢复时使用） ==========

export function repairData() {
  const raw = localStorage.getItem("dsTabs");
  const parsed = JSON.parse(raw);
  if (parsed && parsed.list && typeof parsed.list === 'object') {
    Object.keys(parsed.list).forEach(function(id) {
      const tab = parsed.list[id];
      if (Array.isArray(tab)) {
        parsed.list[id] = { messages: tab, memoryLimit: "0", title: "" };
      } else {
        tab.messages = Array.isArray(tab.messages) ? tab.messages : [];
        tab.memoryLimit = tab.memoryLimit || "0";
        tab.title = tab.title || "";
        tab.messages.forEach(function(msg) {
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
    location.reload();
  } else {
    throw new Error('tabData 结构无效');
  }
}
