/**
 * summary.js — 自动记忆摘要系统
 *
 * 当对话超过 40 条消息时，自动将早期对话压缩成 2000 字以内的摘要。
 * 摘要滚动更新，始终只保留一个。
 */

import { state } from './state.js';
import { callLLM } from './llm.js';
import { saveTabs } from './storage.js';

// ========== 常量 ==========

const SUMMARY_TRIGGER_COUNT = 40;    // 消息数达到 40 条时首次生成摘要
const SUMMARY_UPDATE_INTERVAL = 20;  // 每新增 20 条消息更新一次摘要
const SUMMARY_MAX_CHARS = 2000;      // 摘要最大字数
const SUMMARY_FIRST_COVER = 20;      // 首次摘要覆盖前 20 条消息

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
  try {
    const tab = state.tabData.list[tabId];
    if (!tab || !tab.messages || tab.messages.length < SUMMARY_TRIGGER_COUNT) return;

    if (!tab.summary || tab.summaryCoversUpTo === 0) {
      // 首次生成
      await generateNewSummary(tabId);
    } else if (tab.messages.length - tab.summaryCoversUpTo >= SUMMARY_UPDATE_INTERVAL) {
      // 更新摘要
      await updateExistingSummary(tabId);
    }
  } catch (e) {
    console.warn('摘要生成失败，下次将自动重试:', e.message);
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
    saveTabs();
  }
}

// ========== 内部函数 ==========

/**
 * 首次生成摘要
 */
async function generateNewSummary(tabId) {
  const tab = state.tabData.list[tabId];
  const messagesToSummarize = tab.messages.slice(0, SUMMARY_FIRST_COVER);

  const conversationText = messagesToSummarize.map(m => {
    const role = m.role === 'user' ? '用户' : m.role === 'assistant' ? 'AI' : (m.characterName || '角色');
    const content = typeof m.content === 'string' ? m.content.slice(0, 500) : '';
    return `${role}：${content}`;
  }).join('\n');

  const summary = await callLLM({
    messages: [
      { role: 'system', content: FIRST_SUMMARY_PROMPT },
      { role: 'user', content: conversationText }
    ],
    stream: false,
    temperature: 0.3,
    maxTokens: 1500
  });

  if (summary && summary.trim()) {
    tab.summary = summary.trim();
    tab.summaryCoversUpTo = SUMMARY_FIRST_COVER;
    saveTabs();
    console.log(`[摘要] 首次生成完成，tab=${tabId}，覆盖 ${SUMMARY_FIRST_COVER} 条消息`);
  }
}

/**
 * 更新已有摘要
 */
async function updateExistingSummary(tabId) {
  const tab = state.tabData.list[tabId];
  const startIdx = tab.summaryCoversUpTo;
  const endIdx = tab.messages.length;
  const newMessages = tab.messages.slice(startIdx, endIdx);

  // 新消息文本（每条截断到 500 字，避免 prompt 过长）
  const newConversationText = newMessages.map(m => {
    const role = m.role === 'user' ? '用户' : m.role === 'assistant' ? 'AI' : (m.characterName || '角色');
    const content = typeof m.content === 'string' ? m.content.slice(0, 500) : '';
    return `${role}：${content}`;
  }).join('\n');

  const summary = await callLLM({
    messages: [
      { role: 'system', content: UPDATE_SUMMARY_PROMPT },
      { role: 'user', content: `【旧摘要】\n${tab.summary}\n\n【新增对话】\n${newConversationText}` }
    ],
    stream: false,
    temperature: 0.3,
    maxTokens: 1500
  });

  if (summary && summary.trim()) {
    tab.summary = summary.trim();
    tab.summaryCoversUpTo = endIdx;
    saveTabs();
    console.log(`[摘要] 更新完成，tab=${tabId}，覆盖至第 ${endIdx} 条消息`);
  }
}
