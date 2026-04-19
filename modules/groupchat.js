/**
 * groupchat.js — 群聊模块
 *
 * 负责群聊的路由判断、角色回复生成、追问判断、编排主函数、
 * 群聊消息发送、以及群聊创建面板的管理。
 */

import { state } from './state.js';
import { escapeHtml, limitSentences, deleteIconSvg, copyIconSvg } from './utils.js';
import { callLLM, callLLMJSON, CHUNK_INACTIVITY_TIMEOUT_MS } from './llm.js';
import { saveTabs, generateNewTabId } from './storage.js';
import { showToast, closeSidebar, hideReplyBar } from './panels.js';
import { renderMarkdown } from './markdown.js';
import { call as coreCall } from './core.js';

// ========== Step 1: 路由判断 ==========

async function routeMessage(userMessage, characters, history, signal = null, replyInfo = null, llmTimeoutOptions = {}) {
  if (replyInfo && replyInfo.characterId) {
    const targetIdx = characters.findIndex(c => c.id === replyInfo.characterId);
    if (targetIdx >= 0) {
      const otherIndices = await routeMessageByLLM(userMessage, characters, history, signal, replyInfo, llmTimeoutOptions);
      const combined = [targetIdx, ...otherIndices.filter(i => i !== targetIdx)];
      return combined;
    }
  }
  return await routeMessageByLLM(userMessage, characters, history, signal, null, llmTimeoutOptions);
}

async function routeMessageByLLM(userMessage, characters, history, signal, replyInfo, llmTimeoutOptions = {}) {
  const charSummaries = characters.map((c, i) => `${i + 1}. ${c.name}：${c.summary || c.personality || '无描述'}`).join('\n');

  let extraRule = '';
  if (replyInfo) {
    extraRule = `\n8. 用户正在回复${replyInfo.characterName}，${replyInfo.characterName}已经在回答中，不需要再选它`;
  }

  const messages = [
    {
      role: "system",
      content: `你是一个群聊路由器。根据用户消息和群聊中的角色，判断哪些角色应该回答。
规则：
1. 仔细分析用户消息的语境和场景设定
2. 如果用户消息暗示了只有某些角色在场（如"只有我和XX"、"私下对话"、"回到房间"等），只选在场角色回答
3. 如果用户消息明确排除了某个角色（如"XX不在"、"没有XX"、"XX还没来"、"XX在外面"等），该角色绝对不能回答
4. 如果消息只和某个角色相关，只选那个
5. 如果消息是泛泛的（如打招呼），可以选所有角色
6. 至少选一个角色回答
7. 场景设定优先：如果用户说某个角色"不在"、"还没来"、"在外面"，即使话题与该角色相关，也不要选该角色${extraRule}
只输出 JSON 数组，包含角色编号，例如 [1] 或 [1,2]，不要输出其他内容。`
    },
    {
      role: "user",
      content: `群聊角色：\n${charSummaries}\n\n用户说：${userMessage}`
    }
  ];

  const result = await callLLMJSON({ messages, temperature: 0.3, maxTokens: 50, signal, ...llmTimeoutOptions });
  if (!result || !Array.isArray(result)) return [0];

  const indices = result.map(n => parseInt(n) - 1).filter(n => n >= 0 && n < characters.length);
  return indices.length > 0 ? indices : [0];
}

// ========== Step 2: 角色回答生成 ==========

