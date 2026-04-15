// app-prompts.js - 指令管理
(function() {
  'use strict';
  const App = window.App;

  // DOM 元素
  const promptPanel = document.getElementById('promptPanel');
  const promptListView = document.getElementById('promptListView');
  const promptFormView = document.getElementById('promptFormView');
  const promptList = document.getElementById('promptList');
  const promptTitleInput = document.getElementById('promptTitleInput');
  const promptContentInput = document.getElementById('promptContentInput');
  const promptOptimizePreviewPanel = document.getElementById('promptOptimizePreviewPanel');
  const originalPromptPreview = document.getElementById('originalPromptPreview');
  const optimizedPromptPreview = document.getElementById('optimizedPromptPreview');
  const openPromptManagerBtn = document.getElementById('openPromptManagerBtn');
  const closePromptPanelBtn = document.getElementById('closePromptPanelBtn');
  const addPromptBtn = document.getElementById('addPromptBtn');
  const cancelPromptEditBtn = document.getElementById('cancelPromptEditBtn');
  const savePromptBtn = document.getElementById('savePromptBtn');
  const optimizePromptBtn = document.getElementById('optimizePromptBtn');
  const discardOptimizedPromptBtn = document.getElementById('discardOptimizedPromptBtn');
  const applyOptimizedPromptBtn = document.getElementById('applyOptimizedPromptBtn');

  // 状态
  let optimizedCandidateText = '';
  let optimizeInProgress = false;

  // 图标 SVG
  const copyIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
  const deleteIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`;
  const editIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"></path></svg>`;
  const checkIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;

  // 面板控制
  function openPromptPanel() {
    promptPanel.classList.remove('hidden');
    showPromptListView();
    renderPromptList();
  }

  function closePromptPanel() {
    promptPanel.classList.add('hidden');
  }

  // 视图切换
  function showPromptListView() {
    promptListView.classList.remove('hidden');
    promptFormView.classList.add('hidden');
    App.editingPromptId = null;
    promptTitleInput.value = '';
    promptContentInput.value = '';
  }

  function showPromptFormView(prompt = null) {
    promptListView.classList.add('hidden');
    promptFormView.classList.remove('hidden');

    if (prompt) {
      App.editingPromptId = prompt.id;
      promptTitleInput.value = prompt.title || '';
      promptContentInput.value = prompt.content || '';
    } else {
      App.editingPromptId = null;
      promptTitleInput.value = '';
      promptContentInput.value = '';
    }

    setTimeout(() => promptTitleInput.focus(), 50);
  }

  // 渲染
  function renderPromptList() {
    promptList.innerHTML = '';

    if (!App.promptData.length) {
      promptList.innerHTML = `
        <div class="prompt-empty">
          <div class="text-base mb-2">还没有保存任何指令</div>
          <div class="text-sm text-gray-500">你可以新建一些常用指令，比如翻译、润色、总结、角色设定等。</div>
        </div>
      `;
      return;
    }

    App.promptData.forEach(item => {
      const div = document.createElement('div');
      div.className = 'prompt-item';

      const contentText = item.content || '';
      const preview = contentText.length > 100
        ? contentText.slice(0, 100) + '...'
        : contentText;

      div.innerHTML = `
        <div class="prompt-item-header">
          <div class="flex-1 min-w-0">
            <div class="prompt-title">${App.escapeHtml(item.title || '未命名指令')}</div>
            <div class="prompt-preview">${App.escapeHtml(preview)}</div>
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
        const item = App.promptData.find(p => p.id === id);
        if (!item) return;
        insertPromptToNewChat(item.content || '');
      });
    });

    document.querySelectorAll('.prompt-copy-btn').forEach(btn => {
      btn.addEventListener('click', function() {
        const id = this.dataset.id;
        const item = App.promptData.find(p => p.id === id);
        if (!item) return;
        App.copyText(item.content || '');
        const old = this.innerHTML;
        this.innerHTML = checkIconSvg;
        setTimeout(() => this.innerHTML = old, 1200);
      });
    });

    document.querySelectorAll('.prompt-edit-btn2').forEach(btn => {
      btn.addEventListener('click', function() {
        const id = this.dataset.id;
        const item = App.promptData.find(p => p.id === id);
        if (!item) return;
        showPromptFormView(item);
      });
    });

    document.querySelectorAll('.prompt-delete-btn2').forEach(btn => {
      btn.addEventListener('click', function() {
        const id = this.dataset.id;
        const item = App.promptData.find(p => p.id === id);
        if (!item) return;
        if (!confirm(`确定删除指令「${item.title || '未命名指令'}」吗？`)) return;
        App.promptData = App.promptData.filter(p => p.id !== id);
        App.savePrompts();
        renderPromptList();
      });
    });
  }

  // 操作
  function insertPromptToNewChat(text) {
    if (!text) return;
    App.createNewTab();
    const input = document.getElementById('input');
    input.value = text;
    App.autoHeight();
    closePromptPanel();
    App.closeSidebar();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  function savePromptItem() {
    const rawTitle = promptTitleInput.value.trim();
    const title = rawTitle || '未命名指令';
    const content = promptContentInput.value.trim();

    if (!content) {
      alert('请输入指令内容');
      promptContentInput.focus();
      return;
    }

    if (App.editingPromptId) {
      const idx = App.promptData.findIndex(p => p.id === App.editingPromptId);
      if (idx > -1) {
        App.promptData[idx].title = title;
        App.promptData[idx].content = content;
        App.promptData[idx].updatedAt = Date.now();
      }
    } else {
      App.promptData.unshift({
        id: 'prompt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        title,
        content,
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
    }

    App.savePrompts();
    showPromptListView();
    renderPromptList();
  }

  // AI 优化
  async function optimizePromptWithAI() {
    if (optimizeInProgress) return;
    const original = promptContentInput.value.trim();

    if (!original) {
      App.showToast('请先填写指令内容');
      promptContentInput.focus();
      return;
    }

    if (!App.apiKey) {
      App.keyPanel.classList.remove('hidden');
      return;
    }

    const confirmed = await App.showConfirmModal({
      title: '智能优化当前指令',
      desc: '我会在尽量不改变原意的前提下，帮你把当前内容整理得更清晰、更自然，并尽量保持接近原长度。是否继续？',
      okText: '开始优化',
      cancelText: '暂不需要'
    });

    if (!confirmed) return;

    optimizeInProgress = true;
    const oldHtml = optimizePromptBtn.innerHTML;
    optimizePromptBtn.disabled = true;
    optimizePromptBtn.innerHTML = `<div class="loading-spinner"></div>`;

    try {
      const optimized = await requestOptimizedPrompt(original);
      if (!optimized || !optimized.trim()) {
        throw new Error('AI 未返回有效结果');
      }

      optimizedCandidateText = optimized.trim();
      originalPromptPreview.textContent = original;
      optimizedPromptPreview.textContent = optimizedCandidateText;
      promptOptimizePreviewPanel.classList.remove('hidden');
    } catch (e) {
      console.error(e);
      alert('AI 优化失败：' + e.message);
    } finally {
      optimizeInProgress = false;
      optimizePromptBtn.disabled = false;
      optimizePromptBtn.innerHTML = oldHtml;
    }
  }

  async function requestOptimizedPrompt(original) {
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

    const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${App.apiKey}`,
        "Cache-Control": "no-cache",
        "Pragma": "no-cache"
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages,
        stream: false,
        temperature: 0.5,
        max_tokens: approxMaxTokens
      })
    });

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData.error?.message || '请求失败，请检查 API Key 或稍后重试');
    }

    const data = await res.json();
    let content = data?.choices?.[0]?.message?.content || '';

    content = String(content).trim()
      .replace(/^```[\w-]*\n?/i, '')
      .replace(/\n?```$/, '')
      .trim();

    return content;
  }

  function closeOptimizePreviewPanel() {
    promptOptimizePreviewPanel.classList.add('hidden');
    originalPromptPreview.textContent = '';
    optimizedPromptPreview.textContent = '';
    optimizedCandidateText = '';
  }

  function applyOptimizedPrompt() {
    if (!optimizedCandidateText) {
      closeOptimizePreviewPanel();
      return;
    }
    promptContentInput.value = optimizedCandidateText;
    closeOptimizePreviewPanel();
    App.showToast('已替换为优化结果');
  }

  // 注册到 App
  App.openPromptPanel = openPromptPanel;
  App.closePromptPanel = closePromptPanel;

  // 事件绑定
  openPromptManagerBtn.addEventListener('click', () => {
    App.closeSidebar();
    openPromptPanel();
  });

  closePromptPanelBtn.addEventListener('click', closePromptPanel);
  promptPanel.addEventListener('click', (e) => {
    if (e.target === promptPanel) closePromptPanel();
  });

  addPromptBtn.addEventListener('click', () => showPromptFormView());
  cancelPromptEditBtn.addEventListener('click', showPromptListView);
  savePromptBtn.addEventListener('click', savePromptItem);
  optimizePromptBtn.addEventListener('click', optimizePromptWithAI);

  discardOptimizedPromptBtn.addEventListener('click', closeOptimizePreviewPanel);
  applyOptimizedPromptBtn.addEventListener('click', applyOptimizedPrompt);
  promptOptimizePreviewPanel.addEventListener('click', (e) => {
    if (e.target === promptOptimizePreviewPanel) closeOptimizePreviewPanel();
  });
})();
