// app-chat.js - 聊天核心
(function() {
  'use strict';
  const App = window.App;

  // ========== DOM 元素 ==========
  const chat = document.getElementById('chat');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('sendBtn');
  const editPanel = document.getElementById('editPanel');
  const editTextarea = document.getElementById('editTextarea');
  const inputCounter = document.getElementById('inputCounter');
  const scrollToBottomBtn = document.getElementById('scrollToBottomBtn');
  const keyPanel = document.getElementById('keyPanel');
  const modelSelect = document.getElementById('modelSelect');
  const emptyChatHint = document.getElementById('emptyChatHint');
  const emptyChatHintCharName = document.getElementById('emptyChatHintCharName');

  // ========== Tab DOM 缓存 ==========
  function getCachedTabHtml(tabId) {
    return App._tabDomCache[tabId] || null;
  }

  function setCachedTabHtml(tabId, html) {
    App._tabDomCache[tabId] = html;
  }

  App.invalidateTabCache = function(tabId) {
    if (tabId) {
      delete App._tabDomCache[tabId];
    } else {
      App._tabDomCache = {};
    }
  };

  // ========== 辅助函数 ==========
  function getLastUserMessageIndex() {
    const currentMsgs = App.tabData.list[App.tabData.active].messages || [];
    for (let i = currentMsgs.length - 1; i >= 0; i--) {
      if (currentMsgs[i].role === 'user') return i;
    }
    return -1;
  }

  function scrollToBottom() {
    chat.scrollTo({ top: chat.scrollHeight, behavior: 'smooth' });
  }

  function checkScrollButton() {
    const distanceFromBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight;
    if (distanceFromBottom > 200) {
      scrollToBottomBtn.classList.add('visible');
    } else {
      scrollToBottomBtn.classList.remove('visible');
    }
  }

  function showEmptyChatHint() {
    // 根据当前 tab 类型动态更新角色名
    const currentTab = App.tabData.list[App.tabData.active];
    if (currentTab && currentTab.type === 'single-character' && currentTab.characterId) {
      const char = App.getCharacterById(currentTab.characterId);
      if (char && emptyChatHintCharName) {
        emptyChatHintCharName.textContent = char.name;
      }
    } else if (emptyChatHintCharName) {
      emptyChatHintCharName.textContent = 'DS老师';
    }
    if (emptyChatHint) emptyChatHint.classList.remove('hidden');
  }

  function hideEmptyChatHint() {
    if (emptyChatHint) emptyChatHint.classList.add('hidden');
  }

  // ========== 编辑功能 ==========
  function editUserMessage(messageIndex) {
    const currentMsgs = App.tabData.list[App.tabData.active].messages || [];
    if (messageIndex < 0 || messageIndex >= currentMsgs.length) return alert("消息索引无效。");
    const targetMessage = currentMsgs[messageIndex];
    if (targetMessage.role !== 'user') return alert("只能编辑用户消息。");

    App.editingMessageIndex = messageIndex;
    editTextarea.value = targetMessage.content;
    editPanel.classList.remove("hidden");
    editTextarea.focus();
  }

  function regenerateResponse(messageIndex) {
    if (!App.apiKey) { keyPanel.classList.remove("hidden"); return; }
    const currentMsgs = App.tabData.list[App.tabData.active].messages || [];
    if (currentMsgs.length === 0) return alert("当前对话为空，无法重新生成。");
    if (messageIndex < 0 || messageIndex >= currentMsgs.length) return alert("消息索引无效。");
    const targetMessage = currentMsgs[messageIndex];
    if (targetMessage.role !== 'assistant') return alert("只能重新生成AI的回复。");

    fetchAndStreamResponse({ regenerateIndex: messageIndex });
  }

  App.saveEditAndRegenerate = async function() {
    const newContent = editTextarea.value.trim();
    if (!newContent) return alert("消息内容不能为空！");
    const currentTab = App.tabData.list[App.tabData.active];
    const currentMsgs = currentTab.messages || [];
    if (App.editingMessageIndex < 0 || App.editingMessageIndex >= currentMsgs.length) return alert("编辑的消息不存在。");

    // 截断该消息之后的所有消息
    const editIdx = App.editingMessageIndex;
    const messagesToKeep = currentMsgs.slice(0, editIdx + 1);
    messagesToKeep[editIdx].content = newContent;
    currentTab.messages = messagesToKeep;
    App.saveTabs();

    editPanel.classList.add("hidden");
    App.editingMessageIndex = -1;
    App.renderChat();

    // 群聊走群聊发送逻辑
    if (currentTab.type === 'group') {
      await sendGroupMessage(App.tabData.active, newContent);
    } else {
      if (messagesToKeep[editIdx]?.role === 'user') {
        messagesToKeep[editIdx].inputMeta = App.buildUserInputMeta(messagesToKeep, editIdx);
        App.saveTabs();
      }
      await fetchAndStreamResponse();
    }
  };

  function cancelEdit() {
    editPanel.classList.add("hidden");
    App.editingMessageIndex = -1;
  }

  // ========== 输入框 ==========
  App.autoHeight = function() {
    input.style.height = "44px";
    const scrollH = input.scrollHeight;
    input.style.height = Math.min(Math.max(scrollH, 44), 88) + "px";
  };

  App.updateInputCounter = function() {
    const text = input.value;
    const charCount = text.length;
    const tokenEstimate = App.estimateTokensByChars(charCount);
    if (charCount > 0) {
      inputCounter.textContent = charCount + ' 字 / 约 ' + tokenEstimate + ' tokens';
    } else {
      inputCounter.textContent = "0 字";
    }
  };

  // ========== 标题生成 ==========
  async function generateTitleForCurrentTab() {
    const titleTabId = App.tabData.active;
    const currentMsgs = App.tabData.list[titleTabId].messages || [];
    if (currentMsgs.length < 2) return;

    const firstUserMsg = currentMsgs.find(m => m.role === 'user');
    if (!firstUserMsg) return;

    try {
      const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + App.apiKey
        },
        body: JSON.stringify({
          model: "deepseek-chat",
          messages: [
            { role: "user", content: "请为以下对话生成一个简洁、描述性的标题（不超过 15 个字）。只返回标题，不要其他内容。\n\n用户消息：" + firstUserMsg.content }
          ],
          stream: false,
          temperature: 0.5,
          max_tokens: 50
        })
      });

      if (res.ok) {
        const data = await res.json();
        let title = data?.choices?.[0]?.message?.content || '';
        title = title.trim().replace(/^["「『]|["」』]$/g, '');
        if (title && title.length <= 30) {
          App.tabData.list[titleTabId].title = title;
          App.saveTabs();
          App.renderTabs();
        }
      }
    } catch (e) {
      console.log('生成标题失败，不影响功能', e);
    }
  }

  // ========== Tab 创建 ==========
  App.createNewTab = function() {
    const tabIds = Object.keys(App.tabData.list);
    let maxIdNum = 0;
    tabIds.forEach(id => {
      const num = parseInt(id.replace('tab', ''), 10);
      if (num > maxIdNum) maxIdNum = num;
    });

    const newId = "tab" + (maxIdNum + 1);
    App.tabData.list[newId] = { messages: [], title: "" };
    App.tabData.active = newId;
    App.saveTabs();
    App.renderChat();
    App.renderTabs();
    App.updateInputCounter();

    // 新对话显示提示
    showEmptyChatHint();

    return newId;
  };

  // ========== 绑定聊天区域内的按钮事件 ==========
  function rebindChatButtons() {
    const checkIconSvg = App.icons.checkIconSvg;
    const copyIconSvg = App.icons.copyIconSvg;
    const deleteIconSvg = App.icons.deleteIconSvg;

    document.querySelectorAll('.copy-btn').forEach(btn => {
      btn.addEventListener('click', function() {
        const index = parseInt(this.getAttribute('data-index'));
        const currentMsgs = App.tabData.list[App.tabData.active].messages || [];
        if (currentMsgs[index]) App.copyText(currentMsgs[index].content);

        const originalHtml = this.innerHTML;
        this.innerHTML = checkIconSvg;
        setTimeout(() => { this.innerHTML = originalHtml; }, 1500);
      });
    });

    document.querySelectorAll('.edit-btn').forEach(btn => {
      btn.addEventListener('click', function() {
        const index = parseInt(this.getAttribute('data-index'));
        editUserMessage(index);
      });
    });

    document.querySelectorAll('.regenerate-btn').forEach(btn => {
      btn.addEventListener('click', function() {
        const index = parseInt(this.getAttribute('data-index'));
        regenerateResponse(index);
      });
    });

    document.querySelectorAll('.delete-btn').forEach(btn => {
      btn.addEventListener('click', function() {
        const index = parseInt(this.getAttribute('data-index'));
        if (confirm("确定删除这条消息吗？")) {
          App.invalidateTabCache(App.tabData.active);
          App.tabData.list[App.tabData.active].messages.splice(index, 1);
          App.saveTabs();
          App.renderChat();
        }
      });
    });

    document.querySelectorAll('.prev-version-btn').forEach(btn => {
      btn.addEventListener('click', function() {
        if (this.classList.contains('disabled')) return;
        const index = parseInt(this.getAttribute('data-index'));
        const msg = App.tabData.list[App.tabData.active].messages[index];
        if (msg.historyIndex > 0) {
          App.invalidateTabCache(App.tabData.active);
          msg.historyIndex--;
          msg.content = msg.history[msg.historyIndex].content;
          msg.reasoningContent = msg.history[msg.historyIndex].reasoningContent;
          msg.generationState = msg.history[msg.historyIndex].state || 'complete';
          App.saveTabs();
          App.renderChat();
        }
      });
    });

    document.querySelectorAll('.next-version-btn').forEach(btn => {
      btn.addEventListener('click', function() {
        if (this.classList.contains('disabled')) return;
        const index = parseInt(this.getAttribute('data-index'));
        const msg = App.tabData.list[App.tabData.active].messages[index];
        if (msg.historyIndex < msg.history.length - 1) {
          App.invalidateTabCache(App.tabData.active);
          msg.historyIndex++;
          msg.content = msg.history[msg.historyIndex].content;
          msg.reasoningContent = msg.history[msg.historyIndex].reasoningContent;
          msg.generationState = msg.history[msg.historyIndex].state || 'complete';
          App.saveTabs();
          App.renderChat();
        }
      });
    });

    // token limit 提示中的复制按钮
    const copyPromptBtn = document.querySelector('#copyPromptBtn');
    if (copyPromptBtn) {
      copyPromptBtn.addEventListener('click', function() {
        const text = document.getElementById('promptText').innerText;
        App.copyText(text);
        const originalHtml = this.innerHTML;
        this.innerHTML = checkIconSvg;
        setTimeout(() => { this.innerHTML = originalHtml; }, 1500);
      });
    }
  }

  // ========== 渲染聊天 ==========
  App.renderChat = function() {
    const copyIconSvg = App.icons.copyIconSvg;
    const deleteIconSvg = App.icons.deleteIconSvg;
    const checkIconSvg = App.icons.checkIconSvg;

    const currentTab = App.tabData.list[App.tabData.active];
    const currentMsgs = currentTab.messages || [];
    const lastUserMsgIndex = getLastUserMessageIndex();
    const isGroupChat = currentTab.type === 'group';

    // renderChat 执行全量渲染，清除当前 tab 的缓存
    App.invalidateTabCache(App.tabData.active);

    chat.innerHTML = "";

    // 群聊头部：显示参与角色
    if (isGroupChat && currentTab.characterIds) {
      const groupChars = currentTab.characterIds.map(id => App.getCharacterById(id)).filter(Boolean);
      if (groupChars.length > 0) {
        const headerDiv = document.createElement("div");
        headerDiv.className = "group-chat-header";
        const memberTags = groupChars.map((c, i) => {
          const color = App.getCharacterColor(i);
          return '<span class="group-chat-member-tag" style="background:' + color + '">' + App.escapeHtml(c.name) + '</span>';
        }).join('');
        headerDiv.innerHTML = '<div class="group-chat-header-text">群聊成员</div><div class="group-chat-members">' + memberTags + '</div>';
        chat.appendChild(headerDiv);
      }
    }

    currentMsgs.forEach((m, i) => {
      const isUser = m.role === 'user';
      const isAssistant = m.role === 'assistant';
      const isCharacter = m.role === 'character';
      // 兼容旧数据：群聊中 assistant 消息也当作角色消息渲染
      const isGroupAssistant = isGroupChat && isAssistant;
      const isLastAssistant = isAssistant && !isGroupAssistant && i === currentMsgs.length - 1;
      const isLastUserMessage = i === lastUserMsgIndex;

      const msgBox = document.createElement("div");
      msgBox.id = "msg-" + i;

      if (isCharacter || isGroupAssistant) {
        // 群聊角色消息
        const charIndex = (currentTab.characterIds || []).indexOf(m.characterId);
        const color = App.getCharacterColor(charIndex >= 0 ? charIndex : 0);
        msgBox.className = "message-box character-msg p-3 rounded-xl bg-gray-800 mr-auto max-w-[85%] text-white";
        msgBox.style.borderLeftColor = color;

        let buttonsHtml = '<button class="delete-btn" data-index="' + i + '" title="删除">' + deleteIconSvg + '</button>';
        buttonsHtml += '<button class="copy-btn" data-index="' + i + '" title="复制">' + copyIconSvg + '</button>';

        const displayName = m.characterName || '角色';
        msgBox.innerHTML =
          '<div class="character-msg-label" style="background:' + color + '20;color:' + color + '">' + App.escapeHtml(displayName) + '</div>' +
          buttonsHtml;

        const contentDiv = document.createElement("div");
        contentDiv.className = "msg-content prose prose-invert max-w-none";
        App.renderMarkdown(contentDiv, m.content, i, 'content');
        msgBox.appendChild(contentDiv);

        if (m.generationState === 'interrupted') {
          const statusDiv = document.createElement("div");
          statusDiv.className = "generation-status mt-1 text-xs text-amber-400";
          statusDiv.textContent = '生成中断';
          msgBox.appendChild(statusDiv);
        }
      } else {
        // 单聊消息（原有逻辑）
        msgBox.className = "message-box p-3 rounded-xl " + (isUser ? 'bg-blue-600 ml-auto' : 'bg-gray-800 mr-auto') + " max-w-[85%] text-white";

        let buttonsHtml = '<button class="delete-btn" data-index="' + i + '" title="删除">' + deleteIconSvg + '</button>';
        if (isAssistant) {
          buttonsHtml += '<button class="copy-btn" data-index="' + i + '" title="复制">' + copyIconSvg + '</button>';
          if (isLastAssistant) buttonsHtml += '<button class="regenerate-btn" data-index="' + i + '" title="重新生成">↻</button>';
        } else if (isUser) {
          buttonsHtml += '<button class="copy-btn" data-index="' + i + '" title="复制">' + copyIconSvg + '</button>';
          if (isLastUserMessage) buttonsHtml += '<button class="edit-btn" data-index="' + i + '" title="编辑">✎</button>';
        }

        let versionHtml = '';
        if (isAssistant && m.history && m.history.length > 1) {
          const hIndex = m.historyIndex || 0;
          const isFirst = hIndex === 0;
          const isLast = hIndex === m.history.length - 1;
          versionHtml =
            '<div class="version-control">' +
              '<span class="version-btn prev-version-btn ' + (isFirst ? 'disabled' : '') + '" data-index="' + i + '">❮</span>' +
              '<span>' + (hIndex + 1) + ' / ' + m.history.length + '</span>' +
              '<span class="version-btn next-version-btn ' + (isLast ? 'disabled' : '') + '" data-index="' + i + '">❯</span>' +
            '</div>';
        }

        msgBox.innerHTML = versionHtml + buttonsHtml;

        if (isAssistant && m.reasoningContent) {
          const details = document.createElement('details');
          details.className = "reasoning-details mb-2 border border-gray-700 rounded-lg p-2 bg-gray-900";
          details.open = true;
          details.innerHTML = '<summary class="text-xs text-gray-400 cursor-pointer select-none outline-none">思考过程</summary>';
          const reasoningDiv = document.createElement('div');
          reasoningDiv.className = "reasoning-content prose prose-invert max-w-none text-sm text-gray-400 mt-2 border-t border-gray-700 pt-2";
          App.renderMarkdown(reasoningDiv, m.reasoningContent, i, 'reasoning');
          details.appendChild(reasoningDiv);
          msgBox.appendChild(details);
        }

        const contentDiv = document.createElement("div");
        contentDiv.className = "msg-content prose prose-invert max-w-none";
        App.renderMarkdown(contentDiv, m.content, i, 'content');
        msgBox.appendChild(contentDiv);

        if (isUser && !isGroupChat) {
          const userInputMeta = App.buildUserInputMeta(currentMsgs, i);
          if (userInputMeta) {
            const metaDiv = document.createElement('div');
            metaDiv.className = "message-meta user-input-meta mt-2 text-xs";
            metaDiv.textContent = '本次正文 ' + userInputMeta.inputChars + ' 字，约 ' + userInputMeta.inputTokens + ' tokens；历史记忆约 ' + userInputMeta.historyTokens + ' tokens；本轮输入共约 ' + userInputMeta.totalInputTokens + ' tokens';
            msgBox.appendChild(metaDiv);
          }
        }

        if (isAssistant) {
          const metaDiv = document.createElement('div');
          metaDiv.className = "message-meta assistant-meta mt-2 text-xs text-gray-400";
          const totalChars = App.countChars(m.reasoningContent) + App.countChars(m.content);
          const tokenEstimate = App.estimateTokensByChars(totalChars);
          metaDiv.textContent = '思考 ' + App.countChars(m.reasoningContent) + ' 字，正文 ' + App.countChars(m.content) + ' 字，约 ' + tokenEstimate + ' tokens';
          msgBox.appendChild(metaDiv);

          if (m.generationState === 'interrupted') {
            const statusDiv = document.createElement("div");
            statusDiv.className = "generation-status mt-1 text-xs text-amber-400";
            statusDiv.textContent = '生成中断，可重新生成';
            msgBox.appendChild(statusDiv);
          }
        }
      }

      chat.appendChild(msgBox);
    });

    if (currentMsgs.length > 0 && !isGroupChat && App.isTokenLimitReached()) {
      const warningDiv = document.createElement("div");
      warningDiv.className = "text-xs text-gray-500 text-center mt-6 mb-4 px-2";
      warningDiv.innerHTML =
        '当前对话框上下文即将达到上限。建议总结并开启新对话，或调整对话记忆条数：<br>' +
        '<div class="inline-block bg-gray-800 rounded p-2 mt-2 text-left border border-gray-700 relative pr-10 max-w-[90%] mx-auto">' +
          '<span id="promptText" class="text-gray-400 break-all">请帮我把目前为止的故事剧情、出场人物设定、伏笔和当前的主线任务做一个极其详细的总结（约2000字）。</span>' +
          '<button id="copyPromptBtn" class="absolute right-2 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-white bg-gray-700 rounded p-1 transition-colors" title="复制指令">' +
            copyIconSvg +
          '</button>' +
        '</div>';
      chat.appendChild(warningDiv);

      const copyPromptBtn = warningDiv.querySelector('#copyPromptBtn');
      if (copyPromptBtn) {
        copyPromptBtn.addEventListener('click', function() {
          const text = document.getElementById('promptText').innerText;
          App.copyText(text);
          const originalHtml = this.innerHTML;
          this.innerHTML = checkIconSvg;
          setTimeout(() => { this.innerHTML = originalHtml; }, 1500);
        });
      }
    }

    rebindChatButtons();

    chat.scrollTop = chat.scrollHeight;
    setTimeout(checkScrollButton, 50);

    // 检查是否需要显示空对话提示
    if (currentMsgs.length === 0) {
      showEmptyChatHint();
    } else {
      hideEmptyChatHint();
    }
  };

  // ========== 流式请求（单聊） ==========
  async function fetchAndStreamResponse(opts = {}) {
    const copyIconSvg = App.icons.copyIconSvg;

    App.isSending = true;
    sendBtn.textContent = "停止";
    sendBtn.classList.add("stop-mode");

    // 锁定当前 tab，防止流式输出期间用户切换 tab 导致数据写入错误
    const lockedTabId = App.tabData.active;

    App.abortReason = null;
    App.abortController = new AbortController();

    // 120秒无响应自动超时
    const fetchTimeout = setTimeout(() => {
      if (App.abortController && !App.isSending) return;
      App.abortReason = 'timeout';
      App.abortController.abort();
    }, 120000);

    App.trackEvent('发送消息');

    const currentMsgs = App.tabData.list[lockedTabId].messages || [];
    const isRegen = opts.regenerateIndex !== undefined;
    const targetIndex = isRegen ? opts.regenerateIndex : currentMsgs.length;
    const selectedModel = modelSelect.value;

    const payloadMsgs = App.buildPayloadMessages(currentMsgs, isRegen ? targetIndex : currentMsgs.length);

    const isAtBottom = chat.scrollTop + chat.clientHeight >= chat.scrollHeight - 20;
    let aiMsgDiv;

    if (isRegen) {
      aiMsgDiv = document.getElementById("msg-" + targetIndex);
      if (!currentMsgs[targetIndex].history) {
        currentMsgs[targetIndex].history = [{ content: currentMsgs[targetIndex].content, reasoningContent: currentMsgs[targetIndex].reasoningContent || "", state: currentMsgs[targetIndex].generationState || 'complete' }];
        currentMsgs[targetIndex].historyIndex = 0;
      }
      currentMsgs[targetIndex].history.push({ content: "", reasoningContent: "", state: "generating" });
      currentMsgs[targetIndex].historyIndex = currentMsgs[targetIndex].history.length - 1;
      currentMsgs[targetIndex].content = "";
      currentMsgs[targetIndex].reasoningContent = "";
      currentMsgs[targetIndex].generationState = "generating";

      const contentDiv = aiMsgDiv.querySelector('.msg-content');
      if (contentDiv) contentDiv.textContent = "";
      const reasoningDetails = aiMsgDiv.querySelector('.reasoning-details');
      if (reasoningDetails) reasoningDetails.remove();
      const metaEl = aiMsgDiv.querySelector('.assistant-meta');
      if (metaEl) metaEl.remove();
      const statusEl = aiMsgDiv.querySelector('.generation-status');
      if (statusEl) statusEl.remove();
    } else {
      aiMsgDiv = document.createElement("div");
      aiMsgDiv.id = "msg-" + targetIndex;
      aiMsgDiv.className = "message-box p-3 rounded-xl bg-gray-800 mr-auto max-w-[85%] text-white";
      aiMsgDiv.innerHTML = '<button class="copy-btn" title="复制">' + copyIconSvg + '</button><div class="msg-content prose prose-invert max-w-none"></div>';

      const promptWarning = chat.querySelector('.text-xs.text-gray-500.text-center');
      if (promptWarning) {
        chat.insertBefore(aiMsgDiv, promptWarning);
      } else {
        chat.appendChild(aiMsgDiv);
      }
    }

    if (isAtBottom) chat.scrollTop = chat.scrollHeight;

    let fullContent = "";
    let fullReasoningContent = "";
    let hasReasoning = false;
    let reasoningContentDiv = null;
    let finalizeState = "complete";

    function markInterrupted() {
      finalizeState = "interrupted";
    }

    function isBackgroundRelatedError(err) {
      if (App.abortReason === "background") return true;
      if (Date.now() - App.lastPageHiddenAt > 6000) return false;
      const msg = String(err && err.message ? err.message : "");
      if (!msg) return true;
      return /(load failed|failed to fetch|networkerror|cancelled|canceled)/i.test(msg);
    }

    try {
      const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + App.apiKey,
          "Cache-Control": "no-cache",
          "Pragma": "no-cache"
        },
        body: JSON.stringify({
          model: selectedModel,
          messages: payloadMsgs,
          stream: true,
          temperature: 0.7,
          max_tokens: 4096
        }),
        signal: App.abortController.signal
      });

      if (!res.ok) {
        const errorData = await res.json();
        throw new Error("API请求失败：" + (errorData.error?.message || '请检查API Key是否有效'));
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");

        buffer = lines.pop();

        for (const line of lines) {
          if (line.trim() === "") continue;
          if (!line.startsWith("data: ")) continue;

          const dataStr = line.slice(6);
          if (dataStr === "[DONE]") {
            finalizeMessage(finalizeState);
            return;
          }

          try {
            const data = JSON.parse(dataStr);
            const delta = data.choices[0].delta;

            if (delta.reasoning_content) {
              if (!hasReasoning) {
                hasReasoning = true;
                const details = document.createElement('details');
                details.className = "reasoning-details mb-2 border border-gray-700 rounded-lg p-2 bg-gray-900";
                details.open = true;
                details.innerHTML = '<summary class="text-xs text-gray-400 cursor-pointer select-none outline-none">思考过程</summary><div class="reasoning-content prose prose-invert max-w-none text-sm text-gray-400 mt-2 border-t border-gray-700 pt-2"></div>';
                const msgContentDiv = aiMsgDiv.querySelector('.msg-content');
                aiMsgDiv.insertBefore(details, msgContentDiv);
                reasoningContentDiv = details.querySelector('.reasoning-content');
              }
              fullReasoningContent += delta.reasoning_content;
              App.renderMarkdown(reasoningContentDiv, fullReasoningContent);
            }

            if (delta.content) {
              fullContent += delta.content;
              const contentDiv = aiMsgDiv.querySelector('.msg-content');
              if (contentDiv) {
                App.renderMarkdown(contentDiv, fullContent);
              }
            }

            const currentIsAtBottom = chat.scrollTop + chat.clientHeight >= chat.scrollHeight - 20;
            if (currentIsAtBottom) chat.scrollTop = chat.scrollHeight;
          } catch (e) {
            continue;
          }
        }
      }
      finalizeMessage(finalizeState);

    } catch (e) {
      if (e.name === 'AbortError') {
        if (App.abortReason === 'background' || App.abortReason === 'manual') markInterrupted();
        else if (App.abortReason === 'timeout') {
          const contentDiv = aiMsgDiv.querySelector('.msg-content');
          if (contentDiv) {
            contentDiv.innerHTML = '<span class="text-red-400">❌ 请求超时，请检查网络后重试</span>';
          }
        }
        finalizeMessage(finalizeState);
      } else if (isBackgroundRelatedError(e)) {
        markInterrupted();
        finalizeMessage(finalizeState);
      } else {
        const contentDiv = aiMsgDiv.querySelector('.msg-content');
        if (contentDiv) {
          contentDiv.innerHTML = '<span class="text-red-400">❌ 错误：' + e.message + '</span>';
        }
        console.error("发送消息错误：", e);

        if (e.message.includes("API请求失败") || e.message.includes("Key")) {
          setTimeout(() => {
            if (confirm("检测到API Key可能无效，是否立即修改？")) {
              App.openSettingsPanel();
            }
          }, 1000);
        }
      }
    } finally {
      clearTimeout(fetchTimeout);
      App.isSending = false;
      sendBtn.textContent = "发送";
      sendBtn.classList.remove("stop-mode");
      App.abortController = null;
    }

    function finalizeMessage(state = "complete") {
      if (isRegen) {
        currentMsgs[targetIndex].generationState = state;
        currentMsgs[targetIndex].content = fullContent;
        currentMsgs[targetIndex].reasoningContent = fullReasoningContent;
        currentMsgs[targetIndex].history[currentMsgs[targetIndex].historyIndex] = { content: fullContent, reasoningContent: fullReasoningContent, state };
      } else {
        currentMsgs.push({
          role: "assistant",
          content: fullContent,
          reasoningContent: fullReasoningContent,
          generationState: state,
          history: [{ content: fullContent, reasoningContent: fullReasoningContent, state }],
          historyIndex: 0
        });
      }
      App.tabData.list[lockedTabId].messages = currentMsgs;
      App.saveTabs();
      App.renderChat();
    }
  }

  // ========== 发送消息 ==========
  async function sendMessage() {
    if (App.isSending) return;
    const text = input.value.trim();
    if (!text) { input.focus(); return; }
    if (!App.apiKey) { keyPanel.classList.remove("hidden"); return; }
    if (App.isStorageFull()) {
      alert('本地存储空间已满，无法保存新消息。请先导出重要对话，再清理过期会话后继续使用。');
      return;
    }

    const sendingTabId = App.tabData.active;
    const currentTab = App.tabData.list[sendingTabId];
    const currentMsgs = currentTab.messages || [];
    const isFirstMessage = currentMsgs.length === 0;

    // 群聊分支
    if (currentTab.type === 'group' && currentTab.characterIds && currentTab.characterIds.length > 0) {
      currentMsgs.push({ role: "user", content: text });
      App.tabData.list[sendingTabId].messages = currentMsgs;
      App.saveTabs();
      App.renderChat();

      input.value = "";
      App.autoHeight();
      App.updateInputCounter();

      await sendGroupMessage(sendingTabId, text);

      if (isFirstMessage && App.tabData.active === sendingTabId) {
        generateTitleForCurrentTab();
      }
      return;
    }

    // 单聊分支（原有逻辑）
    currentMsgs.push({ role: "user", content: text });
    currentMsgs[currentMsgs.length - 1].inputMeta = App.buildUserInputMeta(currentMsgs, currentMsgs.length - 1);
    App.tabData.list[sendingTabId].messages = currentMsgs;
    App.saveTabs();
    App.renderChat();

    input.value = "";
    App.autoHeight();
    App.updateInputCounter();
    await fetchAndStreamResponse();

    if (isFirstMessage && App.tabData.active === sendingTabId) {
      generateTitleForCurrentTab();
    }
  }

  // ========== 群聊消息发送 ==========
  async function sendGroupMessage(tabId, userMessage) {
    const deleteIconSvg = App.icons.deleteIconSvg;
    const copyIconSvg = App.icons.copyIconSvg;

    App.isSending = true;
    sendBtn.textContent = "停止";
    sendBtn.classList.add("stop-mode");

    const lockedTabId = tabId;
    App.abortReason = null;
    App.abortController = new AbortController();
    const signal = App.abortController.signal;

    const currentTab = App.tabData.list[lockedTabId];
    const characters = (currentTab.characterIds || []).map(id => App.getCharacterById(id)).filter(Boolean);
    if (characters.length === 0) {
      App.isSending = false;
      sendBtn.textContent = "发送";
      sendBtn.classList.remove("stop-mode");
      return;
    }

    const currentMsgs = currentTab.messages || [];
    const history = currentMsgs;

    try {
      const replies = await App.orchestrateGroupChat(userMessage, characters, history, {
        signal,
        model: modelSelect.value === 'deepseek-reasoner' ? 'deepseek-reasoner' : 'deepseek-chat',
        onCharacterStart(character, idx) {
          // 创建角色消息 DOM
          const msgIndex = currentMsgs.length;
          const color = App.getCharacterColor(idx);
          const msgBox = document.createElement("div");
          msgBox.id = "msg-" + msgIndex;
          msgBox.className = "message-box character-msg p-3 rounded-xl bg-gray-800 mr-auto max-w-[85%] text-white";
          msgBox.style.borderLeftColor = color;
          msgBox.innerHTML =
            '<div class="character-msg-label" style="background:' + color + '20;color:' + color + '">' + App.escapeHtml(character.name) + '</div>' +
            '<button class="delete-btn" data-index="' + msgIndex + '" title="删除">' + deleteIconSvg + '</button>' +
            '<button class="copy-btn" data-index="' + msgIndex + '" title="复制">' + copyIconSvg + '</button>' +
            '<div class="msg-content prose prose-invert max-w-none"></div>';
          chat.appendChild(msgBox);
          chat.scrollTop = chat.scrollHeight;
        },
        onCharacterChunk(character, idx, chunk) {
          // 找到该角色最新的消息 DOM 并更新
          const msgBoxes = chat.querySelectorAll('.character-msg');
          const targetBox = msgBoxes[msgBoxes.length - 1];
          if (targetBox) {
            const contentDiv = targetBox.querySelector('.msg-content');
            if (contentDiv && chunk.fullContent) {
              App.renderMarkdown(contentDiv, chunk.fullContent);
              const isAtBottom = chat.scrollTop + chat.clientHeight >= chat.scrollHeight - 20;
              if (isAtBottom) chat.scrollTop = chat.scrollHeight;
            }
          }
        },
        onCharacterEnd(character, idx, content) {
          // 保存角色消息到数据（不触发 renderChat，避免流式过程中 DOM 重建）
          const msgs = App.tabData.list[lockedTabId].messages;
          msgs.push({
            role: "character",
            characterId: character.id,
            characterName: character.name,
            content: content || '',
            generationState: App.abortReason ? 'interrupted' : 'complete',
            history: [{ content: content || '', reasoningContent: '', state: App.abortReason ? 'interrupted' : 'complete' }],
            historyIndex: 0
          });
          App.tabData.list[lockedTabId].messages = msgs;
          App.saveTabs();
        }
      });
    } catch (e) {
      if (e.name !== 'AbortError') {
        console.error('群聊发送错误:', e);
        App.showToast('群聊发送失败：' + e.message);
      }
    } finally {
      App.isSending = false;
      sendBtn.textContent = "发送";
      sendBtn.classList.remove("stop-mode");
      App.abortController = null;
      App.renderChat();
    }
  }

  // ========== 注册到 App ==========
  App.rebindChatButtons = rebindChatButtons;
  App.showEmptyChatHint = showEmptyChatHint;
  App.hideEmptyChatHint = hideEmptyChatHint;

  // ========== 事件绑定 ==========
  sendBtn.addEventListener('click', sendMessage);

  input.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  input.addEventListener('input', function() {
    App.autoHeight();
    App.updateInputCounter();
  });
  App.autoHeight();
  App.updateInputCounter();

  chat.addEventListener('scroll', checkScrollButton);
  scrollToBottomBtn.addEventListener('click', scrollToBottom);
})();
