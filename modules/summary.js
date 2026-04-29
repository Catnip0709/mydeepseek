/**
 * summary.js — 自动记忆摘要系统
 *
 * 当对话超过 40 条消息时，自动将早期对话压缩成 6000 字以内的摘要。
 * 摘要滚动更新，始终只保留一个。
 */

import { state, MEMORY_STRATEGY_FULL } from './state.js';
import { callLLM } from './llm.js';
import { isHtmlRelatedMessage } from './utils.js';
import { saveTabs, tabHasCurrentSummaryVersion } from './storage.js';
import { SUMMARY_RECENT_RAW_COUNT, SUMMARY_FORMAT_VERSION } from './memory-config.js';

// ========== 常量 ==========

const SUMMARY_TRIGGER_COUNT = 40;    // 消息数达到 40 条时首次生成摘要
const SUMMARY_UPDATE_INTERVAL = 20;  // 每新增 20 条可摘要消息时更新一次摘要
const SUMMARY_MAX_CHARS = 6000;      // 摘要最大字数
const SUMMARY_MAX_TOKENS = 6000;     // 为 6000 字摘要预留足够输出空间
let _legacyMigrationPromise = null;
const _summaryJobStates = new Map();

// ========== Prompt 模板 ==========

const FIRST_SUMMARY_PROMPT = `请将以下对话内容压缩成摘要，保留以下关键信息：
1. 角色设定（外貌、性格、口头禅、特殊习惯）
2. 角色关系进展
3. 已发生的重要剧情事件和伏笔
4. 用户特别强调的要求或偏好（如写作风格、特殊设定）

用简洁的条目式输出，不超过 ${SUMMARY_MAX_CHARS} 字。
只输出摘要内容，不要输出其他说明。`;

const UPDATE_SUMMARY_PROMPT = `这是之前的对话摘要和新发生的对话内容。
请将新信息合并到摘要中，保持格式不变，不超过 ${SUMMARY_MAX_CHARS} 字。
保留角色设定、关系进展、重要事件、伏笔、用户偏好。
只输出更新后的摘要内容，不要输出其他说明。`;

// ========== 公开函数 ==========

/**
 * 检查并生成/更新摘要（异步，不阻塞对话）
 * @param {string} tabId - 对话 ID
 */
export async function checkAndGenerateSummary(tabId) {
  // 全量模式：不生成摘要
  if (state.memoryStrategy === MEMORY_STRATEGY_FULL) {
    return;
  }

  return runExclusiveSummaryJob(tabId, async () => {
    try {
      const tab = state.tabData.list[tabId];
      if (!tab || !tab.messages || tab.messages.length < SUMMARY_TRIGGER_COUNT) return;

      const targetCover = getTargetSummaryCoverIndex(tab.messages.length);
      if (targetCover <= 0) return;

      // 兼容旧数据：旧摘要没有当前版本标记时，统一按新边界重建。
      if (tab.summary && !tabHasCurrentSummaryVersion(tab)) {
        await rebuildSummaryToCover(tabId, targetCover);
        return;
      }

      if (!tab.summary || tab.summaryCoversUpTo === 0) {
        // 首次生成
        await generateNewSummary(tabId);
      } else if (targetCover - tab.summaryCoversUpTo >= SUMMARY_UPDATE_INTERVAL) {
        // 更新摘要
        await updateExistingSummary(tabId);
      }
    } catch (e) {
      console.warn('摘要生成失败，下次将自动重试:', e.message);
    }
  });
}

export async function migrateLegacySummaryForTab(tabId) {
  // 全量模式：不迁移旧摘要
  if (state.memoryStrategy === MEMORY_STRATEGY_FULL) {
    return { migrated: false, skipped: true };
  }

  if (!state.apiKey) return { migrated: false, skipped: true };

  const tab = state.tabData.list[tabId];
  if (!tab || !tab.summary || !tab.messages || tab.messages.length < SUMMARY_TRIGGER_COUNT) {
    return { migrated: false, skipped: false };
  }

  const targetCover = getTargetSummaryCoverIndex(tab.messages.length);
  if (targetCover <= 0) return { migrated: false, skipped: false };
  if (tabHasCurrentSummaryVersion(tab) && tab.summaryCoversUpTo <= targetCover) {
    return { migrated: false, skipped: false };
  }

  await runExclusiveSummaryJob(tabId, () => rebuildSummaryToCover(tabId, targetCover));
  const currentTab = state.tabData.list[tabId];
  return {
    migrated: !!(currentTab && currentTab.summaryVersion === SUMMARY_FORMAT_VERSION && currentTab.summaryCoversUpTo === targetCover),
    skipped: false
  };
}

