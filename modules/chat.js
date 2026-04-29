/**
 * chat.js — 聊天核心模块
 *
 * 负责聊天渲染、消息发送、流式请求、编辑/重新生成等功能。
 */

import { state, setTabSending, clearTabSending, abortTabSending, getEffectiveModel, isV4Model } from './state.js';
import {
  escapeHtml, copyText, checkIconSvg, deleteIconSvg, copyIconSvg,
  replyIconSvg, favoriteIconSvg, estimateTokensByChars, countChars, trackEvent, generateMessageId, formatRoleplayReply
} from './utils.js';
import {
  saveTabs, buildPayloadMessages, buildUserInputMeta, normalizeTabSummaryState,
  isTokenLimitReached, isStorageFull
} from './storage.js';
import { checkAndGenerateSummary, clearSummary } from './summary.js';
import { callLLM, createChunkInactivityGuard, CHUNK_INACTIVITY_TIMEOUT_MS } from './llm.js';
import { renderMarkdown } from './markdown.js';
import { enhanceHtmlCodeBlocks } from './html-preview.js';
import {
  showToast, openSettingsPanel, showEmptyChatHint,
  hideEmptyChatHint, hideReplyBar, showReplyBar
} from './panels.js';
import { canFavoriteMessage, isMessageFavorited, toggleFavoriteForMessage, removeFavoritesForMessageIds } from './favorites.js';
import { call as coreCall } from './core.js';

// ========== 聊天区域事件绑定（事件委托） ==========

let _chatEventsBound = false;
const TEXT_ATTACHMENT_FULL_CHAR_LIMIT = 5000;
const TEXT_ATTACHMENT_MAX_CHAR_LIMIT = 25000;

function getTextAttachmentMode(charCount) {
  if (charCount <= 0) return 'empty';
  if (charCount <= TEXT_ATTACHMENT_FULL_CHAR_LIMIT) return 'full';
  if (charCount <= TEXT_ATTACHMENT_MAX_CHAR_LIMIT) return 'summary';
  return 'over_limit';
}

function getTextAttachmentModeLabel(mode) {
  if (mode === 'full') return '全文发送';
  if (mode === 'summary') return '摘要发送';
  if (mode === 'over_limit') return '超出上限';
  return '待处理';
}

function buildTextAttachmentPayload(questionText, attachment) {
  const sectionTitle = attachment.mode === 'summary' ? '【文件内容摘要】' : '【文件内容】';
  return `【用户问题】\n${questionText}\n\n${sectionTitle}\n${attachment.sentText}`;
}

function trimTextToCharLimit(text, charLimit) {
  let visibleCount = 0;
  let out = '';
  for (const ch of String(text || '')) {
    if (!/\s/.test(ch)) visibleCount++;
    if (visibleCount > charLimit) break;
    out += ch;
  }
  return out.trim();
}

async function decodeTxtFile(file) {
  const buffer = await file.arrayBuffer();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  return decoder.decode(buffer);
}

async function summarizeTextAttachment(originalText, signal = null, tabEntry = null) {
  const result = await callLLM({
    model: state.selectedModel,
    messages: [
      {
        role: 'system',
        content: `请将以下 txt 文件内容压缩为 ${TEXT_ATTACHMENT_FULL_CHAR_LIMIT} 字以内的高质量摘要，要求：
1. 保留核心事实、关键设定、时间线、逻辑关系、结论与限制条件
2. 保留后续继续提问所需的重要上下文
3. 若原文存在章节、条目或结构，请尽量保留结构感
4. 保留人物、角色关系、数字、时间、地点、约束条件和未解决事项
5. 不要编造原文没有的信息
6. 只输出摘要正文，不要输出额外说明`
      },
      { role: 'user', content: originalText }
    ],
    stream: false,
    temperature: 0.2,
    maxTokens: 5000,
    signal,
    chunkTimeoutMs: CHUNK_INACTIVITY_TIMEOUT_MS,
    onTimeout() {
      // 直接写入发起摘要时的 tab entry，避免通过 state.abortReason 访问器误写到"当前 active tab"
      // （在多 tab 并发聊天场景下，active 可能已切到正在流式的其他 tab，误写会把那条流式标记为 timeout）
      if (tabEntry) tabEntry.abortReason = 'timeout';
    }
  });
  const summary = typeof result === 'string' ? result : (result?.content || '');
  return trimTextToCharLimit(summary, TEXT_ATTACHMENT_FULL_CHAR_LIMIT);
}

function updatePendingTextAttachmentUI() {
  const bar = document.getElementById('txtAttachmentBar');
  const nameEl = document.getElementById('txtAttachmentName');
  const modeEl = document.getElementById('txtAttachmentMode');
  const metaEl = document.getElementById('txtAttachmentMeta');
  const removeBtn = document.getElementById('removeTxtAttachmentBtn');
  if (!bar || !nameEl || !modeEl || !metaEl || !removeBtn) return;

  const attachment = state.pendingTextAttachment;
  if (!attachment) {
    bar.classList.add('hidden');
    nameEl.textContent = '';
    modeEl.textContent = '';
    modeEl.className = 'txt-attachment-mode';
    metaEl.textContent = '';
    removeBtn.disabled = false;
    return;
  }

  bar.classList.remove('hidden');
  nameEl.textContent = attachment.fileName;
  modeEl.textContent = getTextAttachmentModeLabel(attachment.mode);
  modeEl.className = `txt-attachment-mode ${attachment.mode === 'summary' ? 'mode-summary' : ''} ${attachment.mode === 'over_limit' ? 'mode-error' : ''}`.trim();

  if (attachment.mode === 'over_limit') {
    metaEl.textContent = `${attachment.originalCharCount} 字，超出 ${TEXT_ATTACHMENT_MAX_CHAR_LIMIT} 字上限，无法发送`;
  } else if (state.isPreparingTextAttachment) {
    metaEl.textContent = `${attachment.originalCharCount} 字，正在总结为 ${TEXT_ATTACHMENT_FULL_CHAR_LIMIT} 字摘要...`;
  } else if (attachment.runtimeStatus === 'sending') {
    metaEl.textContent = attachment.mode === 'summary'
      ? `${attachment.originalCharCount} 字，已摘要为 ${attachment.processedCharCount} 字，正在发送给 DS...`
      : `${attachment.originalCharCount} 字，全文已就绪，正在发送给 DS...`;
  } else if (attachment.mode === 'summary') {
    metaEl.textContent = attachment.processedText
      ? `${attachment.originalCharCount} 字，已摘要为 ${attachment.processedCharCount} 字，发送时将附带摘要`
      : `${attachment.originalCharCount} 字，发送时将自动摘要为 ${TEXT_ATTACHMENT_FULL_CHAR_LIMIT} 字以内`;
  } else {
    metaEl.textContent = `${attachment.originalCharCount} 字，发送时将完整附带到本条消息`;
  }
  removeBtn.disabled = state.isPreparingTextAttachment;
}