export async function generateCharacterReply(character, userMessage, history, allCharacters, options = {}) {
  const otherChars = allCharacters.filter(c => c.id !== character.id);
  const otherCharsInfo = otherChars.length > 0
    ? '\n群聊中还有其他角色：' + otherChars.map(c => c.name).join('、')
    : '';

  // 群聊背景信息注入
  const groupContext = options.groupContext || {};
  const userRoleInfo = groupContext.userRoleName
    ? `\n用户在群聊中的角色是「${groupContext.userRoleName}」，请以此称呼用户。`
    : '';
  const storyBgInfo = groupContext.storyBackground
    ? `\n当前故事背景：${groupContext.storyBackground}\n请在回复中自然地融入当前的场景和背景设定。`
    : '';
  const summaryInfo = groupContext.summary
    ? `\n\n【对话记忆摘要】\n${groupContext.summary}`
    : '';

  const recentHistory = history.slice(-20).map(m => {
    if (m.role === 'user') return `用户：${m.content}`;
    if (m.role === 'character') return `${m.characterName || '角色'}：${m.content}`;
    if (m.role === 'assistant') return `AI：${m.content}`;
    return '';
  }).filter(Boolean).join('\n');

  const roundReplies = options.currentRoundReplies || [];
  const llmTimeoutOptions = options.llmTimeoutOptions || {};
  const roundContext = roundReplies.length > 0
    ? '\n本轮对话：\n' + roundReplies.map(r => `${r.characterName}：${r.content}`).join('\n')
    : '';

  const messages = [
    {
      role: "system",
      content: `你是${character.name}。
性格：${character.personality || '无特殊设定'}
背景：${character.background || '无'}
外貌：${character.appearance || '无'}
说话风格：${character.speakingStyle || '自然'}
口头禅参考（仅供参考语气，不要刻意堆砌）：${(character.catchphrases || []).join('、') || '无'}${otherCharsInfo}${userRoleInfo}${storyBgInfo}${summaryInfo}

规则：
1. 严格以${character.name}的身份和性格回复
2. 保持角色一致性，不要出戏
3. 回复自然口语化，像真人聊天，不要像背台词
4. 最多说5句话
5. 不要加引号、括号等格式标记
6. 不要重复其他角色已经说过的话，要给出新的回应
7. 口头禅偶尔使用即可，不要每句话都带，更不要生硬插入
8. 注意场景设定：如果用户描述了某些角色不在场，你不在场时不要发言`
    },
    {
      role: "user",
      content: (recentHistory ? `最近对话：\n${recentHistory}\n\n` : '') +
               (roundContext ? `${roundContext}\n\n` : '') +
               `用户说：${userMessage}`
    }
  ];

  if (options.stream && options.onChunk) {
    return await callLLM({
      model: options.model || 'deepseek-chat',
      messages,
      stream: true,
      temperature: 0.8,
      maxTokens: 1024,
      signal: options.signal,
      onChunk: options.onChunk,
      ...llmTimeoutOptions
    });
  }

  const reply = await callLLM({
    model: options.model || 'deepseek-chat',
    messages,
    stream: false,
    temperature: 0.8,
    maxTokens: 1024,
    signal: options.signal,
    ...llmTimeoutOptions
  });

  if (typeof reply === 'string') return limitSentences(reply);
  return reply;
}

// ========== Step 3: 追问判断 ==========

export async function shouldFollowUp(lastReplies, otherCharacter, userMessage, speakCount = 0, signal = null, llmTimeoutOptions = {}) {
  const lastReplyText = lastReplies.map(r => `${r.characterName}：${r.content}`).join('\n');

  const messages = [
    {
      role: "system",
      content: `你判断群聊中一个角色是否需要对其他角色的发言做出回应。
只回答"是"或"否"，不要输出其他内容。
判断标准：
- 默认回答"否"，只有在非常必要时才回应
- 如果用户消息暗示了某些角色不在场（如"只有我和XX"、"私下对话"、"回到房间"等），不在场的角色必须回答"否"
- 如果对方的话直接点名你、质疑你、或者与你产生强烈冲突，可以回答"是"
- 如果对方的话只是普通聊天、你已经表达过类似观点、或者话题与你关系不大，回答"否"
- 如果场景是私密的或你不在场，即使话题与你相关也回答"否"
- 不要为了聊天而聊天，避免无意义的附和`
    },
    {
      role: "user",
      content: `你是${otherCharacter.name}（${otherCharacter.summary || otherCharacter.personality || ''}）。
你本轮已经说过${speakCount}次话了。
其他角色刚说了：\n${lastReplyText}\n
用户说：${userMessage}\n
你需要回应吗？`
    }
  ];

  const result = await callLLM({ messages, temperature: 0.3, maxTokens: 10, signal, ...llmTimeoutOptions });
  return String(result).trim().includes('是');
}

// ========== 编排主函数（流式） ==========