export async function migrateLegacySummariesOnInit() {
  // 全量模式：不迁移旧摘要
  if (state.memoryStrategy === MEMORY_STRATEGY_FULL) {
    return { migratedTabIds: [], skipped: true };
  }

  if (_legacyMigrationPromise) return _legacyMigrationPromise;

  _legacyMigrationPromise = (async () => {
    if (!state.apiKey) return { migratedTabIds: [], skipped: true };

    const activeTabId = state.tabData.active;
    const allTabIds = Object.keys(state.tabData.list || {});
    const orderedTabIds = activeTabId
      ? [activeTabId, ...allTabIds.filter(id => id !== activeTabId)]
      : allTabIds;
    const migratedTabIds = [];

    for (const tabId of orderedTabIds) {
      try {
        const result = await migrateLegacySummaryForTab(tabId);
        if (result.migrated) migratedTabIds.push(tabId);
      } catch (e) {
        console.warn(`[摘要] 初始化迁移失败，tab=${tabId}:`, e.message);
      }
    }

    return { migratedTabIds, skipped: false };
  })();

  try {
    return await _legacyMigrationPromise;
  } finally {
    _legacyMigrationPromise = null;
  }
}

/**
 * 清除指定对话的摘要（编辑/删除早期消息时调用）
 * @param {string} tabId - 对话 ID
 */
export function clearSummary(tabId) {
  const tab = state.tabData.list[tabId];
  if (tab) {
    tab.summary = '';
    tab.summaryCoversUpTo = 0;
    tab.summaryVersion = '';
    saveTabs();
  }
}

// ========== 内部函数 ==========

function getTargetSummaryCoverIndex(totalMessages) {
  return Math.max(totalMessages - SUMMARY_RECENT_RAW_COUNT, 0);
}

function getSummaryJobState(tabId) {
  if (!_summaryJobStates.has(tabId)) {
    _summaryJobStates.set(tabId, {
      running: false,
      queuedJobFn: null,
      promise: null
    });
  }
  return _summaryJobStates.get(tabId);
}

function runExclusiveSummaryJob(tabId, jobFn) {
  const jobState = getSummaryJobState(tabId);
  if (jobState.running) {
    jobState.queuedJobFn = jobFn;
    return jobState.promise;
  }

  jobState.running = true;
  jobState.promise = (async () => {
    let currentJobFn = jobFn;
    while (currentJobFn) {
      jobState.queuedJobFn = null;
      await currentJobFn();
      currentJobFn = jobState.queuedJobFn;
    }
  })().finally(() => {
    jobState.running = false;
    jobState.promise = null;
    jobState.queuedJobFn = null;
    _summaryJobStates.delete(tabId);
  });

  return jobState.promise;
}

function buildConversationText(messages) {
  return messages.map(m => {
    const role = m.role === 'user' ? '用户' : m.role === 'assistant' ? 'AI' : (m.characterName || '角色');
    const content = typeof m.content === 'string' ? m.content : '';
    return `${role}：${content}`;
  }).join('\n');
}

async function requestFullSummaryFromMessages(messages) {
  const conversationText = buildConversationText(messages);

  return callLLM({
    model: state.selectedModel,
    messages: [
      { role: 'system', content: FIRST_SUMMARY_PROMPT },
      { role: 'user', content: conversationText }
    ],
    stream: false,
    temperature: 0.3,
    maxTokens: SUMMARY_MAX_TOKENS
  });
}

function isConversationSnapshotUnchanged(tabId, startIdx, endIdx, expectedText) {
  const tab = state.tabData.list[tabId];
  if (!tab) return false;
  const currentMessages = tab.messages.slice(startIdx, endIdx).filter(m => !isHtmlRelatedMessage(m));
  return buildConversationText(currentMessages) === expectedText;
}

/**
 * 首次生成摘要
 */