function finishComposerActionMenuClose(menu) {
  if (!menu) return;
  menu.classList.remove('closing', 'opening');
  menu.classList.add('hidden');
  const callbacks = Array.isArray(menu._afterCloseCallbacks) ? menu._afterCloseCallbacks : [];
  menu._afterCloseCallbacks = [];
  callbacks.forEach(callback => {
    try { callback(); } catch (_) {}
  });
}

function syncComposerActionMenuState(menu = document.getElementById('composerActionMenu')) {
  const inputShell = document.querySelector('.input-shell');
  const body = document.body;
  const isVisible = !!(menu && !menu.classList.contains('hidden'));
  if (inputShell) inputShell.classList.toggle('composer-expanded', isVisible);
  if (body) body.classList.toggle('composer-panel-open', isVisible);
  updateComposerLayoutMetrics();
}

function queueComposerActionMenuAfterClose(menu, callback) {
  if (!menu || typeof callback !== 'function') return;
  if (!Array.isArray(menu._afterCloseCallbacks)) {
    menu._afterCloseCallbacks = [];
  }
  menu._afterCloseCallbacks.push(callback);
}

let _composerLayoutRafId = 0;
let _composerResizeObserver = null;

export function updateComposerLayoutMetrics() {
  if (_composerLayoutRafId) cancelAnimationFrame(_composerLayoutRafId);
  _composerLayoutRafId = requestAnimationFrame(() => {
    _composerLayoutRafId = 0;
    const chat = document.getElementById('chat');
    const inputContainer = document.querySelector('.input-container');
    const inputShell = document.querySelector('.input-shell');
    const emptyChatHint = document.getElementById('emptyChatHint');
    const scrollToBottomBtn = document.getElementById('scrollToBottomBtn');
    if (!chat || !inputContainer || !inputShell) return;

    const containerRect = inputContainer.getBoundingClientRect();
    const shellRect = inputShell.getBoundingClientRect();
    const overlayTop = Math.max(0, Math.min(containerRect.top, shellRect.top));
    const overlayHeight = Math.max(window.innerHeight - overlayTop, 0);

    chat.style.paddingBottom = `${Math.ceil(overlayHeight + 20)}px`;
    if (emptyChatHint) emptyChatHint.style.bottom = `${Math.ceil(overlayHeight + 28)}px`;
    if (scrollToBottomBtn) scrollToBottomBtn.style.bottom = `${Math.ceil(overlayHeight + 16)}px`;

    checkScrollButton();
  });
}

function keepChatBottomVisibleForComposerMenu() {
  const chat = document.getElementById('chat');
  if (!chat) return;
  const distanceFromBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight;
  if (distanceFromBottom > 240) return;
  if (chat._composerKeepBottomTimer) {
    clearTimeout(chat._composerKeepBottomTimer);
  }
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      chat.scrollTo({ top: chat.scrollHeight, behavior: 'smooth' });
      checkScrollButton();
    });
  });
  chat._composerKeepBottomTimer = setTimeout(() => {
    chat.scrollTo({ top: chat.scrollHeight, behavior: 'smooth' });
    checkScrollButton();
    chat._composerKeepBottomTimer = null;
  }, 240);
}

function openComposerActionMenu() {
  const menu = document.getElementById('composerActionMenu');
  if (!menu) return;
  menu._afterCloseCallbacks = [];
  menu.classList.remove('hidden', 'closing');
  syncComposerActionMenuState(menu);
  void menu.offsetWidth;
  menu.classList.add('opening');
  keepChatBottomVisibleForComposerMenu();
  menu.addEventListener('animationend', () => {
    menu.classList.remove('opening');
  }, { once: true });
  updateComposerPrimaryButtonState();
}

export function closeComposerActionMenu(options = {}) {
  const menu = document.getElementById('composerActionMenu');
  const { immediate = false, onAfterClose = null, skipUpdate = false } = options;
  if (!menu) {
    if (typeof onAfterClose === 'function') onAfterClose();
    return;
  }
  queueComposerActionMenuAfterClose(menu, onAfterClose);
  if (menu.classList.contains('hidden') && !menu.classList.contains('closing')) {
    if (typeof onAfterClose === 'function') {
      const callbacks = menu._afterCloseCallbacks || [];
      menu._afterCloseCallbacks = [];
      callbacks.forEach(callback => {
        try { callback(); } catch (_) {}
      });
    }
    syncComposerActionMenuState(menu);
    if (!skipUpdate) updateComposerPrimaryButtonState();
    return;
  }
  if (immediate) {
    finishComposerActionMenuClose(menu);
    syncComposerActionMenuState(menu);
    if (!skipUpdate) updateComposerPrimaryButtonState();
    return;
  }
  if (menu.classList.contains('closing')) {
    syncComposerActionMenuState(menu);
    if (!skipUpdate) updateComposerPrimaryButtonState();
    return;
  }
  menu.classList.remove('opening');
  menu.classList.add('closing');
  syncComposerActionMenuState(menu);
  menu.addEventListener('animationend', () => {
    finishComposerActionMenuClose(menu);
    syncComposerActionMenuState(menu);
    if (!skipUpdate) updateComposerPrimaryButtonState();
  }, { once: true });
  if (!skipUpdate) updateComposerPrimaryButtonState();
}

function toggleComposerActionMenu() {
  const menu = document.getElementById('composerActionMenu');
  if (!menu || state.isSending) return;
  if (menu.classList.contains('hidden')) {
    openComposerActionMenu();
    return;
  }
  if (menu.classList.contains('closing')) return;
  closeComposerActionMenu();
}

function isComposerActionMenuOpen() {
  const menu = document.getElementById('composerActionMenu');
  return !!(menu && !menu.classList.contains('hidden'));
}