export async function orchestrateGroupChat(userMessage, characters, history, options = {}) {
  const { onCharacterStart, onCharacterChunk, onCharacterEnd, signal, model, replyInfo, groupContext } = options;
  const allReplies = [];
  const MAX_ROUNDS = 3;
  const llmTimeoutOptions = options.llmTimeoutOptions || {};

  // 构建角色回复的公共 options
  const charOptions = { signal, model, groupContext, llmTimeoutOptions };

  // Step 1: 路由判断
  let speakerIndices;
  try {
    speakerIndices = await routeMessage(userMessage, characters, history, signal, replyInfo, llmTimeoutOptions);
  } catch (e) {
    if (e.name === 'AbortError') return allReplies;
    throw e;
  }

  // Step 2: 逐个角色生成回答
  for (const idx of speakerIndices) {
    if (signal && signal.aborted) break;
    const character = characters[idx];

    if (onCharacterStart) onCharacterStart(character, idx);

    let reply;
    try {
      reply = await generateCharacterReply(character, userMessage, history, characters, {
        ...charOptions,
        stream: !!onCharacterChunk,
        onChunk: onCharacterChunk ? (chunk) => onCharacterChunk(character, idx, chunk) : null,
        currentRoundReplies: allReplies
      });
    } catch (e) {
      if (e.name === 'AbortError') break;
      throw e;
    }

    const content = typeof reply === 'string' ? reply : reply.content;
    allReplies.push({ characterId: character.id, characterName: character.name, content: limitSentences(content || '') });

    if (onCharacterEnd) onCharacterEnd(character, idx, content);
  }

  // Step 3: 多轮互动循环
  if (allReplies.length > 0 && characters.length > 1) {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (signal && signal.aborted) break;

      const lastReply = allReplies[allReplies.length - 1];
      const lastSpeakerId = lastReply.characterId;
      const otherChars = characters.filter(c => c.id !== lastSpeakerId);

      let anyoneSpoke = false;

      for (const otherChar of otherChars) {
        if (signal && signal.aborted) break;

        const speakCount = allReplies.filter(r => r.characterId === otherChar.id).length;
        if (speakCount >= 2) continue;

        let needFollow;
        try {
          needFollow = await shouldFollowUp([lastReply], otherChar, userMessage, speakCount, signal, llmTimeoutOptions);
        } catch (e) {
          if (e.name === 'AbortError') break;
          throw e;
        }
        if (needFollow) {
          if (onCharacterStart) onCharacterStart(otherChar, characters.indexOf(otherChar));

          let reply;
          try {
            reply = await generateCharacterReply(otherChar, userMessage, history, characters, {
              ...charOptions,
              stream: !!onCharacterChunk,
              onChunk: onCharacterChunk ? (chunk) => onCharacterChunk(otherChar, characters.indexOf(otherChar), chunk) : null,
              currentRoundReplies: allReplies
            });
          } catch (e) {
            if (e.name === 'AbortError') break;
            throw e;
          }

          const content = typeof reply === 'string' ? reply : reply.content;
          allReplies.push({ characterId: otherChar.id, characterName: otherChar.name, content: limitSentences(content || '') });

          if (onCharacterEnd) onCharacterEnd(otherChar, characters.indexOf(otherChar), content);
          anyoneSpoke = true;
          break;
        }
      }

      if (!anyoneSpoke) break;
    }
  }

  return allReplies;
}

// ========== 群聊消息发送（由 chat 模块调用） ==========

