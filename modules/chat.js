/**
 * chat.js — 聊天核心模块
 *
 * 负责聊天渲染、消息发送、流式请求、编辑/重新生成等功能。
 */

import { state } from './state.js';
import {
  escapeHtml, copyText, checkIconSvg, deleteIconSvg, copyIconSvg,
  replyIconSvg, estimateTokensByChars, countChars, trackEvent
} from './utils.js';
import {
  saveTabs, buildPayloadMessages, buildUserInputMeta,
  isTokenLimitReached, isStorageFull
} from './storage.js';
import { renderMarkdown } from './markdown.js';
import {
  showToast, openSettingsPanel, showEmptyChatHint,
  hideEmptyChatHint, hideReplyBar, showReplyBar
} from './panels.js';
import { call as coreCall } from './core.js';

// ========== 聊天区域事件绑定（事件委托） ==========

let _chatEventsBound = false;

function handleChatClick(e) {
  const chat = document.getElementById('chat');
  const input = document.getElementById('input');
  const target = e.target;
  const currentMsgs = state.tabData.list[state.tabData.active].messages || [];

  // Copy button
  const copyBtn = target.closest('.copy-btn');
  if (copyBtn) {
    const index = parseInt(copyBtn.getAttribute('data-index'));
    if (currentMsgs[index]) copyText(currentMsgs[index].content);
    const originalHtml = copyBtn.innerHTML;
    copyBtn.innerHTML = checkIconSvg;
    setTimeout(() => { copyBtn.innerHTML = originalHtml; }, 1500);
    return;
  }

  // Edit button
  const editBtn = target.closest('.edit-btn');
  if (editBtn) {
    const index = parseInt(editBtn.getAttribute('data-index'));
    editUserMessage(index);
    return;
  }

  // Regenerate button
  const regenerateBtn = target.closest('.regenerate-btn');
  if (regenerateBtn) {
    const index = parseInt(regenerateBtn.getAttribute('data-index'));
    regenerateResponse(index);
    return;
  }

  // Delete button
  const deleteBtn = target.closest('.delete-btn');
  if (deleteBtn) {
    const index = parseInt(deleteBtn.getAttribute('data-index'));
    if (confirm("确定删除这条消息吗？")) {
      coreCall('invalidateTabCache', state.tabData.active);
      state.tabData.list[state.tabData.active].messages.splice(index, 1);
      saveTabs();
      renderChat();
    }
    return;
  }

  // Reply button
  const replyBtn = target.closest('.reply-btn');
  if (replyBtn) {
    const charId = replyBtn.dataset.charId;
    const charName = replyBtn.dataset.charName;
    const snippet = replyBtn.dataset.snippet;
    showReplyBar(charId, charName, snippet);
    if (input) input.focus();
    return;
  }

  // Previous version button
  const prevVersionBtn = target.closest('.prev-version-btn');
  if (prevVersionBtn) {
    if (prevVersionBtn.classList.contains('disabled')) return;
    const index = parseInt(prevVersionBtn.getAttribute('data-index'));
    const msg = currentMsgs[index];
    if (msg.historyIndex > 0) {
      coreCall('invalidateTabCache', state.tabData.active);
      msg.historyIndex--;
      msg.content = msg.history[msg.historyIndex].content;
      msg.reasoningContent = msg.history[msg.historyIndex].reasoningContent;
      msg.generationState = msg.history[msg.historyIndex].state || 'complete';
      saveTabs();
      renderChat();
    }
    return;
  }

  // Next version button
  const nextVersionBtn = target.closest('.next-version-btn');
  if (nextVersionBtn) {
    if (nextVersionBtn.classList.contains('disabled')) return;
    const index = parseInt(nextVersionBtn.getAttribute('data-index'));
    const msg = currentMsgs[index];
    if (msg.historyIndex < msg.history.length - 1) {
      coreCall('invalidateTabCache', state.tabData.active);
      msg.historyIndex++;
      msg.content = msg.history[msg.historyIndex].content;
      msg.reasoningContent = msg.history[msg.historyIndex].reasoningContent;
      msg.generationState = msg.history[msg.historyIndex].state || 'complete';
      saveTabs();
      renderChat();
    }
    return;
  }

  // Copy prompt button (token limit warning)
  const copyPromptBtn = target.closest('#copyPromptBtn');
  if (copyPromptBtn) {
    const text = document.getElementById('promptText').innerText;
    copyText(text);
    const originalHtml = copyPromptBtn.innerHTML;
    copyPromptBtn.innerHTML = checkIconSvg;
    setTimeout(() => { copyPromptBtn.innerHTML = originalHtml; }, 1500);
    return;
  }
}