export function updateComposerPrimaryButtonState() {
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('sendBtn');
  const menu = document.getElementById('composerActionMenu');
  if (!input || !sendBtn) return;

  if (state.isSending || state.isPreparingTextAttachment) {
    if (menu && !menu.classList.contains('hidden')) {
      finishComposerActionMenuClose(menu);
    }
    syncComposerActionMenuState(menu);
    sendBtn.textContent = '停止';
    sendBtn.title = state.isPreparingTextAttachment ? '停止处理' : '停止生成';
    sendBtn.setAttribute('aria-label', state.isPreparingTextAttachment ? '停止处理' : '停止生成');
    sendBtn.classList.remove('plus-mode');
    sendBtn.classList.add('stop-mode');
    return;
  }

  const hasInput = !!input.value.trim();
  const isMenuOpen = isComposerActionMenuOpen();
  sendBtn.classList.remove('stop-mode');
  if (hasInput) {
    if (menu && !menu.classList.contains('hidden')) {
      finishComposerActionMenuClose(menu);
    }
    syncComposerActionMenuState(menu);
    sendBtn.textContent = '发送';
    sendBtn.title = '发送消息';
    sendBtn.setAttribute('aria-label', '发送消息');
    sendBtn.classList.remove('plus-mode');
  } else {
    sendBtn.textContent = isMenuOpen ? '×' : '+';
    sendBtn.title = isMenuOpen ? '收起快捷操作' : '更多操作';
    sendBtn.setAttribute('aria-label', isMenuOpen ? '收起快捷操作' : '更多操作');
    sendBtn.classList.add('plus-mode');
    syncComposerActionMenuState(menu);
  }
}

export function clearPendingTextAttachment() {
  state.pendingTextAttachment = null;
  state.isPreparingTextAttachment = false;
  const txtUploadInput = document.getElementById('txtUploadInput');
  if (txtUploadInput) txtUploadInput.value = '';
  closeComposerActionMenu();
  updatePendingTextAttachmentUI();
  updateInputCounter();
  updateComposerPrimaryButtonState();
}

async function handleTxtFileSelected(file) {
  if (!file) return;
  if (!/\.txt$/i.test(file.name)) {
    alert('仅支持上传 .txt 文件');
    clearPendingTextAttachment();
    return;
  }

  try {
    const originalText = await decodeTxtFile(file);
    const originalCharCount = countChars(originalText);
    const mode = getTextAttachmentMode(originalCharCount);
    if (mode === 'empty') {
      alert('文件内容为空，无法发送');
      clearPendingTextAttachment();
      return;
    }

    state.pendingTextAttachment = {
      fileName: file.name,
      originalText,
      originalCharCount,
      mode,
      processedText: '',
      processedCharCount: 0,
      runtimeStatus: 'ready'
    };
    closeComposerActionMenu();
    updatePendingTextAttachmentUI();
    updateInputCounter();
    updateComposerPrimaryButtonState();
  } catch (e) {
    alert('文件编码不支持，请保存为 UTF-8 编码的 txt 文件后重试');
    clearPendingTextAttachment();
  }
}

