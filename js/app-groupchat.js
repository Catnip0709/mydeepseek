// app-groupchat.js - 群聊编排引擎
(function() {
  'use strict';
  const App = window.App;

  // 获取 DOM 元素
  const createGroupPanel = document.getElementById('createGroupPanel');
  const closeCreateGroupBtn = document.getElementById('closeCreateGroupBtn');
  const createGroupCharacterList = document.getElementById('createGroupCharacterList');
  const createGroupConfirmBtn = document.getElementById('createGroupConfirmBtn');
  const createGroupNameInput = document.getElementById('createGroupNameInput');
  const openCharacterFromGroupBtn = document.getElementById('openCharacterFromGroupBtn');
  const cancelCreateGroupBtn = document.getElementById('cancelCreateGroupBtn');

  // ========== 编排函数 ==========

  // Step 1: 路由判断 - 哪些角色应该回答
  async function routeMessage(userMessage, characters, history, signal) {
    const charSummaries = characters.map((c, i) => `${i + 1}. ${c.name}：${c.summary || c.personality || '无描述'}`).join('\n');

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
7. 场景设定优先：如果用户说某个角色"不在"、"还没来"、"在外面"，即使话题与该角色相关，也不要选该角色
只输出 JSON 数组，包含角色编号，例如 [1] 或 [1,2]，不要输出其他内容。`
      },
      {
        role: "user",
        content: `群聊角色：\n${charSummaries}\n\n用户说：${userMessage}`
      }
    ];

    const result = await App.callLLMJSON({ messages, temperature: 0.3, maxTokens: 50, signal });
    if (!result || !Array.isArray(result)) return [0]; // 默认第一个角色回答

    const indices = result.map(n => parseInt(n) - 1).filter(n => n >= 0 && n < characters.length);
    return indices.length > 0 ? indices : [0];
  }

  // Step 2: 角色回答生成
  async function generateCharacterReply(character, userMessage, history, allCharacters, options) {
    options = options || {};
    const otherChars = allCharacters.filter(c => c.id !== character.id);
    const otherCharsInfo = otherChars.length > 0
      ? '\n群聊中还有其他角色：' + otherChars.map(c => c.name).join('、')
      : '';

    const recentHistory = history.slice(-20).map(m => {
      if (m.role === 'user') return `用户：${m.content}`;
      if (m.role === 'character') return `${m.characterName || '角色'}：${m.content}`;
      if (m.role === 'assistant') return `AI：${m.content}`;
      return '';
    }).filter(Boolean).join('\n');

    // 本轮已生成的回复（多轮互动时避免重复）
    const roundReplies = options.currentRoundReplies || [];
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
口头禅参考（仅供参考语气，不要刻意堆砌）：${(character.catchphrases || []).join('、') || '无'}${otherCharsInfo}

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
      return await App.callLLM({
        model: options.model || 'deepseek-chat',
        messages,
        stream: true,
        temperature: 0.8,
        maxTokens: 1024,
        signal: options.signal,
        onChunk: options.onChunk
      });
    }

    const reply = await App.callLLM({
      model: options.model || 'deepseek-chat',
      messages,
      stream: false,
      temperature: 0.8,
      maxTokens: 1024,
      signal: options.signal
    });

    if (typeof reply === 'string') return App.limitSentences(reply);
    return reply; // 流式返回的是 { content, reasoningContent }
  }

  // Step 3: 追问判断
  async function shouldFollowUp(lastReplies, otherCharacter, userMessage, speakCount, signal) {
    speakCount = speakCount || 0;
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

    const result = await App.callLLM({ messages, temperature: 0.3, maxTokens: 10, signal });
    return String(result).trim().includes('是');
  }

  // 编排主函数（流式）
  async function orchestrateGroupChat(userMessage, characters, history, options) {
    options = options || {};
    const { onCharacterStart, onCharacterChunk, onCharacterEnd, signal, model } = options;
    const allReplies = [];
    const MAX_ROUNDS = 3; // 最大互动轮数，防止无限循环

    // Step 1: 路由判断
    let speakerIndices;
    try {
      speakerIndices = await routeMessage(userMessage, characters, history, signal);
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
          stream: !!onCharacterChunk,
          onChunk: onCharacterChunk ? (chunk) => onCharacterChunk(character, idx, chunk) : null,
          signal,
          model,
          currentRoundReplies: allReplies
        });
      } catch (e) {
        if (e.name === 'AbortError') break;
        throw e;
      }

      const content = typeof reply === 'string' ? reply : reply.content;
      allReplies.push({ characterId: character.id, characterName: character.name, content: App.limitSentences(content || '') });

      if (onCharacterEnd) onCharacterEnd(character, idx, content);
    }

    // Step 3: 多轮互动循环（A说→B回应→A再回应→B再回应...）
    if (allReplies.length > 0 && characters.length > 1) {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        if (signal && signal.aborted) break;

        const lastReply = allReplies[allReplies.length - 1];
        const lastSpeakerId = lastReply.characterId;

        // 找到所有"听到"最后一条消息的其他角色
        const otherChars = characters.filter(c => c.id !== lastSpeakerId);

        let anyoneSpoke = false;

        for (const otherChar of otherChars) {
          if (signal && signal.aborted) break;

          const speakCount = allReplies.filter(r => r.characterId === otherChar.id).length;
          if (speakCount >= 2) continue; // 每个角色本轮最多说2次

          let needFollow;
          try {
            needFollow = await shouldFollowUp([lastReply], otherChar, userMessage, speakCount, signal);
          } catch (e) {
            if (e.name === 'AbortError') break;
            throw e;
          }
          if (needFollow) {
            if (onCharacterStart) onCharacterStart(otherChar, characters.indexOf(otherChar));

            let reply;
            try {
              reply = await generateCharacterReply(otherChar, userMessage, history, characters, {
                stream: !!onCharacterChunk,
                onChunk: onCharacterChunk ? (chunk) => onCharacterChunk(otherChar, characters.indexOf(otherChar), chunk) : null,
                signal,
                model,
                currentRoundReplies: allReplies
              });
            } catch (e) {
              if (e.name === 'AbortError') break;
              throw e;
            }

            const content = typeof reply === 'string' ? reply : reply.content;
            allReplies.push({ characterId: otherChar.id, characterName: otherChar.name, content: App.limitSentences(content || '') });

            if (onCharacterEnd) onCharacterEnd(otherChar, characters.indexOf(otherChar), content);
            anyoneSpoke = true;
            break; // 每轮最多一个角色回应，下一轮再让其他人决定
          }
        }

        // 这一轮没人说话，互动结束
        if (!anyoneSpoke) break;
      }
    }

    return allReplies;
  }

  // ========== 群聊创建 UI ==========

  function openCreateGroupPanel() {
    if (App.characterData.length < 2) {
      App.showToast('至少需要创建 2 个角色才能创建群聊');
      return;
    }
    createGroupPanel.classList.remove('hidden');
    renderCreateGroupCharacterList();
  }

  function closeCreateGroupPanel() {
    createGroupPanel.classList.add('hidden');
  }

  function renderCreateGroupCharacterList() {
    createGroupCharacterList.innerHTML = '';
    App.selectedGroupCharacterIds.clear();
    App.characterData.forEach(char => {
      const div = document.createElement('div');
      div.className = 'group-char-select-item';
      div.dataset.id = char.id;
      div.innerHTML = `
        <label class="flex items-center gap-3 cursor-pointer p-2 rounded-lg hover:bg-gray-800 transition-colors">
          <input type="checkbox" class="group-char-checkbox w-4 h-4" value="${char.id}">
          <div class="flex-1 min-w-0">
            <div class="text-sm text-white font-medium">${App.escapeHtml(char.name)}</div>
            <div class="text-xs text-gray-500">${App.escapeHtml(char.summary || '暂无描述')}</div>
          </div>
        </label>
      `;
      createGroupCharacterList.appendChild(div);
    });

    document.querySelectorAll('.group-char-checkbox').forEach(cb => {
      cb.addEventListener('change', function() {
        if (this.checked) App.selectedGroupCharacterIds.add(this.value);
        else App.selectedGroupCharacterIds.delete(this.value);
      });
    });
  }

  function createGroupChat() {
    if (App.selectedGroupCharacterIds.size < 2) {
      App.showToast('请至少选择 2 个角色');
      return;
    }
    const groupTitle = createGroupNameInput.value.trim() || '群聊';
    const charIds = Array.from(App.selectedGroupCharacterIds);

    const tabIds = Object.keys(App.tabData.list);
    let maxIdNum = 0;
    tabIds.forEach(id => {
      const num = parseInt(id.replace('tab', ''), 10);
      if (num > maxIdNum) maxIdNum = num;
    });
    const newId = `tab${maxIdNum + 1}`;

    App.tabData.list[newId] = {
      type: 'group',
      characterIds: charIds,
      messages: [],
      title: groupTitle
    };
    App.tabData.active = newId;
    App.saveTabs();
    App.renderChat();
    App.renderTabs();
    App.updateInputCounter();
    closeCreateGroupPanel();
    App.closeSidebar();
    App.showToast('群聊已创建');
  }

  // ========== 注册到 App ==========
  App.routeMessage = routeMessage;
  App.generateCharacterReply = generateCharacterReply;
  App.shouldFollowUp = shouldFollowUp;
  App.orchestrateGroupChat = orchestrateGroupChat;
  App.openCreateGroupPanel = openCreateGroupPanel;
  App.closeCreateGroupPanel = closeCreateGroupPanel;

  // 初始化 selectedGroupCharacterIds
  if (!App.selectedGroupCharacterIds) {
    App.selectedGroupCharacterIds = new Set();
  }

  // ========== 事件绑定 ==========

  // 群聊面板事件
  if (closeCreateGroupBtn) closeCreateGroupBtn.addEventListener('click', closeCreateGroupPanel);
  if (createGroupPanel) createGroupPanel.addEventListener('click', (e) => { if (e.target === createGroupPanel) closeCreateGroupPanel(); });
  if (createGroupConfirmBtn) createGroupConfirmBtn.addEventListener('click', createGroupChat);
  if (cancelCreateGroupBtn) cancelCreateGroupBtn.addEventListener('click', closeCreateGroupPanel);
  if (openCharacterFromGroupBtn) openCharacterFromGroupBtn.addEventListener('click', () => {
    closeCreateGroupPanel();
    if (App.openCharacterPanel) App.openCharacterPanel();
  });
})();
