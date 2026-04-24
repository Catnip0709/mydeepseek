/**
 * prompts.js — 指令管理模块
 *
 * 负责指令的 CRUD、AI 优化、插入到新对话等功能。
 */

import { state } from './state.js';
import { escapeHtml, copyText, copyIconSvg, checkIconSvg, editIconSvg, deleteIconSvg } from './utils.js';
import { savePrompts } from './storage.js';
import { showToast, closeSidebar, showConfirmModal } from './panels.js';
import { createNewTab } from './tabs.js';
import { autoHeight } from './chat.js';
import { callLLM } from './llm.js';

// ========== 指令面板管理 ==========

export function openPromptPanel() {
  const promptPanel = document.getElementById('promptPanel');
  promptPanel.classList.remove('hidden');
  showPromptListView();
  renderPromptList();
}

export function closePromptPanel() {
  const promptPanel = document.getElementById('promptPanel');
  promptPanel.classList.add('hidden');
}

function showPromptListView() {
  const promptListView = document.getElementById('promptListView');
  const promptFormView = document.getElementById('promptFormView');
  const promptTitleInput = document.getElementById('promptTitleInput');
  const promptContentInput = document.getElementById('promptContentInput');

  promptListView.classList.remove('hidden');
  promptFormView.classList.add('hidden');
  state.editingPromptId = null;
  promptTitleInput.value = '';
  promptContentInput.value = '';
}

function showPromptFormView(prompt = null) {
  const promptListView = document.getElementById('promptListView');
  const promptFormView = document.getElementById('promptFormView');
  const promptTitleInput = document.getElementById('promptTitleInput');
  const promptContentInput = document.getElementById('promptContentInput');

  promptListView.classList.add('hidden');
  promptFormView.classList.remove('hidden');

  if (prompt) {
    state.editingPromptId = prompt.id;
    promptTitleInput.value = prompt.title || '';
    promptContentInput.value = prompt.content || '';
  } else {
    state.editingPromptId = null;
    promptTitleInput.value = '';
    promptContentInput.value = '';
  }

  setTimeout(() => promptTitleInput.focus(), 50);
}

// ========== 指令列表渲染 ==========

export function renderPromptList() {
  const promptList = document.getElementById('promptList');
  promptList.innerHTML = '';

  if (!state.promptData.length) {
    promptList.innerHTML = `
      <div class="prompt-empty">
        <div class="text-base mb-2">还没有保存任何指令</div>
        <div class="text-sm text-gray-500">你可以新建一些常用指令，比如翻译、润色、总结、角色设定等。</div>
      </div>
    `;
    return;
  }

  state.promptData.forEach(item => {
    const div = document.createElement('div');
    div.className = 'prompt-item';

    const contentText = item.content || '';
    const preview = contentText.length > 100
      ? contentText.slice(0, 100) + '...'
      : contentText;

    div.innerHTML = `
      <div class="prompt-item-header">
        <div class="flex-1 min-w-0">
          <div class="prompt-title">${escapeHtml(item.title || '未命名指令')}</div>
          <div class="prompt-preview">${escapeHtml(preview)}</div>
        </div>
        <div class="prompt-actions">
          <button class="prompt-use-btn" data-id="${item.id}">新建会话并插入指令</button>
          <button class="prompt-icon-btn prompt-copy-btn" data-id="${item.id}" title="复制内容">${copyIconSvg}</button>
          <button class="prompt-icon-btn prompt-edit-btn2" data-id="${item.id}" title="编辑指令">${editIconSvg}</button>
          <button class="prompt-icon-btn prompt-delete-btn2 delete" data-id="${item.id}" title="删除指令">${deleteIconSvg}</button>
        </div>
      </div>
    `;

    promptList.appendChild(div);
  });

  document.querySelectorAll('.prompt-use-btn').forEach(btn => {
    btn.addEventListener('click', function() {
      const id = this.dataset.id;
      const item = state.promptData.find(p => p.id === id);
      if (!item) return;
      insertPromptToNewChat(item.content || '');
    });
  });

  document.querySelectorAll('.prompt-copy-btn').forEach(btn => {
    btn.addEventListener('click', function() {
      const id = this.dataset.id;
      const item = state.promptData.find(p => p.id === id);
      if (!item) return;
      copyText(item.content || '');
      const old = this.innerHTML;
      this.innerHTML = checkIconSvg;
      setTimeout(() => this.innerHTML = old, 1200);
    });
  });

  document.querySelectorAll('.prompt-edit-btn2').forEach(btn => {
    btn.addEventListener('click', function() {
      const id = this.dataset.id;
      const item = state.promptData.find(p => p.id === id);
      if (!item) return;
      showPromptFormView(item);
    });
  });

  document.querySelectorAll('.prompt-delete-btn2').forEach(btn => {
    btn.addEventListener('click', async function() {
      const id = this.dataset.id;
      const item = state.promptData.find(p => p.id === id);
      if (!item) return;
      const confirmed = await showConfirmModal({
        title: '确认删除',
        desc: `确定删除指令「${item.title || '未命名指令'}」吗？`,
        okText: '确认',
        cancelText: '取消'
      });
      if (confirmed) {
        state.promptData = state.promptData.filter(p => p.id !== id);
        savePrompts();
        renderPromptList();
      }
    });
  });
}