async function buildOutgoingUserMessage(questionText) {
  const pending = state.pendingTextAttachment;
  if (!pending) {
    return {
      content: questionText,
      userQuestion: '',
      fileAttachment: null
    };
  }

  if (pending.mode === 'over_limit') {
    alert(`文件字数超出上限（${TEXT_ATTACHMENT_MAX_CHAR_LIMIT}字），请裁剪后再试`);
    return null;
  }

  let sentText = pending.originalText;
  let sentMode = pending.mode;
  let processedCharCount = pending.processedCharCount || 0;

  if (pending.mode === 'summary') {
    if (!pending.processedText) {
      const preparingTabId = state.tabData.active;
      const preparingEntry = setTabSending(preparingTabId, {
        isPreparingTextAttachment: true,
        abortReason: null,
        abortController: new AbortController()
      });
      updatePendingTextAttachmentUI();
      updateComposerPrimaryButtonState();
      try {
        pending.processedText = await summarizeTextAttachment(pending.originalText, preparingEntry.abortController.signal, preparingEntry);
        pending.processedCharCount = countChars(pending.processedText);
      } catch (e) {
        setTabSending(preparingTabId, { isPreparingTextAttachment: false, abortController: null });
        updateComposerPrimaryButtonState();
        if (e.name === 'AbortError') {
          pending.runtimeStatus = 'ready';
          updatePendingTextAttachmentUI();
          return null;
        }
        alert(`文件摘要失败：${e.message || '请稍后重试'}`);
        updatePendingTextAttachmentUI();
        return null;
      }
      setTabSending(preparingTabId, { isPreparingTextAttachment: false, abortController: null });
      pending.runtimeStatus = 'ready';
      updatePendingTextAttachmentUI();
      updateComposerPrimaryButtonState();
      updatePendingTextAttachmentUI();
    }
    sentText = pending.processedText;
    sentMode = 'summary';
  }

  return {
    content: buildTextAttachmentPayload(questionText, { mode: sentMode, sentText }),
    userQuestion: questionText,
    fileAttachment: {
      fileName: pending.fileName,
      mode: sentMode,
      originalCharCount: pending.originalCharCount,
      displayedCharCount: sentMode === 'summary' ? processedCharCount : pending.originalCharCount,
      displayText: sentText,
      summaryCharLimit: sentMode === 'summary' ? TEXT_ATTACHMENT_FULL_CHAR_LIMIT : 0
    }
  };
}

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
      const activeTab = state.tabData.list[state.tabData.active];
      const removedMessageId = activeTab.messages[index]?.id;
      coreCall('invalidateTabCache', state.tabData.active);
      activeTab.messages.splice(index, 1);
      if (removedMessageId) removeFavoritesForMessageIds(state.tabData.active, [removedMessageId], { silent: true });
      // 删除摘要覆盖范围内的消息时，清除摘要
      if (activeTab.summaryCoversUpTo > 0 && index < activeTab.summaryCoversUpTo) {
        clearSummary(state.tabData.active);
      }
      normalizeTabSummaryState(activeTab);
      saveTabs();
      coreCall('markStoryArchiveStale', state.tabData.active);
      renderChat();
    }
    return;
  }

  const favoriteBtn = target.closest('.favorite-btn');
  if (favoriteBtn) {
    const index = parseInt(favoriteBtn.getAttribute('data-index'));
    const message = currentMsgs[index];
    if (message && canFavoriteMessage(message)) {
      toggleFavoriteForMessage(state.tabData.active, message);
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
      coreCall('markStoryArchiveStale', state.tabData.active);
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
      coreCall('markStoryArchiveStale', state.tabData.active);
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
    if (m.id) msgBox.dataset.messageId = m.id;

    if (isCharacter && m.isNarration) {
      msgBox.className = "group-narration my-3 px-6";
      const contentDiv = document.createElement("div");
      contentDiv.className = "msg-content group-narration-content max-w-2xl mx-auto";
      renderMarkdown(contentDiv, m.content, i, 'content');
      msgBox.appendChild(contentDiv);
    } else if (isCharacter || isGroupAssistant) {
      const charIndex = (currentTab.characterIds || []).indexOf(m.characterId);
      const color = coreCall('getCharacterColor', charIndex >= 0 ? charIndex : 0);
      msgBox.className = `message-box character-msg p-3 rounded-xl bg-gray-800 mr-auto max-w-[85%] text-white`;
      msgBox.style.setProperty('border-left-color', color, 'important');

      let buttonsHtml = `<button class="delete-btn" data-index="${i}" title="删除">${deleteIconSvg}</button>`;
      buttonsHtml += `<button class="copy-btn" data-index="${i}" title="复制">${copyIconSvg}</button>`;
      if (canFavoriteMessage(m)) {
        buttonsHtml += `<button class="favorite-btn ${isMessageFavorited(state.tabData.active, m.id) ? 'favorited' : ''}" data-index="${i}" title="${isMessageFavorited(state.tabData.active, m.id) ? '取消收藏' : '收藏'}">${favoriteIconSvg}</button>`;
      }
      if (!m.isNarration && m.characterId) {
        buttonsHtml += `<button class="reply-btn" data-index="${i}" data-char-id="${m.characterId || ''}" data-char-name="${escapeHtml(m.characterName || '角色')}" data-snippet="${escapeHtml((m.content || '').slice(0, 50))}" title="回复">${replyIconSvg}</button>`;
      }

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
      } else if (m.generationState === 'timeout') {
        const statusDiv = document.createElement("div");
        statusDiv.className = "generation-status mt-1 text-xs text-red-400";
        statusDiv.textContent = '请求超时';
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
        if (canFavoriteMessage(m)) {
          buttonsHtml += `<button class="favorite-btn ${isMessageFavorited(state.tabData.active, m.id) ? 'favorited' : ''}" data-index="${i}" title="${isMessageFavorited(state.tabData.active, m.id) ? '取消收藏' : '收藏'}">${favoriteIconSvg}</button>`;
        }
        if (isLastAssistant) buttonsHtml += `<button class="regenerate-btn" data-index="${i}" title="重新生成">↻</button>`;
      } else if (isUser) {
        buttonsHtml += `<button class="copy-btn" data-index="${i}" title="复制">${copyIconSvg}</button>`;
        if (canFavoriteMessage(m)) {
          buttonsHtml += `<button class="favorite-btn ${isMessageFavorited(state.tabData.active, m.id) ? 'favorited' : ''}" data-index="${i}" title="${isMessageFavorited(state.tabData.active, m.id) ? '取消收藏' : '收藏'}">${favoriteIconSvg}</button>`;
        }
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
      if (isUser && m.fileAttachment) {
        contentDiv.classList.add('user-file-question');
        renderMarkdown(contentDiv, m.userQuestion || '', i, 'content');
        msgBox.appendChild(contentDiv);

        const details = document.createElement('details');
        details.className = 'user-file-attachment';
        details.innerHTML = `
          <summary>
            <span class="user-file-attachment-badge">TXT</span>
            <span class="user-file-attachment-label">${escapeHtml(m.fileAttachment.fileName || '已上传文件')}</span>
            <span class="user-file-attachment-mode ${m.fileAttachment.mode === 'summary' ? 'mode-summary' : ''}">${m.fileAttachment.mode === 'summary' ? '摘要发送' : '全文发送'}</span>
          </summary>
        `;
        const body = document.createElement('div');
        body.className = 'user-file-attachment-body';
        const meta = document.createElement('div');
        meta.className = 'user-file-attachment-meta';
        meta.textContent = m.fileAttachment.mode === 'summary'
          ? `${m.fileAttachment.originalCharCount || 0} 字原文，已摘要为 ${m.fileAttachment.displayedCharCount || 0} 字`
          : `${m.fileAttachment.originalCharCount || 0} 字原文，已完整附带发送`;
        const fileContent = document.createElement('div');
        fileContent.className = 'user-file-attachment-content';
        fileContent.textContent = m.fileAttachment.displayText || '';
        body.appendChild(meta);
        body.appendChild(fileContent);
        details.appendChild(body);
        msgBox.appendChild(details);
      } else {
        renderMarkdown(contentDiv, m.content, i, 'content');
        msgBox.appendChild(contentDiv);
      }

      if (isUser && !isGroupChat) {
        const userInputMeta = buildUserInputMeta(currentMsgs, i);
        if (userInputMeta) {
          const metaDiv = document.createElement('div');
          metaDiv.className = "message-meta user-input-meta mt-2 text-xs";
          const summaryLabel = userInputMeta.hasSummary ? '（含摘要）' : '';
          metaDiv.textContent = `本次正文 ${userInputMeta.inputChars} 字，约 ${userInputMeta.inputTokens} tokens；历史记忆约 ${userInputMeta.historyTokens} tokens${summaryLabel}；本轮输入共约 ${userInputMeta.totalInputTokens} tokens`;
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
        } else if (m.generationState === 'timeout') {
          const statusDiv = document.createElement("div");
          statusDiv.className = "generation-status mt-1 text-xs text-red-400";
          statusDiv.textContent = '请求超时，请检查网络后重试';
          msgBox.appendChild(statusDiv);
        }
      }
    }

    chat.appendChild(msgBox);
  });

  // Token 限制警告
  if (currentMsgs.length > 0 && !isGroupChat && isTokenLimitReached()) {
    const maxLabel = isV4Model() ? '100万' : '12.8万';
    const warningDiv = document.createElement("div");
    warningDiv.className = "text-xs text-gray-500 text-center mt-6 mb-4 px-2";
    warningDiv.innerHTML = `
      当前对话框上下文即将达到上限（${maxLabel} tokens）。建议总结并开启新对话：<br>
      <div class="inline-block bg-gray-800 rounded p-2 mt-2 text-left border border-gray-700 relative pr-10 max-w-[90%] mx-auto">
        <span id="promptText" class="text-gray-400 break-all">请帮我把目前为止的故事剧情、出场人物设定、伏笔和当前的主线任务做一个极其详细的总结（约6000字）。</span>
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
  enhanceHtmlCodeBlocks();

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
  const input = document.getElementById("input");
  const keyPanel = document.getElementById("keyPanel");

  if (state.isSending || state.isPreparingTextAttachment) return;
  const text = input.value.trim();
  if (!text) {
    if (state.pendingTextAttachment) alert('请输入你的问题后再发送文件');
    input.focus();
    return;
  }
  if (!state.apiKey) { keyPanel.classList.remove("hidden"); return; }
  if (isStorageFull()) {
    alert('本地存储空间已满，无法保存新消息。请先导出重要对话，再清理过期会话后继续使用。');
    return;
  }

  const sendingTabId = state.tabData.active;
  const currentTab = state.tabData.list[sendingTabId];
  const currentMsgs = currentTab.messages || [];
  const isFirstMessage = currentMsgs.length === 0;
  const outgoing = await buildOutgoingUserMessage(text);
  if (!outgoing) return;
  const userText = outgoing.content;
  if (state.pendingTextAttachment) {
    state.pendingTextAttachment.runtimeStatus = 'sending';
    updatePendingTextAttachmentUI();
  }

  // HTML 模式分支：走自动续写通道，忽略角色扮演/群聊/附件等上下文
  try {
    const { isHtmlModeEnabled, sendHtmlGenerationMessage } = await import('./htmlmode.js');
    if (isHtmlModeEnabled()) {
      input.value = "";
      autoHeight();
      updateInputCounter();
      hideReplyBar();
      try {
        await sendHtmlGenerationMessage({ tabId: sendingTabId, userText });
      } finally {
        clearPendingTextAttachment();
      }
      if (isFirstMessage && state.tabData.active === sendingTabId) {
        const tab = state.tabData.list[sendingTabId];
        if (tab && tab.type !== 'single-character') {
          generateTitleForCurrentTab();
        }
      }
      return;
    }
  } catch (err) {
    console.error('HTML 模式分支异常:', err);
  }

  // 群聊分支
  if (currentTab.type === 'group' && currentTab.characterIds && currentTab.characterIds.length > 0) {
    const userMsg = { id: generateMessageId(), role: "user", content: userText };
    if (outgoing.userQuestion) userMsg.userQuestion = outgoing.userQuestion;
    if (outgoing.fileAttachment) userMsg.fileAttachment = outgoing.fileAttachment;
    if (state.replyTarget) {
      userMsg.replyTo = { characterId: state.replyTarget.characterId, characterName: state.replyTarget.characterName, snippet: state.replyTarget.snippet };
    }
    currentMsgs.push(userMsg);
    state.tabData.list[sendingTabId].messages = currentMsgs;
    saveTabs();
    coreCall('markStoryArchiveStale', sendingTabId);
    renderChat();
    // 发送消息后立即滚到底部（用 instant 确保 isAtBottom 判断准确）
    const chatEl = document.getElementById("chat");
    if (chatEl) chatEl.scrollTop = chatEl.scrollHeight;

    input.value = "";
    autoHeight();
    updateInputCounter();
    const replyInfo = state.replyTarget ? { ...state.replyTarget } : null;
    hideReplyBar();

    // 动态导入 groupchat.js 中的 sendGroupMessage，避免循环依赖
    const { sendGroupMessage } = await import('./groupchat.js');
    try {
      await sendGroupMessage(sendingTabId, userText, replyInfo);
    } finally {
      clearPendingTextAttachment();
    }

    if (isFirstMessage && state.tabData.active === sendingTabId) {
      generateTitleForCurrentTab();
    }
    return;
  }

  // 单聊分支
  currentMsgs.push({ id: generateMessageId(), role: "user", content: userText });
  if (outgoing.userQuestion) currentMsgs[currentMsgs.length - 1].userQuestion = outgoing.userQuestion;
  if (outgoing.fileAttachment) currentMsgs[currentMsgs.length - 1].fileAttachment = outgoing.fileAttachment;
  currentMsgs[currentMsgs.length - 1].inputMeta = buildUserInputMeta(currentMsgs, currentMsgs.length - 1, sendingTabId);
  state.tabData.list[sendingTabId].messages = currentMsgs;
  saveTabs();
  coreCall('markStoryArchiveStale', sendingTabId);
  renderChat();
  // 发送消息后立即滚到底部（用 instant 确保 isAtBottom 判断准确）
  const chatEl2 = document.getElementById("chat");
  if (chatEl2) chatEl2.scrollTop = chatEl2.scrollHeight;

  input.value = "";
  autoHeight();
  updateInputCounter();
  try {
    // S-1 修复：显式把 sendingTabId 传给 fetchAndStreamResponse，保证"push 用户消息的 tab"
    // 与"流式 AI 回复所绑定的 tab"必然一致。避免 await buildOutgoingUserMessage 里 txt 摘要
    // 耗时期间用户切 tab 导致的消息错位。
    await fetchAndStreamResponse({ tabId: sendingTabId });
  } finally {
    clearPendingTextAttachment();
  }

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
  const { model: selectedModel, reasoningEffort, thinkingType } = getEffectiveModel();
  const allowReasoning = thinkingType === 'enabled';

  // S-1 修复：优先使用调用方显式传入的 tabId。sendMessage 在 await buildOutgoingUserMessage 里
  // 可能等待 txt 摘要（一次真实 LLM 调用，耗时可观），期间用户可能切 tab；若此处继续用
  // state.tabData.active 会导致"用户消息被 push 到 A tab、AI 回复被 push 到 B tab"的错位。
  // 当调用方未传 tabId 时（如 regenerate），回退到 active tab 以保持对旧调用点的兼容。
  const lockedTabId = opts.tabId || state.tabData.active;

  // 防御：传入的 tabId 在等待期间被删除了
  if (!state.tabData.list[lockedTabId]) return;

  // 按 tab 隔离的发送状态：在发起时绑定到 lockedTabId，避免切换 tab 后相互干扰
  const tabEntry = setTabSending(lockedTabId, {
    isSending: true,
    abortReason: null,
    abortController: new AbortController()
  });
  updateComposerPrimaryButtonState();

  const chunkGuard = createChunkInactivityGuard({
    timeoutMs: CHUNK_INACTIVITY_TIMEOUT_MS,
    signal: tabEntry.abortController.signal,
    onTimeout() {
      tabEntry.abortReason = 'timeout';
    }
  });

  trackEvent('发送消息');

  const currentMsgs = state.tabData.list[lockedTabId].messages || [];
  const isRegen = opts.regenerateIndex !== undefined;
  const targetIndex = isRegen ? opts.regenerateIndex : currentMsgs.length;

  const payloadMsgs = buildPayloadMessages(currentMsgs, isRegen ? targetIndex : currentMsgs.length, lockedTabId);

  // S-1 附带修复：在非 active 发起时，#chat 展示的是其他 tab 的内容。如果仍然往 #chat 插入
  // 新的 aiMsgDiv，会污染当前显示 tab 的 DOM（用户会看到一个凭空出现的 AI 气泡）。
  // 因此：只有 lockedTabId === active 时才做 DOM 插入；否则跳过所有 live render，数据流继续累积，
  // 最后由 finalizeMessage 走 invalidateTabCache 分支，等用户切回 lockedTabId 时 renderChat 重绘。
  const startedOnActiveTab = state.tabData.active === lockedTabId;

  const isAtBottom = startedOnActiveTab
    ? (chat.scrollTop + chat.clientHeight >= chat.scrollHeight - 20)
    : false;
  let aiMsgDiv = null;

  if (isRegen) {
    // regenerate 路径仅在 active tab 上触发（入口检查 currentMsgs 用 active），保持原行为
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

    if (aiMsgDiv) {
      const contentDiv = aiMsgDiv.querySelector('.msg-content');
      if (contentDiv) contentDiv.textContent = "";
      const reasoningDetails = aiMsgDiv.querySelector('.reasoning-details');
      if (reasoningDetails) reasoningDetails.remove();
      const metaEl = aiMsgDiv.querySelector('.assistant-meta');
      if (metaEl) metaEl.remove();
      const statusEl = aiMsgDiv.querySelector('.generation-status');
      if (statusEl) statusEl.remove();
    }
  } else if (startedOnActiveTab) {
    aiMsgDiv = document.createElement("div");
    aiMsgDiv.id = `msg-${targetIndex}`;
    aiMsgDiv.className = "message-box p-3 rounded-xl bg-gray-800 mr-auto max-w-[85%] text-white";
    aiMsgDiv.dataset.messageId = `pending-${lockedTabId}-${targetIndex}`;

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

  if (startedOnActiveTab && isAtBottom) chat.scrollTo({ top: chat.scrollHeight, behavior: 'instant' });

  let fullContent = "";
  let fullReasoningContent = "";
  let hasReasoning = false;
  let reasoningContentDiv = null;
  let finalizeState = "complete";
  let shouldCheckSummary = false;
  // CR2-B/C + S-1: 一旦检测到当前 tab 不是发起时的 tab（用户切走），或 aiMsgDiv 不存在 / 已游离，
  // 即永久关闭 live render。S-1 下还有另一种情况：发起时就已经不在 active tab（aiMsgDiv 为 null），
  // 此时从起点就进入 broken 状态。所有实时渲染停止，fullContent/fullReasoningContent 继续累积，
  // 最终由 finalize 的 renderChat（或 invalidateTabCache 在切回时触发的重渲染）整体展示完整结果。
  let liveRenderBroken = !startedOnActiveTab || !aiMsgDiv;

  // HOTFIX: _finalizeCalled 必须在 try 之前声明（let 不会被 hoist，之前放在 finally 之后会触发
  // TDZ: "Cannot access '_finalizeCalled' before initialization"，因为 try 里的 [DONE] 分支
  // 第一时间就会调用 finalizeMessage 进而读取此变量）。
  let _finalizeCalled = false;

  function markInterrupted() {
    finalizeState = "interrupted";
  }

  function isBackgroundRelatedError(err) {
    if (tabEntry.abortReason === "background") return true;
    if (Date.now() - state.lastPageHiddenAt > 6000) return false;
    const msg = String(err && err.message ? err.message : "");
    if (!msg) return true;
    return /(load failed|failed to fetch|networkerror|cancelled|canceled)/i.test(msg);
  }

  try {
    // 角色单聊时读取角色的活跃度（温度）
    const _tab = state.tabData.list[lockedTabId];
    let chatTemperature = 0.7;
    if (_tab?.type === 'single-character' && _tab.characterId) {
      const _char = coreCall('getCharacterById', _tab.characterId);
      if (_char) chatTemperature = _char.talkativeness ?? 0.8;
    }

    const requestBody = {
      model: selectedModel,
      messages: payloadMsgs,
      stream: true,
      temperature: chatTemperature,
      max_tokens: 8192,
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      ...(thinkingType ? { thinking: { type: thinkingType } } : {}),
    };

    const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${state.apiKey}`,
        "Cache-Control": "no-cache",
        "Pragma": "no-cache"
      },
      body: JSON.stringify(requestBody),
      signal: chunkGuard.signal
    });
    chunkGuard.touch();

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(`API请求失败：${errorData.error?.message || '请检查API Key是否有效'}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunkGuard.touch();

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

          // CR-1 + CR2-B/C + CR3-E + N-2: 只要当前不是发起时的 tab，或 aiMsgDiv 为 null / 已从 DOM 中
          // detach（例如搜索触发 renderChat 重建 #chat、或其他异步路径清空 #chat），就永久关闭 live render。
          // N-2 补丁：isRegen 路径下 document.getElementById 可能返回 null（元素被 renderChat 替换掉），
          // 这里必须先做 null 检查，否则 !aiMsgDiv.isConnected 会抛 TypeError。
          // 粘性标志位确保一次破裂不可逆。
          if (state.tabData.active !== lockedTabId || !aiMsgDiv || !aiMsgDiv.isConnected) liveRenderBroken = true;
          const canLiveRender = !liveRenderBroken;

          if (allowReasoning && delta.reasoning_content) {
            if (!hasReasoning) {
              // hasReasoning 只在能实时渲染时才置 true，避免"首 chunk 在非 active、后续回到 active"时
              // 因 hasReasoning 已 true 而永远不创建 details 节点（CR2-C）
              if (canLiveRender) {
                hasReasoning = true;
                const details = document.createElement('details');
                details.className = "reasoning-details mb-2 border border-gray-700 rounded-lg p-2 bg-gray-900";
                details.open = true;
                details.innerHTML = `<summary class="text-xs text-gray-400 cursor-pointer select-none outline-none">思考过程</summary><div class="reasoning-content prose prose-invert max-w-none text-sm text-gray-400 mt-2 border-t border-gray-700 pt-2"></div>`;
                const msgContentDiv = aiMsgDiv.querySelector('.msg-content');
                aiMsgDiv.insertBefore(details, msgContentDiv);
                reasoningContentDiv = details.querySelector('.reasoning-content');
              }
            }
            fullReasoningContent += delta.reasoning_content;
            if (canLiveRender && reasoningContentDiv) {
              renderMarkdown(reasoningContentDiv, fullReasoningContent);
            }
          }

          if (delta.content) {
            fullContent += delta.content;
            if (canLiveRender) {
              const contentDiv = aiMsgDiv.querySelector('.msg-content');
              if (contentDiv) {
                renderMarkdown(contentDiv, fullContent);
              }
            }
          }
        } catch (e) {
          continue;
        }

        // 每处理完一个 chunk 后检查是否需要自动滚动（仅当 live render 仍有效时）
        if (!liveRenderBroken) {
          const currentIsAtBottom = chat.scrollTop + chat.clientHeight >= chat.scrollHeight - 60;
          if (currentIsAtBottom) chat.scrollTo({ top: chat.scrollHeight, behavior: 'instant' });
        }
      }
    }
    finalizeMessage(finalizeState);

  } catch (e) {
    // CR-1 + CR2-B/C + CR3-E: 用 liveRenderBroken 粘性标志判断 DOM 写入是否仍有效
    if (state.tabData.active !== lockedTabId || !aiMsgDiv || !aiMsgDiv.isConnected) liveRenderBroken = true;
    const canLiveRender = !liveRenderBroken;
    if (e.name === 'AbortError') {
      if (tabEntry.abortReason === 'background' || tabEntry.abortReason === 'manual') markInterrupted();
      else if (tabEntry.abortReason === 'timeout') {
        finalizeState = 'timeout';
        fullContent = '❌ 请求超时，请检查网络后重试';
        fullReasoningContent = '';
        if (canLiveRender) {
          const contentDiv = aiMsgDiv.querySelector('.msg-content');
          if (contentDiv) {
            contentDiv.innerHTML = '<span class="text-red-400">❌ 请求超时，请检查网络后重试</span>';
          }
        }
      }
      finalizeMessage(finalizeState);
    } else if (isBackgroundRelatedError(e)) {
      markInterrupted();
      finalizeMessage(finalizeState);
    } else {
      if (canLiveRender) {
        const contentDiv = aiMsgDiv.querySelector('.msg-content');
        if (contentDiv) {
          contentDiv.innerHTML = `<span class="text-red-400">❌ 错误：${e.message}</span>`;
        }
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
    chunkGuard.cleanup();
    // 按 lockedTabId 清理发送状态（此刻 active tab 可能已切走，绝不能用 state.isSending = false）
    clearTabSending(lockedTabId);
    updateComposerPrimaryButtonState();

    // 异步检查是否需要生成/更新摘要（不阻塞对话）
    if (shouldCheckSummary) {
      checkAndGenerateSummary(lockedTabId).catch(() => {});
    }
  }

  function finalizeMessage(fState = "complete") {
    // 幂等：避免 [DONE] + reader.done 双路径下重复 push
    if (_finalizeCalled) return;
    _finalizeCalled = true;
    shouldCheckSummary = fState === "complete";

    // 防御：发起时的 tab 可能已被用户删除
    const lockedTab = state.tabData.list[lockedTabId];
    if (!lockedTab) return;
    if (lockedTab.type === 'single-character') {
      fullContent = formatRoleplayReply(fullContent);
    }

    if (isRegen) {
      currentMsgs[targetIndex].generationState = fState;
      currentMsgs[targetIndex].content = fullContent;
      currentMsgs[targetIndex].reasoningContent = fullReasoningContent;
      currentMsgs[targetIndex].history[currentMsgs[targetIndex].historyIndex] = { content: fullContent, reasoningContent: fullReasoningContent, state: fState };
    } else {
      currentMsgs.push({
        id: generateMessageId(),
        role: "assistant",
        content: fullContent,
        reasoningContent: fullReasoningContent,
        generationState: fState,
        history: [{ content: fullContent, reasoningContent: fullReasoningContent, state: fState }],
        historyIndex: 0
      });
    }
    lockedTab.messages = currentMsgs;
    saveTabs();
    coreCall('markStoryArchiveStale', lockedTabId);
    // 仅当结果仍属于当前 active tab 时才刷 DOM，避免切走后污染其他 tab 的渲染
    if (state.tabData.active === lockedTabId) {
      renderChat();
    } else {
      // 失效目标 tab 的 DOM 缓存，下次切回去时重渲染
      coreCall('invalidateTabCache', lockedTabId);
    }
  }
}

// ========== 编辑和重新生成 ==========

export async function saveEditAndRegenerate() {
  const editPanel = document.getElementById("editPanel");
  const editTextarea = document.getElementById("editTextarea");

  const newContent = editTextarea.value.trim();
  if (!newContent) return alert("消息内容不能为空！");
  // S-1 一致性：进入编辑流程时锁定目标 tabId，中途所有 await 都用它，避免用户切 tab 后错位
  const editingTabId = state.tabData.active;
  const currentTab = state.tabData.list[editingTabId];
  const currentMsgs = currentTab.messages || [];
  if (state.editingMessageIndex < 0 || state.editingMessageIndex >= currentMsgs.length) return alert("编辑的消息不存在。");

  const editIdx = state.editingMessageIndex;
  const removedMessageIds = currentMsgs.slice(editIdx).map(msg => msg?.id).filter(Boolean);
  const messagesToKeep = currentMsgs.slice(0, editIdx + 1);
  messagesToKeep[editIdx].content = newContent;
  delete messagesToKeep[editIdx].fileAttachment;
  delete messagesToKeep[editIdx].userQuestion;
  removeFavoritesForMessageIds(editingTabId, removedMessageIds, { silent: true });
  currentTab.messages = messagesToKeep;
  // 编辑消息后，如果编辑位置在摘要覆盖范围内，清除摘要
  if (currentTab.summaryCoversUpTo > 0 && editIdx < currentTab.summaryCoversUpTo) {
    clearSummary(editingTabId);
  }
  normalizeTabSummaryState(currentTab);
  saveTabs();
  coreCall('markStoryArchiveStale', editingTabId);

  editPanel.classList.add("hidden");
  state.editingMessageIndex = -1;
  renderChat();

  // 群聊走群聊发送逻辑
  if (currentTab.type === 'group') {
    const { sendGroupMessage } = await import('./groupchat.js');
    await sendGroupMessage(editingTabId, newContent);
  } else {
    if (messagesToKeep[editIdx]?.role === 'user') {
      messagesToKeep[editIdx].inputMeta = buildUserInputMeta(messagesToKeep, editIdx, editingTabId);
      saveTabs();
      coreCall('markStoryArchiveStale', editingTabId);
    }
    
    // 如果编辑的是一个 HTML 模式生成的 user 消息，重定向到 HTML 分支
    if (messagesToKeep[editIdx]?.htmlModeRequest) {
      try {
        const { sendHtmlGenerationMessage } = await import('./htmlmode.js');
        // 由于是编辑 user 消息，重生成的是后面紧跟着的 assistant 消息，这与普通的 sendMessage 不同。
        // 不过由于前面的代码直接把 user 消息之后的全部切掉了（messagesToKeep 只有前面一半），
        // 等价于发了一条新消息，所以我们直接当新消息发送即可。
        await sendHtmlGenerationMessage({ tabId: editingTabId, userText: newContent, fromEdit: true });
        return;
      } catch (err) {
        console.error('重载 HTML 模式生成异常:', err);
      }
    }
    
    await fetchAndStreamResponse({ tabId: editingTabId });
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
  // S-1 一致性：锁定发起 regenerate 时的 tabId
  const regenTabId = state.tabData.active;
  const currentMsgs = state.tabData.list[regenTabId].messages || [];
  if (currentMsgs.length === 0) return alert("当前对话为空，无法重新生成。");
  if (messageIndex < 0 || messageIndex >= currentMsgs.length) return alert("消息索引无效。");
  const targetMessage = currentMsgs[messageIndex];
  if (targetMessage.role !== 'assistant') return alert("只能重新生成AI的回复。");
  if (targetMessage.id) removeFavoritesForMessageIds(regenTabId, [targetMessage.id], { silent: true });

  // 识别 HTML 模式消息并重定向到专门通道
  if (targetMessage.htmlGeneration) {
    import('./htmlmode.js').then(({ sendHtmlGenerationMessage }) => {
      sendHtmlGenerationMessage({ tabId: regenTabId, regenerateIndex: messageIndex });
    }).catch(err => {
      console.error('重载 HTML 模式生成异常:', err);
      fetchAndStreamResponse({ tabId: regenTabId, regenerateIndex: messageIndex });
    });
    return;
  }

  fetchAndStreamResponse({ tabId: regenTabId, regenerateIndex: messageIndex });
}

// ========== 输入框相关 ==========

export function autoHeight() {
  const input = document.getElementById("input");
  input.style.height = "44px";
  const scrollH = input.scrollHeight;
  input.style.height = Math.min(Math.max(scrollH, 44), 88) + "px";
  updateComposerLayoutMetrics();
}

export function updateInputCounter() {
  const input = document.getElementById("input");
  const inputCounter = document.getElementById("inputCounter");
  const text = input.value;
  const charCount = text.length;
  const tokenEstimate = estimateTokensByChars(charCount);
  const pending = state.pendingTextAttachment;
  if (pending) {
    const modeText = pending.mode === 'summary' ? '摘要发送' : pending.mode === 'over_limit' ? '超限' : '全文发送';
    if (charCount > 0) {
      inputCounter.textContent = `问题 ${charCount} 字 / 约 ${tokenEstimate} tokens + TXT ${pending.originalCharCount} 字（${modeText}）`;
    } else {
      inputCounter.textContent = `TXT ${pending.originalCharCount} 字（${modeText}，请输入问题）`;
    }
  } else if (charCount > 0) {
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
  const titleSource = firstUserMsg.userQuestion || firstUserMsg.content;

  try {
    const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${state.apiKey}`
      },
      body: JSON.stringify({
        model: state.selectedModel,
        messages: [
          { role: "user", content: `请为以下对话生成一个简洁、描述性的标题（不超过 15 个字）。只返回标题，不要其他内容。\n\n用户消息：${titleSource}` }
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
  const composerActionMenu = document.getElementById("composerActionMenu");
  const openTxtUploadBtn = document.getElementById("openTxtUploadBtn");
  const openBgInfoBtn = document.getElementById("openBgInfoBtn");
  const txtUploadInput = document.getElementById("txtUploadInput");
  const removeTxtAttachmentBtn = document.getElementById("removeTxtAttachmentBtn");
  const editCancelBtn = document.getElementById("editCancelBtn");
  const editSaveBtn = document.getElementById("editSaveBtn");
  const editPanel = document.getElementById("editPanel");
  const scrollToBottomBtn = document.getElementById("scrollToBottomBtn");
  const chat = document.getElementById("chat");

  if (sendBtn) {
    sendBtn.addEventListener("click", () => {
      // CR-2: 显式按 active tab 写 abortReason 并 abort，避免通过访问器在极端 tab 切换时机下错写到别的 tab
      const activeTabId = state.tabData.active;
      if (state.isSending || state.isPreparingTextAttachment) {
        abortTabSending(activeTabId, 'manual');
      } else if (!input.value.trim()) {
        toggleComposerActionMenu();
      } else {
        sendMessage();
      }
    });
  }

  if (input) {
    input.addEventListener("input", () => {
      autoHeight();
      updateInputCounter();
      updateComposerPrimaryButtonState();
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

  if (openTxtUploadBtn && txtUploadInput) {
    openTxtUploadBtn.addEventListener("click", () => {
      if (state.isPreparingTextAttachment) return;
      closeComposerActionMenu();
      txtUploadInput.click();
    });
  }
  if (openBgInfoBtn) {
    openBgInfoBtn.addEventListener('click', () => {
      closeComposerActionMenu();
    });
  }
  if (txtUploadInput) {
    txtUploadInput.addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      await handleTxtFileSelected(file);
    });
  }
  if (removeTxtAttachmentBtn) {
    removeTxtAttachmentBtn.addEventListener("click", () => {
      if (state.isPreparingTextAttachment) return;
      clearPendingTextAttachment();
    });
  }
  document.addEventListener('click', (e) => {
    if (!composerActionMenu || !sendBtn) return;
    if (composerActionMenu.classList.contains('hidden')) return;
    const target = e.target;
    if (composerActionMenu.contains(target) || sendBtn.contains(target)) return;
    closeComposerActionMenu();
  });

  if (editCancelBtn) editCancelBtn.addEventListener("click", cancelEdit);
  if (editSaveBtn) editSaveBtn.addEventListener("click", saveEditAndRegenerate);
  if (editPanel) editPanel.addEventListener("click", function(e) { if (e.target === editPanel) cancelEdit(); });

  if (scrollToBottomBtn) scrollToBottomBtn.addEventListener("click", scrollToBottom);
  if (chat) chat.addEventListener("scroll", checkScrollButton);

  if (typeof ResizeObserver !== 'undefined' && !_composerResizeObserver) {
    _composerResizeObserver = new ResizeObserver(() => {
      updateComposerLayoutMetrics();
    });
    const inputContainer = document.querySelector('.input-container');
    const inputShell = document.querySelector('.input-shell');
    if (inputContainer) _composerResizeObserver.observe(inputContainer);
    if (inputShell) _composerResizeObserver.observe(inputShell);
  }

  window.addEventListener('resize', updateComposerLayoutMetrics);

  // 初始化输入框
  autoHeight();
  updatePendingTextAttachmentUI();
  updateInputCounter();
  updateComposerPrimaryButtonState();
  updateComposerLayoutMetrics();
}