export function rebindChatButtons() {
  const chat = document.getElementById('chat');
  if (!chat) return;

  if (!_chatEventsBound) {
    chat.addEventListener('click', handleChatClick);
    _chatEventsBound = true;
  }
}

// ========== 渲染聊天 ==========

export function renderChat() {
  const chat = document.getElementById("chat");
  const currentTab = state.tabData.list[state.tabData.active];
  const currentMsgs = currentTab.messages || [];
  const lastUserMsgIndex = getLastUserMessageIndex();
  const isGroupChat = currentTab.type === 'group';
  const isSingleCharChat = currentTab.type === 'single-character';

  // renderChat 执行全量渲染，清除当前 tab 的缓存
  coreCall('invalidateTabCache', state.tabData.active);

  chat.innerHTML = "";

  // 群聊头部：显示参与角色
  if (isGroupChat && currentTab.characterIds) {
    const groupChars = currentTab.characterIds.map(id => coreCall('getCharacterById', id)).filter(Boolean);
    if (groupChars.length > 0) {
      const headerDiv = document.createElement("div");
      headerDiv.className = "group-chat-header";
      const memberTags = groupChars.map((c, i) => {
        const color = coreCall('getCharacterColor', i);
        return `<span class="group-chat-member-tag" style="background:${color}">${escapeHtml(c.name)}</span>`;
      }).join('');
      headerDiv.innerHTML = `<div class="group-chat-header-text">群聊成员</div><div class="group-chat-members">${memberTags}</div>`;
      chat.appendChild(headerDiv);
    }
  }

  // 单角色聊天头部：显示角色信息
  if (isSingleCharChat && currentTab.characterId) {
    const char = coreCall('getCharacterById', currentTab.characterId);
    if (char) {
      const headerDiv = document.createElement("div");
      headerDiv.className = "group-chat-header";
      const color = coreCall('getCharacterColor', 0);
      const tag = `<span class="group-chat-member-tag" style="background:${color}">${escapeHtml(char.name)}</span>`;
      headerDiv.innerHTML = `<div class="group-chat-header-text">正在与角色对话</div><div class="group-chat-members">${tag}</div>`;
      chat.appendChild(headerDiv);
    }
  }

  currentMsgs.forEach((m, i) => {
    const isUser = m.role === 'user';
    const isAssistant = m.role === 'assistant';
    const isCharacter = m.role === 'character';
    const isGroupAssistant = isGroupChat && isAssistant;
    const isLastAssistant = isAssistant && !isGroupAssistant && i === currentMsgs.length - 1;
    const isLastUserMessage = i === lastUserMsgIndex;

    const msgBox = document.createElement("div");
    msgBox.id = `msg-${i}`;

    if (isCharacter || isGroupAssistant) {
      const charIndex = (currentTab.characterIds || []).indexOf(m.characterId);
      const color = coreCall('getCharacterColor', charIndex >= 0 ? charIndex : 0);
      msgBox.className = `message-box character-msg p-3 rounded-xl bg-gray-800 mr-auto max-w-[85%] text-white`;
      msgBox.style.setProperty('border-left-color', color, 'important');

      let buttonsHtml = `<button class="delete-btn" data-index="${i}" title="删除">${deleteIconSvg}</button>`;
      buttonsHtml += `<button class="copy-btn" data-index="${i}" title="复制">${copyIconSvg}</button>`;
      buttonsHtml += `<button class="reply-btn" data-index="${i}" data-char-id="${m.characterId || ''}" data-char-name="${escapeHtml(m.characterName || '角色')}" data-snippet="${escapeHtml((m.content || '').slice(0, 50))}" title="回复">${replyIconSvg}</button>`;

      const displayName = m.characterName || '角色';
      msgBox.innerHTML = `
        <div class="character-msg-label" style="background:${color}20;color:${color}">${escapeHtml(displayName)}</div>
        ${buttonsHtml}
      `;

      const contentDiv = document.createElement("div");
      contentDiv.className = "msg-content prose prose-invert max-w-none";
      renderMarkdown(contentDiv, m.content, i, 'content');
      msgBox.appendChild(contentDiv);

      if (m.generationState === 'interrupted') {
        const statusDiv = document.createElement("div");
        statusDiv.className = "generation-status mt-1 text-xs text-amber-400";
        statusDiv.textContent = '生成中断';
        msgBox.appendChild(statusDiv);
      }
    } else {
      const isSingleCharAssistant = isSingleCharChat && isAssistant;
      msgBox.className = `message-box p-3 rounded-xl ${isUser ? 'bg-blue-600 ml-auto' : 'bg-gray-800 mr-auto'} max-w-[85%] text-white`;

      let singleCharLabelHtml = '';
      if (isSingleCharAssistant && currentTab.characterId) {
        const char = coreCall('getCharacterById', currentTab.characterId);
        if (char) {
          const color = coreCall('getCharacterColor', 0);
          msgBox.style.setProperty('border-left-color', color, 'important');
          msgBox.classList.add('character-msg');
          singleCharLabelHtml = `<div class="character-msg-label" style="background:${color}20;color:${color}">${escapeHtml(char.name)}</div>`;
        }
      }

      let replyQuoteHtml = '';
      if (isUser && isGroupChat && m.replyTo) {
        replyQuoteHtml = `<div class="reply-quote">回复 <strong>${escapeHtml(m.replyTo.characterName || '角色')}</strong>：<span class="reply-quote-text">${escapeHtml(m.replyTo.snippet || '')}</span></div>`;
      }

      let buttonsHtml = `<button class="delete-btn" data-index="${i}" title="删除">${deleteIconSvg}</button>`;
      if (isAssistant) {
        buttonsHtml += `<button class="copy-btn" data-index="${i}" title="复制">${copyIconSvg}</button>`;
        if (isLastAssistant) buttonsHtml += `<button class="regenerate-btn" data-index="${i}" title="重新生成">↻</button>`;
      } else if (isUser) {
        buttonsHtml += `<button class="copy-btn" data-index="${i}" title="复制">${copyIconSvg}</button>`;
        if (isLastUserMessage) buttonsHtml += `<button class="edit-btn" data-index="${i}" title="编辑">✎</button>`;
      }

      let versionHtml = '';
      if (isAssistant && m.history && m.history.length > 1) {
        const hIndex = m.historyIndex || 0;
        const isFirst = hIndex === 0;
        const isLast = hIndex === m.history.length - 1;
        versionHtml = `
          <div class="version-control">
            <span class="version-btn prev-version-btn ${isFirst ? 'disabled' : ''}" data-index="${i}">❮</span>
            <span>${hIndex + 1} / ${m.history.length}</span>
            <span class="version-btn next-version-btn ${isLast ? 'disabled' : ''}" data-index="${i}">❯</span>
          </div>
        `;
      }

      msgBox.innerHTML = replyQuoteHtml + singleCharLabelHtml + versionHtml + buttonsHtml;

      if (isAssistant && m.reasoningContent) {
        const details = document.createElement('details');
        details.className = "reasoning-details mb-2 border border-gray-700 rounded-lg p-2 bg-gray-900";
        details.open = true;
        details.innerHTML = `<summary class="text-xs text-gray-400 cursor-pointer select-none outline-none">思考过程</summary>`;
        const reasoningDiv = document.createElement('div');
        reasoningDiv.className = "reasoning-content prose prose-invert max-w-none text-sm text-gray-400 mt-2 border-t border-gray-700 pt-2";
        renderMarkdown(reasoningDiv, m.reasoningContent, i, 'reasoning');
        details.appendChild(reasoningDiv);
        msgBox.appendChild(details);
      }

      const contentDiv = document.createElement("div");
      contentDiv.className = "msg-content prose prose-invert max-w-none";
      renderMarkdown(contentDiv, m.content, i, 'content');
      msgBox.appendChild(contentDiv);

      if (isUser && !isGroupChat) {
        const userInputMeta = buildUserInputMeta(currentMsgs, i);
        if (userInputMeta) {
          const metaDiv = document.createElement('div');
          metaDiv.className = "message-meta user-input-meta mt-2 text-xs";
          metaDiv.textContent = `本次正文 ${userInputMeta.inputChars} 字，约 ${userInputMeta.inputTokens} tokens；历史记忆约 ${userInputMeta.historyTokens} tokens；本轮输入共约 ${userInputMeta.totalInputTokens} tokens`;
          msgBox.appendChild(metaDiv);
        }
      }

      if (isAssistant) {
        const metaDiv = document.createElement('div');
        metaDiv.className = "message-meta assistant-meta mt-2 text-xs text-gray-400";
        const totalChars = countChars(m.reasoningContent) + countChars(m.content);
        const tokenEstimate = estimateTokensByChars(totalChars);
        metaDiv.textContent = `思考 ${countChars(m.reasoningContent)} 字，正文 ${countChars(m.content)} 字，约 ${tokenEstimate} tokens`;
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

  // Token 限制警告
  if (currentMsgs.length > 0 && !isGroupChat && isTokenLimitReached()) {
    const warningDiv = document.createElement("div");
    warningDiv.className = "text-xs text-gray-500 text-center mt-6 mb-4 px-2";
    warningDiv.innerHTML = `
      当前对话框上下文即将达到上限。建议总结并开启新对话，或调整对话记忆条数：<br>
      <div class="inline-block bg-gray-800 rounded p-2 mt-2 text-left border border-gray-700 relative pr-10 max-w-[90%] mx-auto">
        <span id="promptText" class="text-gray-400 break-all">请帮我把目前为止的故事剧情、出场人物设定、伏笔和当前的主线任务做一个极其详细的总结（约2000字）。</span>
        <button id="copyPromptBtn" class="absolute right-2 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-white bg-gray-700 rounded p-1 transition-colors" title="复制指令">
          ${copyIconSvg}
        </button>
      </div>
    `;
    chat.appendChild(warningDiv);

    const copyPromptBtn = warningDiv.querySelector('#copyPromptBtn');
    if (copyPromptBtn) {
      copyPromptBtn.addEventListener('click', function() {
        const text = document.getElementById('promptText').innerText;
        copyText(text);
        const originalHtml = this.innerHTML;
        this.innerHTML = checkIconSvg;
        setTimeout(() => { this.innerHTML = originalHtml; }, 1500);
      });
    }
  }

  rebindChatButtons();

  // 仅在用户原本就在底部时才自动滚到底
  if (chat.scrollTop + chat.clientHeight >= chat.scrollHeight - 60) {
    chat.scrollTop = chat.scrollHeight;
  }
  setTimeout(checkScrollButton, 50);

  if (currentMsgs.length === 0) {
    showEmptyChatHint();
  } else {
    hideEmptyChatHint();
  }
}

// ========== 发送消息 ==========

export async function sendMessage() {
  const chat = document.getElementById("chat");
  const input = document.getElementById("input");
  const sendBtn = document.getElementById("sendBtn");
  const keyPanel = document.getElementById("keyPanel");

  if (state.isSending) return;
  const text = input.value.trim();
  if (!text) { input.focus(); return; }
  if (!state.apiKey) { keyPanel.classList.remove("hidden"); return; }
  if (isStorageFull()) {
    alert('本地存储空间已满，无法保存新消息。请先导出重要对话，再清理过期会话后继续使用。');
    return;
  }

  const sendingTabId = state.tabData.active;
  const currentTab = state.tabData.list[sendingTabId];
  const currentMsgs = currentTab.messages || [];
  const isFirstMessage = currentMsgs.length === 0;

  // 群聊分支
  if (currentTab.type === 'group' && currentTab.characterIds && currentTab.characterIds.length > 0) {
    const userMsg = { role: "user", content: text };
    if (state.replyTarget) {
      userMsg.replyTo = { characterId: state.replyTarget.characterId, characterName: state.replyTarget.characterName, snippet: state.replyTarget.snippet };
    }
    currentMsgs.push(userMsg);
    state.tabData.list[sendingTabId].messages = currentMsgs;
    saveTabs();
    renderChat();

    input.value = "";
    autoHeight();
    updateInputCounter();
    const replyInfo = state.replyTarget ? { ...state.replyTarget } : null;
    hideReplyBar();

    // 动态导入 groupchat.js 中的 sendGroupMessage，避免循环依赖
    const { sendGroupMessage } = await import('./groupchat.js');
    await sendGroupMessage(sendingTabId, text, replyInfo);

    if (isFirstMessage && state.tabData.active === sendingTabId) {
      generateTitleForCurrentTab();
    }
    return;
  }

  // 单聊分支
  currentMsgs.push({ role: "user", content: text });
  currentMsgs[currentMsgs.length - 1].inputMeta = buildUserInputMeta(currentMsgs, currentMsgs.length - 1);
  state.tabData.list[sendingTabId].messages = currentMsgs;
  saveTabs();
  renderChat();

  input.value = "";
  autoHeight();
  updateInputCounter();
  await fetchAndStreamResponse();

  if (isFirstMessage && state.tabData.active === sendingTabId) {
    const tab = state.tabData.list[sendingTabId];
    if (tab.type !== 'single-character') {
      generateTitleForCurrentTab();
    }
  }
}

// ========== 流式请求 ==========

export async function fetchAndStreamResponse(opts = {}) {
  const chat = document.getElementById("chat");
  const sendBtn = document.getElementById("sendBtn");
  const keyPanel = document.getElementById("keyPanel");
  const modelSelect = document.getElementById("modelSelect");

  state.isSending = true;
  sendBtn.textContent = "停止";
  sendBtn.classList.add("stop-mode");

  const lockedTabId = state.tabData.active;

  state.abortReason = null;
  state.abortController = new AbortController();

  // 120秒无响应自动超时
  const fetchTimeout = setTimeout(() => {
    if (state.abortController && !state.isSending) return;
    state.abortReason = 'timeout';
    state.abortController.abort();
  }, 120000);

  trackEvent('发送消息');

  const currentMsgs = state.tabData.list[lockedTabId].messages || [];
  const isRegen = opts.regenerateIndex !== undefined;
  const targetIndex = isRegen ? opts.regenerateIndex : currentMsgs.length;
  const selectedModel = modelSelect.value;

  const payloadMsgs = buildPayloadMessages(currentMsgs, isRegen ? targetIndex : currentMsgs.length);

  const isAtBottom = chat.scrollTop + chat.clientHeight >= chat.scrollHeight - 20;
  let aiMsgDiv;

  if (isRegen) {
    aiMsgDiv = document.getElementById(`msg-${targetIndex}`);
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
    aiMsgDiv.id = `msg-${targetIndex}`;
    aiMsgDiv.className = "message-box p-3 rounded-xl bg-gray-800 mr-auto max-w-[85%] text-white";

    let streamLabelHtml = '';
    const lockedTab = state.tabData.list[lockedTabId];
    if (lockedTab && lockedTab.type === 'single-character' && lockedTab.characterId) {
      const streamChar = coreCall('getCharacterById', lockedTab.characterId);
      if (streamChar) {
        const streamColor = coreCall('getCharacterColor', 0);
        aiMsgDiv.style.setProperty('border-left-color', streamColor, 'important');
        aiMsgDiv.classList.add('character-msg');
        streamLabelHtml = `<div class="character-msg-label" style="background:${streamColor}20;color:${streamColor}">${escapeHtml(streamChar.name)}</div>`;
      }
    }

    aiMsgDiv.innerHTML = streamLabelHtml + `<button class="copy-btn" title="复制">${copyIconSvg}</button><div class="msg-content prose prose-invert max-w-none"></div>`;

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
    if (state.abortReason === "background") return true;
    if (Date.now() - state.lastPageHiddenAt > 6000) return false;
    const msg = String(err && err.message ? err.message : "");
    if (!msg) return true;
    return /(load failed|failed to fetch|networkerror|cancelled|canceled)/i.test(msg);
  }

  try {
    const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${state.apiKey}`,
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
      signal: state.abortController.signal
    });

    if (!res.ok) {
      const errorData = await res.json();
      throw new Error(`API请求失败：${errorData.error?.message || '请检查API Key是否有效'}`);
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
              details.innerHTML = `<summary class="text-xs text-gray-400 cursor-pointer select-none outline-none">思考过程</summary><div class="reasoning-content prose prose-invert max-w-none text-sm text-gray-400 mt-2 border-t border-gray-700 pt-2"></div>`;
              const msgContentDiv = aiMsgDiv.querySelector('.msg-content');
              aiMsgDiv.insertBefore(details, msgContentDiv);
              reasoningContentDiv = details.querySelector('.reasoning-content');
            }
            fullReasoningContent += delta.reasoning_content;
            renderMarkdown(reasoningContentDiv, fullReasoningContent);
          }

          if (delta.content) {
            fullContent += delta.content;
            const contentDiv = aiMsgDiv.querySelector('.msg-content');
            if (contentDiv) {
              renderMarkdown(contentDiv, fullContent);
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
      if (state.abortReason === 'background' || state.abortReason === 'manual') markInterrupted();
      else if (state.abortReason === 'timeout') {
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
        contentDiv.innerHTML = `<span class="text-red-400">❌ 错误：${e.message}</span>`;
      }
      console.error("发送消息错误：", e);

      if (e.message.includes("API请求失败") || e.message.includes("Key")) {
        setTimeout(() => {
          if (confirm("检测到API Key可能无效，是否立即修改？")) {
            openSettingsPanel();
          }
        }, 1000);
      }
    }
  } finally {
    clearTimeout(fetchTimeout);
    state.isSending = false;
    sendBtn.textContent = "发送";
    sendBtn.classList.remove("stop-mode");
    state.abortController = null;
  }

  function finalizeMessage(fState = "complete") {
    if (isRegen) {
      currentMsgs[targetIndex].generationState = fState;
      currentMsgs[targetIndex].content = fullContent;
      currentMsgs[targetIndex].reasoningContent = fullReasoningContent;
      currentMsgs[targetIndex].history[currentMsgs[targetIndex].historyIndex] = { content: fullContent, reasoningContent: fullReasoningContent, state: fState };
    } else {
      currentMsgs.push({
        role: "assistant",
        content: fullContent,
        reasoningContent: fullReasoningContent,
        generationState: fState,
        history: [{ content: fullContent, reasoningContent: fullReasoningContent, state: fState }],
        historyIndex: 0
      });
    }
    state.tabData.list[lockedTabId].messages = currentMsgs;
    saveTabs();
    renderChat();
  }
}

// ========== 编辑和重新生成 ==========

export async function saveEditAndRegenerate() {
  const editPanel = document.getElementById("editPanel");
  const editTextarea = document.getElementById("editTextarea");

  const newContent = editTextarea.value.trim();
  if (!newContent) return alert("消息内容不能为空！");
  const currentTab = state.tabData.list[state.tabData.active];
  const currentMsgs = currentTab.messages || [];
  if (state.editingMessageIndex < 0 || state.editingMessageIndex >= currentMsgs.length) return alert("编辑的消息不存在。");

  const editIdx = state.editingMessageIndex;
  const messagesToKeep = currentMsgs.slice(0, editIdx + 1);
  messagesToKeep[editIdx].content = newContent;
  currentTab.messages = messagesToKeep;
  saveTabs();

  editPanel.classList.add("hidden");
  state.editingMessageIndex = -1;
  renderChat();

  // 群聊走群聊发送逻辑
  if (currentTab.type === 'group') {
    const { sendGroupMessage } = await import('./groupchat.js');
    await sendGroupMessage(state.tabData.active, newContent);
  } else {
    if (messagesToKeep[editIdx]?.role === 'user') {
      messagesToKeep[editIdx].inputMeta = buildUserInputMeta(messagesToKeep, editIdx);
      saveTabs();
    }
    await fetchAndStreamResponse();
  }
}

export function cancelEdit() {
  const editPanel = document.getElementById("editPanel");
  editPanel.classList.add("hidden");
  state.editingMessageIndex = -1;
}

export function editUserMessage(messageIndex) {
  const editPanel = document.getElementById("editPanel");
  const editTextarea = document.getElementById("editTextarea");

  const currentMsgs = state.tabData.list[state.tabData.active].messages || [];
  if (messageIndex < 0 || messageIndex >= currentMsgs.length) return alert("消息索引无效。");
  const targetMessage = currentMsgs[messageIndex];
  if (targetMessage.role !== 'user') return alert("只能编辑用户消息。");

  state.editingMessageIndex = messageIndex;
  editTextarea.value = targetMessage.content;
  editPanel.classList.remove("hidden");
  editTextarea.focus();
}

export function regenerateResponse(messageIndex) {
  if (!state.apiKey) {
    const keyPanel = document.getElementById("keyPanel");
    keyPanel.classList.remove("hidden");
    return;
  }
  const currentMsgs = state.tabData.list[state.tabData.active].messages || [];
  if (currentMsgs.length === 0) return alert("当前对话为空，无法重新生成。");
  if (messageIndex < 0 || messageIndex >= currentMsgs.length) return alert("消息索引无效。");
  const targetMessage = currentMsgs[messageIndex];
  if (targetMessage.role !== 'assistant') return alert("只能重新生成AI的回复。");

  fetchAndStreamResponse({ regenerateIndex: messageIndex });
}

// ========== 输入框相关 ==========

export function autoHeight() {
  const input = document.getElementById("input");
  input.style.height = "44px";
  const scrollH = input.scrollHeight;
  input.style.height = Math.min(Math.max(scrollH, 44), 88) + "px";
}

export function updateInputCounter() {
  const input = document.getElementById("input");
  const inputCounter = document.getElementById("inputCounter");
  const text = input.value;
  const charCount = text.length;
  const tokenEstimate = estimateTokensByChars(charCount);
  if (charCount > 0) {
    inputCounter.textContent = `${charCount} 字 / 约 ${tokenEstimate} tokens`;
  } else {
    inputCounter.textContent = "0 字";
  }
}

// ========== 滚动相关 ==========

export function scrollToBottom() {
  const chat = document.getElementById("chat");
  chat.scrollTo({ top: chat.scrollHeight, behavior: 'smooth' });
}

export function checkScrollButton() {
  const chat = document.getElementById("chat");
  const scrollToBottomBtn = document.getElementById("scrollToBottomBtn");
  const distanceFromBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight;
  if (distanceFromBottom > 200) {
    scrollToBottomBtn.classList.add('visible');
  } else {
    scrollToBottomBtn.classList.remove('visible');
  }
}

// ========== 辅助函数 ==========

export function getLastUserMessageIndex() {
  const currentMsgs = state.tabData.list[state.tabData.active].messages || [];
  for (let i = currentMsgs.length - 1; i >= 0; i--) {
    if (currentMsgs[i].role === 'user') return i;
  }
  return -1;
}

// ========== 生成标题 ==========

export async function generateTitleForCurrentTab() {
  const titleTabId = state.tabData.active;
  const currentMsgs = state.tabData.list[titleTabId].messages || [];
  if (currentMsgs.length < 2) return;

  const firstUserMsg = currentMsgs.find(m => m.role === 'user');
  if (!firstUserMsg) return;

  try {
    const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${state.apiKey}`
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [
          { role: "user", content: `请为以下对话生成一个简洁、描述性的标题（不超过 15 个字）。只返回标题，不要其他内容。\n\n用户消息：${firstUserMsg.content}` }
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
        state.tabData.list[titleTabId].title = title;
        saveTabs();
        coreCall('renderTabs');
      }
    }
  } catch (e) {
    console.log('生成标题失败，不影响功能', e);
  }
}

// ========== 聊天事件绑定 ==========

export function bindChatEvents() {
  const input = document.getElementById("input");
  const sendBtn = document.getElementById("sendBtn");
  const editCancelBtn = document.getElementById("editCancelBtn");
  const editSaveBtn = document.getElementById("editSaveBtn");
  const editPanel = document.getElementById("editPanel");
  const scrollToBottomBtn = document.getElementById("scrollToBottomBtn");
  const chat = document.getElementById("chat");

  if (sendBtn) {
    sendBtn.addEventListener("click", () => {
      if (state.isSending) {
        state.abortReason = 'manual';
        if (state.abortController) {
          try { state.abortController.abort(); } catch (_) {}
        }
      } else {
        sendMessage();
      }
    });
  }

  if (input) {
    input.addEventListener("input", () => {
      autoHeight();
      updateInputCounter();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (!state.isSending) {
          sendMessage();
        }
      }
    });
  }

  if (editCancelBtn) editCancelBtn.addEventListener("click", cancelEdit);
  if (editSaveBtn) editSaveBtn.addEventListener("click", saveEditAndRegenerate);
  if (editPanel) editPanel.addEventListener("click", function(e) { if (e.target === editPanel) cancelEdit(); });

  if (scrollToBottomBtn) scrollToBottomBtn.addEventListener("click", scrollToBottom);
  if (chat) chat.addEventListener("scroll", checkScrollButton);

  // 初始化输入框
  autoHeight();
  updateInputCounter();
}
