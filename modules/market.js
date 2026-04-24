/**
 * market.js — 指令市场模块
 *
 * 负责指令市场的随机获取、刷新、保存、AI 生成等功能。
 */

import { state } from './state.js';
import { showToast, closeSidebar } from './panels.js';
import { savePrompts } from './storage.js';
import { createNewTab } from './tabs.js';
import { autoHeight } from './chat.js';
import { callLLM } from './llm.js';

// ========== 指令市场预设指令 ==========

// MARKET_PROMPTS 在 prompts.js 中定义（全局变量）
function getMarketPrompts() {
  if (!Array.isArray(window.MARKET_PROMPTS)) {
    window.MARKET_PROMPTS = typeof MARKET_PROMPTS !== 'undefined' && Array.isArray(MARKET_PROMPTS)
      ? MARKET_PROMPTS
      : [];
  }
  return window.MARKET_PROMPTS;
}

// ========== 随机获取指令 ==========

export function getRandomPrompt() {
  const prompts = getMarketPrompts();
  let newIndex;
  do {
    newIndex = Math.floor(Math.random() * prompts.length);
  } while (newIndex === state.lastShownPromptIndex && prompts.length > 1);

  state.lastShownPromptIndex = newIndex;
  return prompts[newIndex];
}

// ========== 渲染指令市场 ==========

function renderMarketPrompt() {
  state.currentMarketPrompt = getRandomPrompt();
  const promptMarketContent = document.getElementById('promptMarketContent');
  promptMarketContent.value = state.currentMarketPrompt.content;
}

// ========== 刷新指令市场 ==========

export function refreshMarketPrompt() {
  const refreshPromptMarketBtn = document.getElementById('refreshPromptMarketBtn');
  refreshPromptMarketBtn.classList.add('spinning');
  setTimeout(() => {
    renderMarketPrompt();
    refreshPromptMarketBtn.classList.remove('spinning');
  }, 300);
}

// ========== 智能生成标题 ==========

export function generatePromptTitle(content) {
  const cleanContent = content.trim();

  let text = cleanContent
    .replace(/^(请|现在|咱们|我们|你是|我是|来玩|假设|假如|如果)\s*/, '')
    .replace(/^(【|「|『)/, '')
    .replace(/^(》|」|』)/, '');

  let firstSentence = text.split(/[。！？\n]/)[0].trim();

  if (!firstSentence || firstSentence.length === 0) {
    return '未命名指令';
  }

  if (firstSentence.includes('扮演') || firstSentence.includes('是一个') || firstSentence.includes('是我的')) {
    const roleMatch = firstSentence.match(/扮演(.+?)(，|。|！|$)/) ||
                      firstSentence.match(/是一个(.+?)(，|。|！|$)/) ||
                      firstSentence.match(/是我的(.+?)(，|。|！|$)/);
    if (roleMatch && roleMatch[1]) {
      const role = roleMatch[1].trim();
      if (role.length <= 10) {
        return role;
      }
    }
  }

  if (firstSentence.includes('游戏') || firstSentence.includes('挑战') || firstSentence.includes('玩')) {
    const gameMatch = firstSentence.match(/(?:来玩|玩|我们玩|来玩一个|玩一个)?(.+?)(?:游戏|挑战|小游戏)(，|。|！|$)/);
    if (gameMatch && gameMatch[1]) {
      const gameName = gameMatch[1].trim();
      if (gameName && gameName.length > 0) {
        return gameName.length <= 15 ? gameName : gameName.substring(0, 15) + '...';
      }
    }
  }

  let title = firstSentence;
  if (title.length > 15) {
    title = title.substring(0, 15) + '...';
  }

  return title || '未命名指令';
}

// ========== 保存到指令管理 ==========

export function saveCurrentPromptToManager() {
  const promptMarketContent = document.getElementById('promptMarketContent');
  const content = promptMarketContent.value.trim();
  if (!content) {
    showToast('指令内容不能为空');
    return;
  }

  const title = generatePromptTitle(content);

  state.promptData.unshift({
    id: 'prompt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    title: title,
    content: content,
    createdAt: Date.now(),
    updatedAt: Date.now()
  });

  savePrompts();
  showToast('已保存到指令管理');
}

// ========== 新建对话并插入指令 ==========