export async function sendGroupMessage(tabId, userMessage, replyInfo) {
  const chat = document.getElementById("chat");
  const modelSelect = document.getElementById("modelSelect");

  state.isSending = true;
  coreCall('updateComposerPrimaryButtonState');

  const lockedTabId = tabId;
  state.abortReason = null;
  state.abortController = new AbortController();
  const signal = state.abortController.signal;
  const llmTimeoutOptions = {
    chunkTimeoutMs: CHUNK_INACTIVITY_TIMEOUT_MS,
    onTimeout() {
      state.abortReason = 'timeout';
    }
  };

  const currentTab = state.tabData.list[lockedTabId];
  const characters = (currentTab.characterIds || []).map(id => coreCall('getCharacterById', id)).filter(Boolean);
  if (characters.length === 0) {
    state.isSending = false;
    coreCall('updateComposerPrimaryButtonState');
    return;
  }

  // 获取群聊背景信息 + 摘要
  const groupContext = {
    userRoleName: currentTab.userRoleName || '',
    storyBackground: currentTab.storyBackground || '',
    summary: currentTab.summary || ''
  };

  const currentMsgs = currentTab.messages || [];
  const history = currentMsgs;

  try {
    const replies = await orchestrateGroupChat(userMessage, characters, history, {
      signal,
      replyInfo,
      model: modelSelect.value === 'deepseek-reasoner' ? 'deepseek-reasoner' : 'deepseek-chat',
      groupContext,
      llmTimeoutOptions,
      onCharacterStart(character, idx) {
        const msgIndex = currentMsgs.length;
        const color = coreCall('getCharacterColor', idx);
        const msgBox = document.createElement("div");
        msgBox.id = `msg-${msgIndex}`;
        msgBox.className = `message-box character-msg p-3 rounded-xl bg-gray-800 mr-auto max-w-[85%] text-white`;
        msgBox.style.setProperty('border-left-color', color, 'important');
        msgBox.innerHTML = `
          <div class="character-msg-label" style="background:${color}20;color:${color}">${escapeHtml(character.name)}</div>
          <button class="delete-btn" data-index="${msgIndex}" title="删除">${deleteIconSvg}</button>
          <button class="copy-btn" data-index="${msgIndex}" title="复制">${copyIconSvg}</button>
          <div class="msg-content prose prose-invert max-w-none"></div>
        `;
        chat.appendChild(msgBox);
        if (chat.scrollTop + chat.clientHeight >= chat.scrollHeight - 60) {
          chat.scrollTop = chat.scrollHeight;
        }
      },
      onCharacterChunk(character, idx, chunk) {
        const msgBoxes = chat.querySelectorAll('.character-msg');
        const targetBox = msgBoxes[msgBoxes.length - 1];
        if (targetBox) {
          const contentDiv = targetBox.querySelector('.msg-content');
          if (contentDiv && chunk.fullContent) {
            renderMarkdown(contentDiv, chunk.fullContent);
            const isAtBottom = chat.scrollTop + chat.clientHeight >= chat.scrollHeight - 20;
            if (isAtBottom) chat.scrollTop = chat.scrollHeight;
          }
        }
      },
      onCharacterEnd(character, idx, content) {
        const msgs = state.tabData.list[lockedTabId].messages;
        msgs.push({
          role: "character",
          characterId: character.id,
          characterName: character.name,
          content: content || '',
          generationState: state.abortReason === 'timeout' ? 'timeout' : (state.abortReason ? 'interrupted' : 'complete'),
          history: [{ content: content || '', reasoningContent: '', state: state.abortReason === 'timeout' ? 'timeout' : (state.abortReason ? 'interrupted' : 'complete') }],
          historyIndex: 0
        });
        state.tabData.list[lockedTabId].messages = msgs;
        saveTabs();
      }
    });
  } catch (e) {
    if (e.name !== 'AbortError') {
      console.error('群聊发送错误:', e);
      showToast('群聊发送失败：' + e.message);
    }
  } finally {
    state.isSending = false;
    coreCall('updateComposerPrimaryButtonState');
    state.abortController = null;
    coreCall('renderChat');

    // 异步检查是否需要生成/更新摘要
    import('./summary.js').then(({ checkAndGenerateSummary }) => {
      checkAndGenerateSummary(tabId).catch(() => {});
    });
  }
}

// ========== 群聊面板管理 ==========

export function openCreateGroupPanel() {
  if (state.characterData.length < 2) {
    showToast('至少需要创建 2 个角色才能创建群聊');
    return;
  }
  const createGroupPanel = document.getElementById('createGroupPanel');
  const createGroupNameInput = document.getElementById('createGroupNameInput');
  createGroupPanel.classList.remove('hidden');
  createGroupNameInput.value = '';
  renderCreateGroupCharacterList();
}

export function closeCreateGroupPanel() {
  const createGroupPanel = document.getElementById('createGroupPanel');
  createGroupPanel.classList.add('hidden');
}

// ========== 背景信息面板（通用） ==========

export function openBgInfoPanel() {
  const panel = document.getElementById('bgInfoPanel');
  const roleInput = document.getElementById('bgInfoRoleInput');
  const bgInput = document.getElementById('bgInfoStoryInput');
  const currentTab = state.tabData.list[state.tabData.active];

  if (!currentTab) return;

  roleInput.value = currentTab.userRoleName || '';
  bgInput.value = currentTab.storyBackground || '';
  panel.classList.remove('hidden');
  setTimeout(() => roleInput.focus(), 30);
}

export function closeBgInfoPanel() {
  const panel = document.getElementById('bgInfoPanel');
  if (panel) panel.classList.add('hidden');
}

export function saveBgInfo() {
  const roleInput = document.getElementById('bgInfoRoleInput');
  const bgInput = document.getElementById('bgInfoStoryInput');
  const currentTab = state.tabData.list[state.tabData.active];

  if (!currentTab) return;

  currentTab.userRoleName = roleInput.value.trim();
  currentTab.storyBackground = bgInput.value.trim();
  saveTabs();
  closeBgInfoPanel();
  updateBgInfoChip();
  showToast('背景信息已保存');
}

export function updateBgInfoChip() {
  // 按钮样式与深度思考一致，无需根据状态切换样式
}