async function generateNewSummary(tabId) {
  const tab = state.tabData.list[tabId];
  const targetCover = getTargetSummaryCoverIndex(tab.messages.length);
  if (targetCover <= 0) return;
  const messagesToSummarize = tab.messages.slice(0, targetCover).filter(m => !isHtmlRelatedMessage(m));
  const conversationText = buildConversationText(messagesToSummarize);
  const rawSummary = await requestFullSummaryFromMessages(messagesToSummarize);
  const summary = typeof rawSummary === 'string' ? rawSummary : (rawSummary?.content || '');

  if (!summary || !summary.trim()) return;

  const currentTab = state.tabData.list[tabId];
  if (!currentTab) return;
  const currentTargetCover = getTargetSummaryCoverIndex(currentTab.messages.length);
  if (currentTargetCover !== targetCover) return;
  if (currentTab.summary && currentTab.summaryCoversUpTo > 0) return;
  if (!isConversationSnapshotUnchanged(tabId, 0, targetCover, conversationText)) return;

  currentTab.summary = summary.trim();
  currentTab.summaryCoversUpTo = targetCover;
  currentTab.summaryVersion = SUMMARY_FORMAT_VERSION;
  saveTabs();
  console.log(`[摘要] 首次生成完成，tab=${tabId}，覆盖 ${targetCover} 条消息，保留最近 ${SUMMARY_RECENT_RAW_COUNT} 条原文`);
}

async function rebuildSummaryToCover(tabId, coverIdx) {
  const tab = state.tabData.list[tabId];
  if (!tab || coverIdx <= 0) return;

  const messagesToSummarize = tab.messages.slice(0, coverIdx).filter(m => !isHtmlRelatedMessage(m));
  const conversationText = buildConversationText(messagesToSummarize);
  const rawSummary = await requestFullSummaryFromMessages(messagesToSummarize);
  const summary = typeof rawSummary === 'string' ? rawSummary : (rawSummary?.content || '');
  if (!summary || !summary.trim()) return;

  const currentTab = state.tabData.list[tabId];
  if (!currentTab) return;

  const currentTargetCover = getTargetSummaryCoverIndex(currentTab.messages.length);
  if (currentTargetCover !== coverIdx) return;
  if (!isConversationSnapshotUnchanged(tabId, 0, coverIdx, conversationText)) return;

  currentTab.summary = summary.trim();
  currentTab.summaryCoversUpTo = coverIdx;
  currentTab.summaryVersion = SUMMARY_FORMAT_VERSION;
  saveTabs();
  console.log(`[摘要] 已按滑动窗口重建，tab=${tabId}，覆盖至第 ${coverIdx} 条消息`);
}

/**
 * 更新已有摘要
 */
async function updateExistingSummary(tabId) {
  const tab = state.tabData.list[tabId];
  const startIdx = tab.summaryCoversUpTo;
  const endIdx = getTargetSummaryCoverIndex(tab.messages.length);
  if (endIdx <= startIdx) return;
  const newMessages = tab.messages.slice(startIdx, endIdx).filter(m => !isHtmlRelatedMessage(m));
  const baseSummary = tab.summary;

  // 新消息文本（保留完整消息，避免摘要遗漏关键细节）
  const newConversationText = buildConversationText(newMessages);

  const result = await callLLM({
    model: state.selectedModel,
    messages: [
      { role: 'system', content: UPDATE_SUMMARY_PROMPT },
      { role: 'user', content: `【旧摘要】\n${baseSummary}\n\n【新增对话】\n${newConversationText}` }
    ],
    stream: false,
    temperature: 0.3,
    maxTokens: SUMMARY_MAX_TOKENS
  });

  const summary = typeof result === 'string' ? result : (result?.content || '');

  if (!summary || !summary.trim()) return;

  const currentTab = state.tabData.list[tabId];
  if (!currentTab) return;
  const currentTargetCover = getTargetSummaryCoverIndex(currentTab.messages.length);
  if (currentTargetCover !== endIdx) return;
  if (currentTab.summaryCoversUpTo !== startIdx) return;
  if ((currentTab.summary || '') !== (baseSummary || '')) return;
  if (!isConversationSnapshotUnchanged(tabId, startIdx, endIdx, newConversationText)) return;

  currentTab.summary = summary.trim();
  currentTab.summaryCoversUpTo = endIdx;
  currentTab.summaryVersion = SUMMARY_FORMAT_VERSION;
  saveTabs();
  console.log(`[摘要] 更新完成，tab=${tabId}，覆盖至第 ${endIdx} 条消息，保留最近 ${SUMMARY_RECENT_RAW_COUNT} 条原文`);
}