export function createChatWithMarketPrompt() {
  const promptMarketContent = document.getElementById('promptMarketContent');
  const content = promptMarketContent.value.trim();
  if (!content) {
    showToast('指令内容不能为空');
    return;
  }

  createNewTab();
  const input = document.getElementById("input");
  input.value = content;
  autoHeight();
  closePromptMarketPanel();
  closeSidebar();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

// ========== 指令市场面板 ==========

export async function openPromptMarketPanel() {
  const promptMarketPanel = document.getElementById('promptMarketPanel');
  promptMarketPanel.classList.remove('hidden');
  renderMarketPrompt();
}

export function closePromptMarketPanel() {
  const promptMarketPanel = document.getElementById('promptMarketPanel');
  promptMarketPanel.classList.add('hidden');
}

// ========== AI 生成指令 ==========

function openAiGeneratePanel() {
  const aiPromptInput = document.getElementById('aiPromptInput');
  const aiGeneratePromptPanel = document.getElementById('aiGeneratePromptPanel');
  aiPromptInput.value = '';
  aiGeneratePromptPanel.classList.remove('hidden');
  setTimeout(() => aiPromptInput.focus(), 50);
}

export function closeAiGeneratePanel() {
  const aiGeneratePromptPanel = document.getElementById('aiGeneratePromptPanel');
  aiGeneratePromptPanel.classList.add('hidden');
}

export async function generatePromptWithAI() {
  const aiPromptInput = document.getElementById('aiPromptInput');
  const aiGenerateBtnText = document.getElementById('aiGenerateBtnText');
  const aiGenerateSpinner = document.getElementById('aiGenerateSpinner');
  const confirmAiGenerateBtn = document.getElementById('confirmAiGenerateBtn');
  const keyPanel = document.getElementById('keyPanel');

  const userInput = aiPromptInput.value.trim();
  if (!userInput) {
    alert('请输入关键词或描述');
    aiPromptInput.focus();
    return;
  }

  if (!state.apiKey) {
    keyPanel.classList.remove("hidden");
    return;
  }

  aiGenerateBtnText.textContent = '生成中...';
  aiGenerateSpinner.classList.remove('hidden');
  confirmAiGenerateBtn.disabled = true;

  try {
    const generatedPrompt = await requestGeneratedPrompt(userInput);
    if (!generatedPrompt || !generatedPrompt.trim()) {
      throw new Error('AI 未返回有效结果');
    }

    state.currentMarketPrompt = { content: generatedPrompt.trim() };
    const promptMarketContent = document.getElementById('promptMarketContent');
    promptMarketContent.value = state.currentMarketPrompt.content;

    closeAiGeneratePanel();
    showToast('指令生成成功！');
  } catch (e) {
    console.error(e);
    alert('AI 生成失败：' + e.message);
  } finally {
    aiGenerateBtnText.textContent = '生成指令';
    aiGenerateSpinner.classList.add('hidden');
    confirmAiGenerateBtn.disabled = false;
  }
}

async function requestGeneratedPrompt(userInput) {
  const messages = [
    {
      role: "user",
      content: `请生成跟AI进行角色扮演的prompt，仅生成Prompt（约80-120字），不要说别的。用户的输入为：${userInput}`
    }
  ];

  const text = await callLLM({
    model: state.selectedModel,
    messages,
    stream: false,
    temperature: 0.8,
    maxTokens: 300
  });

  let content = (typeof text === 'string' ? text : (text?.content || '')).trim()
    .replace(/^```[\w-]*\n?/i, '')
    .replace(/\n?```$/, '')
    .trim();

  return content;
}

// ========== 指令市场事件绑定 ==========

export function bindMarketEvents() {
  const openPromptMarketBtn = document.getElementById('openPromptMarketBtn');
  const closePromptMarketBtn = document.getElementById('closePromptMarketBtn');
  const refreshPromptMarketBtn = document.getElementById('refreshPromptMarketBtn');
  const saveToPromptManagerBtn = document.getElementById('saveToPromptManagerBtn');
  const createChatWithPromptBtn = document.getElementById('createChatWithPromptBtn');
  const aiGeneratePromptBtn = document.getElementById('aiGeneratePromptBtn');
  const closeAiGenerateBtn = document.getElementById('closeAiGenerateBtn');
  const cancelAiGenerateBtn = document.getElementById('cancelAiGenerateBtn');
  const aiGeneratePromptPanel = document.getElementById('aiGeneratePromptPanel');
  const confirmAiGenerateBtn = document.getElementById('confirmAiGenerateBtn');
  const promptMarketPanel = document.getElementById('promptMarketPanel');
  const openMarketFromHint = document.getElementById('openMarketFromHint');

  if (openPromptMarketBtn) openPromptMarketBtn.addEventListener('click', () => {
    closeSidebar();
    openPromptMarketPanel();
  });

  if (openMarketFromHint) openMarketFromHint.addEventListener('click', () => {
    openPromptMarketPanel();
  });

  if (closePromptMarketBtn) closePromptMarketBtn.addEventListener('click', closePromptMarketPanel);
  if (promptMarketPanel) promptMarketPanel.addEventListener('click', (e) => {
    if (e.target === promptMarketPanel) closePromptMarketPanel();
  });

  if (refreshPromptMarketBtn) refreshPromptMarketBtn.addEventListener('click', refreshMarketPrompt);
  if (saveToPromptManagerBtn) saveToPromptManagerBtn.addEventListener('click', saveCurrentPromptToManager);
  if (createChatWithPromptBtn) createChatWithPromptBtn.addEventListener('click', createChatWithMarketPrompt);

  if (aiGeneratePromptBtn) aiGeneratePromptBtn.addEventListener('click', openAiGeneratePanel);
  if (closeAiGenerateBtn) closeAiGenerateBtn.addEventListener('click', closeAiGeneratePanel);
  if (cancelAiGenerateBtn) cancelAiGenerateBtn.addEventListener('click', closeAiGeneratePanel);
  if (aiGeneratePromptPanel) aiGeneratePromptPanel.addEventListener('click', (e) => {
    if (e.target === aiGeneratePromptPanel) closeAiGeneratePanel();
  });
  if (confirmAiGenerateBtn) confirmAiGenerateBtn.addEventListener('click', generatePromptWithAI);
}