export function renderCreateGroupCharacterList() {
  const createGroupCharacterList = document.getElementById('createGroupCharacterList');
  createGroupCharacterList.innerHTML = '';
  state.selectedGroupCharacterIds.clear();
  state.characterData.forEach(char => {
    const div = document.createElement('div');
    div.className = 'group-char-select-item';
    div.dataset.id = char.id;
    div.innerHTML = `
      <label class="flex items-center gap-3 cursor-pointer p-2 rounded-lg hover:bg-gray-800 transition-colors">
        <input type="checkbox" class="group-char-checkbox w-4 h-4" value="${char.id}">
        <div class="flex-1 min-w-0">
          <div class="text-sm text-white font-medium">${escapeHtml(char.name)}</div>
          <div class="text-xs text-gray-500">${escapeHtml(char.summary || '暂无描述')}</div>
        </div>
      </label>
    `;
    createGroupCharacterList.appendChild(div);
  });

  document.querySelectorAll('.group-char-checkbox').forEach(cb => {
    cb.addEventListener('change', function() {
      if (this.checked) state.selectedGroupCharacterIds.add(this.value);
      else state.selectedGroupCharacterIds.delete(this.value);
    });
  });
}

export function createGroupChat() {
  if (state.selectedGroupCharacterIds.size < 2) {
    showToast('请至少选择 2 个角色');
    return;
  }
  const createGroupNameInput = document.getElementById('createGroupNameInput');
  const groupTitle = createGroupNameInput.value.trim() || '群聊';
  const charIds = Array.from(state.selectedGroupCharacterIds);

  coreCall('clearPendingTextAttachment');
  const newId = generateNewTabId();

  state.tabData.list[newId] = {
    type: 'group',
    characterIds: charIds,
    messages: [],
    title: groupTitle
  };
  state.tabData.active = newId;
  saveTabs();
  coreCall('renderChat');
  coreCall('renderTabs');
  coreCall('updateInputCounter');
  closeCreateGroupPanel();
  closeSidebar();
  showToast('群聊已创建');
}

// ========== 群聊事件绑定 ==========

export function bindGroupChatEvents() {
  const closeCreateGroupBtn = document.getElementById('closeCreateGroupBtn');
  const createGroupPanel = document.getElementById('createGroupPanel');
  const createGroupConfirmBtn = document.getElementById('createGroupConfirmBtn');
  const openCharacterFromGroupBtn = document.getElementById('openCharacterFromGroupBtn');
  const characterSelectPanel = document.getElementById('characterSelectPanel');
  const closeCharacterSelectBtn = document.getElementById('closeCharacterSelectBtn');
  const cancelCreateGroupBtn = document.getElementById('cancelCreateGroupBtn');

  if (closeCreateGroupBtn) closeCreateGroupBtn.addEventListener('click', closeCreateGroupPanel);
  if (createGroupPanel) createGroupPanel.addEventListener('click', (e) => { if (e.target === createGroupPanel) closeCreateGroupPanel(); });
  if (createGroupConfirmBtn) createGroupConfirmBtn.addEventListener('click', createGroupChat);
  if (cancelCreateGroupBtn) cancelCreateGroupBtn.addEventListener('click', closeCreateGroupPanel);

  // 角色选择面板事件
  if (closeCharacterSelectBtn) closeCharacterSelectBtn.addEventListener('click', () => { if (characterSelectPanel) characterSelectPanel.classList.add('hidden'); });
  if (characterSelectPanel) characterSelectPanel.addEventListener('click', (e) => { if (e.target === characterSelectPanel) characterSelectPanel.classList.add('hidden'); });

  // 从群聊面板打开角色卡管理
  if (openCharacterFromGroupBtn) openCharacterFromGroupBtn.addEventListener('click', () => {
    closeCreateGroupPanel();
    coreCall('openCharacterPanel');
  });

  // 背景信息面板事件
  const bgInfoPanel = document.getElementById('bgInfoPanel');
  const closeBgInfoBtn = document.getElementById('closeBgInfoBtn');
  const cancelBgInfoBtn = document.getElementById('cancelBgInfoBtn');
  const saveBgInfoBtn = document.getElementById('saveBgInfoBtn');
  const openBgInfoBtn = document.getElementById('openBgInfoBtn');

  if (closeBgInfoBtn) closeBgInfoBtn.addEventListener('click', closeBgInfoPanel);
  if (cancelBgInfoBtn) cancelBgInfoBtn.addEventListener('click', closeBgInfoPanel);
  if (saveBgInfoBtn) saveBgInfoBtn.addEventListener('click', saveBgInfo);
  if (bgInfoPanel) bgInfoPanel.addEventListener('click', (e) => { if (e.target === bgInfoPanel) closeBgInfoPanel(); });
  if (openBgInfoBtn) openBgInfoBtn.addEventListener('click', openBgInfoPanel);
}
