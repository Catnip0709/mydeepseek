// app-market.js - 指令市场与 AI 生成
(function() {
  'use strict';
  const App = window.App;

  // 市场指令数据（从 prompts.js 加载，如果未定义则使用空数组）
  const MARKET_PROMPTS = window.MARKET_PROMPTS || [];

  // ========== DOM 元素 ==========
  const openPromptMarketBtn = document.getElementById('openPromptMarketBtn');
  const promptMarketPanel = document.getElementById('promptMarketPanel');
  const closePromptMarketBtn = document.getElementById('closePromptMarketBtn');
  const refreshPromptMarketBtn = document.getElementById('refreshPromptMarketBtn');
  const promptMarketContent = document.getElementById('promptMarketContent');
  const saveToPromptManagerBtn = document.getElementById('saveToPromptManagerBtn');
  const createChatWithPromptBtn = document.getElementById('createChatWithPromptBtn');

  // 智能生成指令相关元素
  const aiGeneratePromptBtn = document.getElementById('aiGeneratePromptBtn');
  const aiGeneratePromptPanel = document.getElementById('aiGeneratePromptPanel');
  const closeAiGenerateBtn = document.getElementById('closeAiGenerateBtn');
  const cancelAiGenerateBtn = document.getElementById('cancelAiGenerateBtn');
  const confirmAiGenerateBtn = document.getElementById('confirmAiGenerateBtn');
  const aiPromptInput = document.getElementById('aiPromptInput');
  const aiGenerateBtnText = document.getElementById('aiGenerateBtnText');
  const aiGenerateSpinner = document.getElementById('aiGenerateSpinner');

  // 空对话提示相关元素
  const emptyChatHint = document.getElementById('emptyChatHint');
  const openMarketFromHint = document.getElementById('openMarketFromHint');

  // 状态变量
  let currentMarketPrompt = null;
  let lastShownPromptIndex = -1;

  // ========== 空对话提示 ==========

  function showEmptyChatHint() {
    emptyChatHint.classList.remove('hidden');
  }

  function hideEmptyChatHint() {
    emptyChatHint.classList.add('hidden');
  }

  // ========== 市场指令 ==========

  // 随机获取一个指令
  function getRandomPrompt() {
    let newIndex;
    do {
      newIndex = Math.floor(Math.random() * MARKET_PROMPTS.length);
    } while (newIndex === lastShownPromptIndex && MARKET_PROMPTS.length > 1);

    lastShownPromptIndex = newIndex;
    return MARKET_PROMPTS[newIndex];
  }

  // 渲染指令市场内容
  function renderMarketPrompt() {
    currentMarketPrompt = getRandomPrompt();
    promptMarketContent.value = currentMarketPrompt.content;
  }

  // 刷新指令市场（带动画效果）
  function refreshMarketPrompt() {
    refreshPromptMarketBtn.classList.add('spinning');
    setTimeout(() => {
      renderMarketPrompt();
      refreshPromptMarketBtn.classList.remove('spinning');
    }, 300);
  }

  // 智能生成标题
  function generatePromptTitle(content) {
    const cleanContent = content.trim();

    // 移除常见的开头词
    let text = cleanContent
      .replace(/^(请|现在|咱们|我们|你是|我是|来玩|假设|假如|如果)\s*/, '')
      .replace(/^(【|「|『)/, '')
      .replace(/^(》|」|』)/, '');

    // 提取第一句（句号、感叹号、问号或换行之前的内容）
    let firstSentence = text.split(/[。！？\n]/)[0].trim();

    // 如果没有有效内容，使用未命名指令
    if (!firstSentence || firstSentence.length === 0) {
      return '未命名指令';
    }

    // 对于角色扮演类内容，提取角色
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

    // 对于游戏类内容，尝试提取游戏名称
    if (firstSentence.includes('游戏') || firstSentence.includes('挑战') || firstSentence.includes('玩')) {
      const gameMatch = firstSentence.match(/(?:来玩|玩|我们玩|来玩一个|玩一个)?(.+?)(?:游戏|挑战|小游戏)(，|。|！|$)/);
      if (gameMatch && gameMatch[1]) {
        const gameName = gameMatch[1].trim();
        if (gameName && gameName.length > 0) {
          return gameName.length <= 15 ? gameName : gameName.substring(0, 15) + '...';
        }
      }
    }

    // 默认返回前15个字
    let title = firstSentence;
    if (title.length > 15) {
      title = title.substring(0, 15) + '...';
    }

    return title || '未命名指令';
  }

  // 保存到指令管理
  function saveCurrentPromptToManager() {
    const content = promptMarketContent.value.trim();
    if (!content) {
      App.showToast('指令内容不能为空');
      return;
    }

    const title = generatePromptTitle(content);

    App.promptData.unshift({
      id: 'prompt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      title: title,
      content: content,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    App.savePrompts();
    App.showToast('已保存到指令管理');
  }

  // 新建对话并插入指令
  function createChatWithMarketPrompt() {
    const content = promptMarketContent.value.trim();
    if (!content) {
      App.showToast('指令内容不能为空');
      return;
    }

    App.createNewTab();
    App.input.value = content;
    App.autoHeight();
    closePromptMarketPanel();
    App.closeSidebar();
    App.input.focus();
    App.input.setSelectionRange(App.input.value.length, App.input.value.length);
  }

  // ========== 面板控制 ==========

  // 打开指令市场面板
  async function openPromptMarketPanel() {
    promptMarketPanel.classList.remove('hidden');
    // 如果还没有加载指令，先加载
    if (MARKET_PROMPTS.length === 0) {
      await loadPromptsFromFile();
    }
    renderMarketPrompt();
  }

  // 关闭指令市场面板
  function closePromptMarketPanel() {
    promptMarketPanel.classList.add('hidden');
  }

  // 打开 AI 生成面板
  function openAiGeneratePanel() {
    aiPromptInput.value = '';
    aiGeneratePromptPanel.classList.remove('hidden');
    setTimeout(() => aiPromptInput.focus(), 50);
  }

  // 关闭 AI 生成面板
  function closeAiGeneratePanel() {
    aiGeneratePromptPanel.classList.add('hidden');
  }

  // ========== AI 生成 ==========

  async function generatePromptWithAI() {
    const userInput = aiPromptInput.value.trim();
    if (!userInput) {
      alert('请输入关键词或描述');
      aiPromptInput.focus();
      return;
    }

    if (!App.apiKey) {
      App.keyPanel.classList.remove('hidden');
      return;
    }

    // 显示loading状态
    aiGenerateBtnText.textContent = '生成中...';
    aiGenerateSpinner.classList.remove('hidden');
    confirmAiGenerateBtn.disabled = true;

    try {
      const generatedPrompt = await requestGeneratedPrompt(userInput);
      if (!generatedPrompt || !generatedPrompt.trim()) {
        throw new Error('AI 未返回有效结果');
      }

      // 将生成的指令添加到指令市场，并显示
      currentMarketPrompt = { content: generatedPrompt.trim() };
      promptMarketContent.value = currentMarketPrompt.content;

      // 关闭生成面板
      closeAiGeneratePanel();

      App.showToast('指令生成成功！');
    } catch (e) {
      console.error(e);
      alert('AI 生成失败：' + e.message);
    } finally {
      // 恢复按钮状态
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

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

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
        temperature: 0.8,
        max_tokens: 300
      }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

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

  // ========== 加载指令（兼容） ==========

  async function loadPromptsFromFile() {
    // 数据已在 prompts.js 中定义
    return;
  }

  // ========== 注册到 App ==========

  App.loadPromptsFromFile = loadPromptsFromFile;
  App.showEmptyChatHint = showEmptyChatHint;
  App.hideEmptyChatHint = hideEmptyChatHint;
  App.openPromptMarketPanel = openPromptMarketPanel;
  App.closePromptMarketPanel = closePromptMarketPanel;
  App.openAiGeneratePanel = openAiGeneratePanel;
  App.closeAiGeneratePanel = closeAiGeneratePanel;

  // ========== 事件绑定 ==========

  // 打开指令市场
  openPromptMarketBtn.addEventListener('click', () => {
    App.closeSidebar();
    openPromptMarketPanel();
  });

  // 空对话提示点击打开指令市场
  openMarketFromHint.addEventListener('click', () => {
    openPromptMarketPanel();
  });

  // 关闭指令市场
  closePromptMarketBtn.addEventListener('click', closePromptMarketPanel);
  promptMarketPanel.addEventListener('click', (e) => {
    if (e.target === promptMarketPanel) closePromptMarketPanel();
  });

  // 刷新、保存、使用指令
  refreshPromptMarketBtn.addEventListener('click', refreshMarketPrompt);
  saveToPromptManagerBtn.addEventListener('click', saveCurrentPromptToManager);
  createChatWithPromptBtn.addEventListener('click', createChatWithMarketPrompt);

  // ESC键关闭面板
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      if (!promptMarketPanel.classList.contains('hidden')) closePromptMarketPanel();
      if (!aiGeneratePromptPanel.classList.contains('hidden')) closeAiGeneratePanel();
    }
  });

  // 智能生成指令事件监听
  aiGeneratePromptBtn.addEventListener('click', openAiGeneratePanel);
  closeAiGenerateBtn.addEventListener('click', closeAiGeneratePanel);
  cancelAiGenerateBtn.addEventListener('click', closeAiGeneratePanel);
  aiGeneratePromptPanel.addEventListener('click', (e) => {
    if (e.target === aiGeneratePromptPanel) closeAiGeneratePanel();
  });
  confirmAiGenerateBtn.addEventListener('click', generatePromptWithAI);

})();