// ========== 插入指令到新对话 ==========

export function insertPromptToNewChat(text) {
  if (!text) return;
  createNewTab();
  const input = document.getElementById("input");
  input.value = text;
  autoHeight();
  closePromptPanel();
  closeSidebar();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

// ========== 保存指令 ==========

function savePromptItem() {
  const promptTitleInput = document.getElementById('promptTitleInput');
  const promptContentInput = document.getElementById('promptContentInput');

  const rawTitle = promptTitleInput.value.trim();
  const title = rawTitle || '未命名指令';
  const content = promptContentInput.value.trim();

  if (!content) {
    showToast('请输入指令内容');
    promptContentInput.focus();
    return;
  }

  if (state.editingPromptId) {
    const idx = state.promptData.findIndex(p => p.id === state.editingPromptId);
    if (idx > -1) {
      state.promptData[idx].title = title;
      state.promptData[idx].content = content;
      state.promptData[idx].updatedAt = Date.now();
    } else {
      showToast('该指令已被删除，无法保存');
      state.editingPromptId = null;
    }
  } else {
    state.promptData.unshift({
      id: 'prompt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      title,
      content,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
  }

  savePrompts();
  showPromptListView();
  renderPromptList();
}

// ========== AI 优化指令 ==========

export async function optimizePromptWithAI() {
  if (state.optimizeInProgress) return;
  const promptContentInput = document.getElementById('promptContentInput');
  const optimizePromptBtn = document.getElementById('optimizePromptBtn');
  const keyPanel = document.getElementById('keyPanel');

  const original = promptContentInput.value.trim();

  if (!original) {
    showToast('请先填写指令内容');
    promptContentInput.focus();
    return;
  }

  if (!state.apiKey) {
    keyPanel.classList.remove("hidden");
    return;
  }

  const confirmed = await showConfirmModal({
    title: '智能优化当前指令',
    desc: '我会在尽量不改变原意的前提下，帮你把当前内容整理得更清晰、更自然，并尽量保持接近原长度。是否继续？',
    okText: '开始优化',
    cancelText: '暂不需要'
  });

  if (!confirmed) return;

  state.optimizeInProgress = true;
  const oldHtml = optimizePromptBtn.innerHTML;
  optimizePromptBtn.disabled = true;
  optimizePromptBtn.innerHTML = `<div class="loading-spinner"></div>`;

  try {
    const optimized = await requestOptimizedPrompt(original);
    if (!optimized || !optimized.trim()) {
      throw new Error('AI 未返回有效结果');
    }

    state.optimizedCandidateText = optimized.trim();
    const originalPromptPreview = document.getElementById('originalPromptPreview');
    const optimizedPromptPreview = document.getElementById('optimizedPromptPreview');
    const promptOptimizePreviewPanel = document.getElementById('promptOptimizePreviewPanel');
    originalPromptPreview.textContent = original;
    optimizedPromptPreview.textContent = state.optimizedCandidateText;
    promptOptimizePreviewPanel.classList.remove('hidden');
  } catch (e) {
    console.error(e);
    showToast('AI 优化失败：' + e.message);
  } finally {
    state.optimizeInProgress = false;
    optimizePromptBtn.disabled = false;
    optimizePromptBtn.innerHTML = oldHtml;
  }
}

export async function requestOptimizedPrompt(original) {
  const originalLength = original.length;
  const minLen = Math.max(1, Math.floor(originalLength * 0.9));
  const maxLen = Math.max(minLen, Math.ceil(originalLength * 1.1));
  const approxMaxTokens = Math.max(256, Math.min(1200, Math.ceil(maxLen * 2.2)));

  const messages = [
    {
      role: "system",
      content:
`你是一个擅长优化提示词（Prompt）的助手。

任务要求：
1. 优化用户提供的 prompt，使表达更清晰、结构更自然、指令更明确。
2. 保持用户原意，不要擅自新增明显超出原意的要求。
3. 输出风格应当自然、直接、可立即使用。
4. 控制字数与原文尽量接近，目标范围是原文长度的 90%~110%。
5. 不要解释，不要分析，不要加前言，不要使用标题"优化后"，只输出优化后的 prompt 正文。
6. 如果原文本身就是分点结构，可以保留分点；如果不是，也不要强行过度格式化。`
    },
    {
      role: "user",
      content:
`请帮我优化下面这段 prompt。

原文长度：${originalLength} 字
目标长度范围：${minLen}~${maxLen} 字

原文如下：
${original}`
    }
  ];

  const data = await callLLM({
    model: state.selectedModel,
    messages,
    stream: false,
    temperature: 0.5,
    maxTokens: approxMaxTokens
  });

  let content = typeof data === 'string' ? data : (data?.content || '');

  content = String(content).trim()
    .replace(/^```[\w-]*\n?/i, '')
    .replace(/\n?```$/, '')
    .trim();

  return content;
}

// ========== 优化预览面板 ==========

export function closeOptimizePreviewPanel() {
  const promptOptimizePreviewPanel = document.getElementById('promptOptimizePreviewPanel');
  const originalPromptPreview = document.getElementById('originalPromptPreview');
  const optimizedPromptPreview = document.getElementById('optimizedPromptPreview');
  promptOptimizePreviewPanel.classList.add('hidden');
  originalPromptPreview.textContent = '';
  optimizedPromptPreview.textContent = '';
  state.optimizedCandidateText = '';
}

export function applyOptimizedPrompt() {
  const promptContentInput = document.getElementById('promptContentInput');
  if (!state.optimizedCandidateText) {
    closeOptimizePreviewPanel();
    return;
  }
  promptContentInput.value = state.optimizedCandidateText;
  closeOptimizePreviewPanel();
  showToast('已替换为优化结果');
}

// ========== 指令管理事件绑定 ==========

export function bindPromptEvents() {
  const openPromptManagerBtn = document.getElementById('openPromptManagerBtn');
  const closePromptPanelBtn = document.getElementById('closePromptPanelBtn');
  const promptPanel = document.getElementById('promptPanel');
  const addPromptBtn = document.getElementById('addPromptBtn');
  const cancelPromptEditBtn = document.getElementById('cancelPromptEditBtn');
  const savePromptBtn = document.getElementById('savePromptBtn');
  const optimizePromptBtn = document.getElementById('optimizePromptBtn');
  const discardOptimizedPromptBtn = document.getElementById('discardOptimizedPromptBtn');
  const applyOptimizedPromptBtn = document.getElementById('applyOptimizedPromptBtn');
  const promptOptimizePreviewPanel = document.getElementById('promptOptimizePreviewPanel');

  if (openPromptManagerBtn) openPromptManagerBtn.addEventListener('click', () => {
    closeSidebar();
    openPromptPanel();
  });

  if (closePromptPanelBtn) closePromptPanelBtn.addEventListener('click', closePromptPanel);
  if (promptPanel) promptPanel.addEventListener('click', (e) => {
    if (e.target === promptPanel) closePromptPanel();
  });

  if (addPromptBtn) addPromptBtn.addEventListener('click', () => showPromptFormView());
  if (cancelPromptEditBtn) cancelPromptEditBtn.addEventListener('click', showPromptListView);
  if (savePromptBtn) savePromptBtn.addEventListener('click', savePromptItem);
  if (optimizePromptBtn) optimizePromptBtn.addEventListener('click', optimizePromptWithAI);

  if (discardOptimizedPromptBtn) discardOptimizedPromptBtn.addEventListener('click', closeOptimizePreviewPanel);
  if (applyOptimizedPromptBtn) applyOptimizedPromptBtn.addEventListener('click', applyOptimizedPrompt);
  if (promptOptimizePreviewPanel) promptOptimizePreviewPanel.addEventListener('click', (e) => {
    if (e.target === promptOptimizePreviewPanel) closeOptimizePreviewPanel();
  });
}
