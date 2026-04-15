document.addEventListener('DOMContentLoaded', function() {
  try {
  let dsUserId = localStorage.getItem('ds_user_id');
  if (!dsUserId) {
    dsUserId = 'user_' + Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
    localStorage.setItem('ds_user_id', dsUserId);
  }

  /* ========================================================================
   * 一、基础工具
   * ======================================================================== */

  function trackEvent(eventType) {
    const webhookUrl = 'https://bytedance.sg.larkoffice.com/base/automation/webhook/event/GnMPaByLZwehPShLu46lsgQQghd';
    fetch(webhookUrl, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_type: eventType, user_id: dsUserId })
    }).catch(err => { console.log('Tracking info:', err); });
  }

  trackEvent('访问页面');

  let apiKey = localStorage.getItem("dsApiKey");

  let tabData = JSON.parse(localStorage.getItem("dsTabs")) || (() => {
    const oldMsgs = JSON.parse(localStorage.getItem("dsMessages")) || [];
    return { active: "tab1", list: { tab1: { messages: oldMsgs, memoryLimit: "0", title: "" } } };
  })();

  Object.keys(tabData.list).forEach(id => {
    if (Array.isArray(tabData.list[id])) {
      tabData.list[id] = { messages: tabData.list[id], memoryLimit: "0", title: "" };
    } else {
      if (typeof tabData.list[id].title === 'undefined') tabData.list[id].title = "";
      if (typeof tabData.list[id].memoryLimit === 'undefined') tabData.list[id].memoryLimit = "0";
      if (!Array.isArray(tabData.list[id].messages)) tabData.list[id].messages = [];
    }

    tabData.list[id].messages.forEach(msg => {
      if (msg.history && typeof msg.history[0] === 'string') {
        msg.history = msg.history.map(content => ({ content: content, reasoningContent: "" }));
      }
    });
  });

  let editingMessageIndex = -1;
  let isSending = false;
  let abortController = null;
  let abortReason = null;
  let lastPageHiddenAt = 0;
  let shouldToastOnVisible = false;

  /* ========================================================================
   * 二、LLM 调用封装
   * ======================================================================== */

  function abortStreaming(reason) {
    abortReason = reason;
    if (abortController) {
      try { abortController.abort(); } catch (_) {}
    }
  }

  // ========== LLM 通用调用封装 ==========
  async function callLLM({ model = 'deepseek-chat', messages = [], stream = false, temperature = 0.7, maxTokens = 4096, signal = null, onChunk = null } = {}) {
    const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "Cache-Control": "no-cache",
        "Pragma": "no-cache"
      },
      body: JSON.stringify({
        model,
        messages,
        stream,
        temperature,
        max_tokens: maxTokens
      }),
      signal
    });

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData.error?.message || '请求失败，请检查 API Key 或稍后重试');
    }

    if (!stream) {
      const data = await res.json();
      return data?.choices?.[0]?.message?.content || '';
    }

    // 流式处理
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullContent = "";
    let fullReasoningContent = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (line.trim() === "" || !line.startsWith("data: ")) continue;
        const dataStr = line.slice(6);
        if (dataStr === "[DONE]") break;

        try {
          const data = JSON.parse(dataStr);
          const delta = data.choices[0].delta;
          if (delta.reasoning_content) fullReasoningContent += delta.reasoning_content;
          if (delta.content) fullContent += delta.content;
          if (onChunk) onChunk({ content: delta.content || '', reasoningContent: delta.reasoning_content || '', fullContent, fullReasoningContent });
        } catch (e) { continue; }
      }
    }

    return { content: fullContent, reasoningContent: fullReasoningContent };
  }

  async function callLLMJSON({ model = 'deepseek-chat', messages = [], temperature = 0.5, maxTokens = 1024, signal = null } = {}) {
    const text = await callLLM({ model, messages, stream: false, temperature, maxTokens, signal });
    try {
      return JSON.parse(text.replace(/^```json?\n?/i, '').replace(/\n?```$/, '').trim());
    } catch (e) {
      console.warn('callLLMJSON 解析失败:', text);
      return null;
    }
  }

  // ========== 角色卡模块 ==========
  const CHARACTER_STORAGE_KEY = 'dsCharacters';
  let characterData;
  try {
    const rawCharData = JSON.parse(localStorage.getItem(CHARACTER_STORAGE_KEY));
    characterData = Array.isArray(rawCharData) ? rawCharData : [];
  } catch (e) {
    console.warn('dsCharacters 数据损坏，已重置:', e);
    characterData = [];
  }
  let editingCharacterId = null;

  function saveCharacters() {
    localStorage.setItem(CHARACTER_STORAGE_KEY, JSON.stringify(characterData));
    updateStorageUsage();
  }

  function getCharacterById(id) {
    return characterData.find(c => c.id === id) || null;
  }

  function createCharacter(data) {
    const character = {
      id: 'char_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      name: data.name || '未命名角色',
      avatar: data.avatar || null,
      summary: data.summary || '',
      personality: data.personality || '',
      background: data.background || '',
      appearance: data.appearance || '',
      speakingStyle: data.speakingStyle || '',
      catchphrases: data.catchphrases || [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    characterData.push(character);
    saveCharacters();
    return character;
  }

  function updateCharacter(id, data) {
    const idx = characterData.findIndex(c => c.id === id);
    if (idx === -1) return null;
    Object.assign(characterData[idx], data, { updatedAt: Date.now() });
    saveCharacters();
    return characterData[idx];
  }

  function deleteCharacter(id) {
    characterData = characterData.filter(c => c.id !== id);
    saveCharacters();
  }

  function findCharacterRefs(charId, charName) {
    const refs = [];
    const list = tabData.list;
    for (const id in list) {
      const tab = list[id];
      const cids = tab.characterIds || [];
      if (cids.includes(charId)) {
        const displayName = getTabDisplayName(id);
        const type = tab.type === 'group' ? '群聊' : (tab.type === 'single-character' ? '角色对话' : '对话');
        refs.push(type + '「' + displayName + '」');
      }
    }
    return refs;
  }

  async function aiEnhanceCharacter(brief) {
    if (!apiKey) { keyPanel.classList.remove("hidden"); return null; }
    const messages = [
      {
        role: "system",
        content: `你是一个角色设计助手。根据用户的简要描述，生成一个完整的角色卡。请严格按以下 JSON 格式输出，不要输出其他内容：
{
  "name": "角色名字",
  "summary": "一句话概括角色（50字以内）",
  "personality": "详细性格描述（100-200字）",
  "background": "角色背景经历（100-200字）",
  "appearance": "外貌描写（50-100字）",
  "speakingStyle": "说话风格描述（50-100字）",
  "catchphrases": ["口头禅1", "口头禅2"]
}`
      },
      {
        role: "user",
        content: brief
      }
    ];
    const result = await callLLMJSON({ messages, temperature: 0.8, maxTokens: 1500 });
    return result;
  }

  // 角色卡面板元素
  const characterPanel = document.getElementById('characterPanel');
  const closeCharacterPanelBtn = document.getElementById('closeCharacterPanelBtn');
  const characterListEl = document.getElementById('characterList');
  const addCharacterBtn = document.getElementById('addCharacterBtn');
  const characterEditPanel = document.getElementById('characterEditPanel');
  const characterEditName = document.getElementById('characterEditName');
  const characterEditSummary = document.getElementById('characterEditSummary');
  const characterEditPersonality = document.getElementById('characterEditPersonality');
  const characterEditBackground = document.getElementById('characterEditBackground');
  const characterEditAppearance = document.getElementById('characterEditAppearance');
  const characterEditSpeakingStyle = document.getElementById('characterEditSpeakingStyle');
  const characterEditCatchphrases = document.getElementById('characterEditCatchphrases');
  const characterEditBrief = document.getElementById('characterEditBrief');
  const aiEnhanceBtn = document.getElementById('aiEnhanceBtn');
  const aiEnhanceLabel = document.getElementById('aiEnhanceLabel');
  const cancelCharacterEditBtn = document.getElementById('cancelCharacterEditBtn');
  const saveCharacterBtn = document.getElementById('saveCharacterBtn');

  function openCharacterPanel() {
    characterPanel.classList.remove('hidden');
    renderCharacterList();
  }

  function closeCharacterPanel() {
    characterPanel.classList.add('hidden');
  }

  function renderCharacterList() {
    characterListEl.innerHTML = '';
    if (!characterData.length) {
      characterListEl.innerHTML = '<div class="prompt-empty"><div class="text-base mb-2">还没有创建任何角色</div><div class="text-sm text-gray-500">点击下方按钮创建角色卡，或用 AI 智能生成。</div></div>';
      return;
    }
    characterData.forEach(char => {
      const div = document.createElement('div');
      div.className = 'character-item';
      div.innerHTML = `
        <div class="character-item-header">
          <div class="flex-1 min-w-0">
            <div class="character-name">${escapeHtml(char.name)}</div>
            <div class="character-summary">${escapeHtml(char.summary || '暂无描述')}</div>
          </div>
        </div>
        <div class="character-actions">
          <button class="prompt-icon-btn character-chat-btn" data-id="${char.id}" title="单独聊天">${chatIconSvg}</button>
          <button class="prompt-icon-btn character-edit-btn" data-id="${char.id}" title="编辑">${editIconSvg}</button>
          <button class="prompt-icon-btn character-delete-btn delete" data-id="${char.id}" title="删除">${deleteIconSvg}</button>
        </div>
      `;
      characterListEl.appendChild(div);
    });

    document.querySelectorAll('.character-chat-btn').forEach(btn => {
      btn.addEventListener('click', function() {
        const char = getCharacterById(this.dataset.id);
        if (char) createCharacterChatTab(char.id);
      });
    });

    document.querySelectorAll('.character-edit-btn').forEach(btn => {
      btn.addEventListener('click', function() {
        const char = getCharacterById(this.dataset.id);
        if (char) showCharacterEditForm(char);
      });
    });

    document.querySelectorAll('.character-delete-btn').forEach(btn => {
      btn.addEventListener('click', function() {
        const char = getCharacterById(this.dataset.id);
        if (!char) return;
        // 检查该角色是否被对话或群聊引用
        const refs = findCharacterRefs(char.id, char.name);
        if (refs.length > 0) {
          const lines = refs.map(r => '  · ' + r).join('\n');
          alert('角色「' + char.name + '」仍被以下对话引用，请先删除这些对话：\n' + lines);
          return;
        }
        if (!confirm('确定删除角色「' + char.name + '」吗？')) return;
        deleteCharacter(char.id);
        renderCharacterList();
        showToast('角色已删除');
      });
    });
  }

  function showCharacterEditForm(char = null) {
    characterEditPanel.classList.remove('hidden');
    if (char) {
      editingCharacterId = char.id;
      characterEditName.value = char.name || '';
      characterEditSummary.value = char.summary || '';
      characterEditPersonality.value = char.personality || '';
      characterEditBackground.value = char.background || '';
      characterEditAppearance.value = char.appearance || '';
      characterEditSpeakingStyle.value = char.speakingStyle || '';
      characterEditCatchphrases.value = (char.catchphrases || []).join('、');
      characterEditBrief.value = '';
    } else {
      editingCharacterId = null;
      characterEditName.value = '';
      characterEditSummary.value = '';
      characterEditPersonality.value = '';
      characterEditBackground.value = '';
      characterEditAppearance.value = '';
      characterEditSpeakingStyle.value = '';
      characterEditCatchphrases.value = '';
      characterEditBrief.value = '';
    }
    setTimeout(() => characterEditName.focus(), 50);
  }

  function hideCharacterEditForm() {
    characterEditPanel.classList.add('hidden');
    editingCharacterId = null;
  }

  async function handleAiEnhance() {
    const brief = characterEditBrief.value.trim();
    if (!brief) { showToast('请先输入简要描述'); characterEditBrief.focus(); return; }
    if (!apiKey) { keyPanel.classList.remove("hidden"); return; }

    aiEnhanceBtn.disabled = true;
    if (aiEnhanceLabel) aiEnhanceLabel.textContent = '生成中';

    try {
      const result = await aiEnhanceCharacter(brief);
      if (!result) throw new Error('AI 未返回有效结果');
      characterEditName.value = result.name || '';
      characterEditSummary.value = result.summary || '';
      characterEditPersonality.value = result.personality || '';
      characterEditBackground.value = result.background || '';
      characterEditAppearance.value = result.appearance || '';
      characterEditSpeakingStyle.value = result.speakingStyle || '';
      characterEditCatchphrases.value = (result.catchphrases || []).join('、');
      showToast('角色卡已生成');
    } catch (e) {
      console.error(e);
      alert('AI 生成失败：' + e.message);
    } finally {
      aiEnhanceBtn.disabled = false;
      if (aiEnhanceLabel) aiEnhanceLabel.textContent = 'AI 生成';
    }
  }

  function saveCharacterForm() {
    const name = characterEditName.value.trim();
    if (!name) { alert('请输入角色名字'); characterEditName.focus(); return; }
    const catchphrases = characterEditCatchphrases.value.split(/[、,，]/).map(s => s.trim()).filter(Boolean);

    const data = {
      name,
      summary: characterEditSummary.value.trim(),
      personality: characterEditPersonality.value.trim(),
      background: characterEditBackground.value.trim(),
      appearance: characterEditAppearance.value.trim(),
      speakingStyle: characterEditSpeakingStyle.value.trim(),
      catchphrases
    };

    if (editingCharacterId) {
      updateCharacter(editingCharacterId, data);
      showToast('角色已更新');
    } else {
      createCharacter(data);
      showToast('角色已创建');
    }
    hideCharacterEditForm();
    renderCharacterList();
  }

  // 角色卡事件绑定
  if (closeCharacterPanelBtn) closeCharacterPanelBtn.addEventListener('click', closeCharacterPanel);
  if (characterPanel) characterPanel.addEventListener('click', (e) => { if (e.target === characterPanel) closeCharacterPanel(); });
  if (addCharacterBtn) addCharacterBtn.addEventListener('click', () => showCharacterEditForm());
  if (cancelCharacterEditBtn) cancelCharacterEditBtn.addEventListener('click', hideCharacterEditForm);
  const closeCharacterEditPanelBtn = document.getElementById('closeCharacterEditPanelBtn');
  if (closeCharacterEditPanelBtn) closeCharacterEditPanelBtn.addEventListener('click', hideCharacterEditForm);
  if (characterEditPanel) characterEditPanel.addEventListener('click', (e) => { if (e.target === characterEditPanel) hideCharacterEditForm(); });
  if (saveCharacterBtn) saveCharacterBtn.addEventListener('click', saveCharacterForm);
  if (aiEnhanceBtn) aiEnhanceBtn.addEventListener('click', handleAiEnhance);

  // ========== 群聊编排模块 (Level 2) ==========
  const CHARACTER_COLORS = ['#f87171', '#60a5fa', '#34d399', '#fbbf24', '#a78bfa', '#f472b6', '#38bdf8', '#fb923c'];
  function getCharacterColor(index) {
    return CHARACTER_COLORS[index % CHARACTER_COLORS.length];
  }

  // 5句话限制
  function limitSentences(text, maxSentences = 5) {
    if (!text) return text;
    const sentences = text.split(/(?<=[。！？.!?])/);
    if (sentences.length <= maxSentences) return text;
    return sentences.slice(0, maxSentences).join('');
  }

  // Step 1: 路由判断 - 哪些角色应该回答
  async function routeMessage(userMessage, characters, history, signal = null) {
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

    const result = await callLLMJSON({ messages, temperature: 0.3, maxTokens: 50, signal });
    if (!result || !Array.isArray(result)) return [0]; // 默认第一个角色回答

    const indices = result.map(n => parseInt(n) - 1).filter(n => n >= 0 && n < characters.length);
    return indices.length > 0 ? indices : [0];
  }

  // Step 2: 角色回答生成
  async function generateCharacterReply(character, userMessage, history, allCharacters, options = {}) {
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
      return await callLLM({
        model: options.model || 'deepseek-chat',
        messages,
        stream: true,
        temperature: 0.8,
        maxTokens: 1024,
        signal: options.signal,
        onChunk: options.onChunk
      });
    }

    const reply = await callLLM({
      model: options.model || 'deepseek-chat',
      messages,
      stream: false,
      temperature: 0.8,
      maxTokens: 1024,
      signal: options.signal
    });

    if (typeof reply === 'string') return limitSentences(reply);
    return reply; // 流式返回的是 { content, reasoningContent }
  }

  // Step 3: 追问判断
  async function shouldFollowUp(lastReplies, otherCharacter, userMessage, speakCount = 0, signal = null) {
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

    const result = await callLLM({ messages, temperature: 0.3, maxTokens: 10, signal });
    return String(result).trim().includes('是');
  }

  // 编排主函数（流式）
  async function orchestrateGroupChat(userMessage, characters, history, options = {}) {
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
      allReplies.push({ characterId: character.id, characterName: character.name, content: limitSentences(content || '') });

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
            allReplies.push({ characterId: otherChar.id, characterName: otherChar.name, content: limitSentences(content || '') });

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

  // ========== 群聊会话管理 ==========
  const createGroupPanel = document.getElementById('createGroupPanel');
  const closeCreateGroupBtn = document.getElementById('closeCreateGroupBtn');
  const createGroupCharacterList = document.getElementById('createGroupCharacterList');
  const createGroupConfirmBtn = document.getElementById('createGroupConfirmBtn');
  const createGroupNameInput = document.getElementById('createGroupNameInput');
  const openCharacterFromGroupBtn = document.getElementById('openCharacterFromGroupBtn');

  function openCreateGroupPanel() {
    if (characterData.length < 2) {
      showToast('至少需要创建 2 个角色才能创建群聊');
      return;
    }
    createGroupPanel.classList.remove('hidden');
    createGroupNameInput.value = '';
    renderCreateGroupCharacterList();
  }

  function closeCreateGroupPanel() {
    createGroupPanel.classList.add('hidden');
  }

  let selectedGroupCharacterIds = new Set();

  function renderCreateGroupCharacterList() {
    createGroupCharacterList.innerHTML = '';
    selectedGroupCharacterIds.clear();
    characterData.forEach(char => {
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
        if (this.checked) selectedGroupCharacterIds.add(this.value);
        else selectedGroupCharacterIds.delete(this.value);
      });
    });
  }

  function createGroupChat() {
    if (selectedGroupCharacterIds.size < 2) {
      showToast('请至少选择 2 个角色');
      return;
    }
    const groupTitle = createGroupNameInput.value.trim() || '群聊';
    const charIds = Array.from(selectedGroupCharacterIds);

    const tabIds = Object.keys(tabData.list);
    let maxIdNum = 0;
    tabIds.forEach(id => {
      const num = parseInt(id.replace('tab', ''), 10);
      if (num > maxIdNum) maxIdNum = num;
    });
    const newId = `tab${maxIdNum + 1}`;

    tabData.list[newId] = {
      type: 'group',
      characterIds: charIds,
      messages: [],
      title: groupTitle
    };
    tabData.active = newId;
    saveTabs();
    renderChat();
    renderTabs();
    updateInputCounter();
    closeCreateGroupPanel();
    closeSidebar();
    showToast('群聊已创建');
  }

  // 群聊面板事件
  if (closeCreateGroupBtn) closeCreateGroupBtn.addEventListener('click', closeCreateGroupPanel);
  if (createGroupPanel) createGroupPanel.addEventListener('click', (e) => { if (e.target === createGroupPanel) closeCreateGroupPanel(); });
  if (createGroupConfirmBtn) createGroupConfirmBtn.addEventListener('click', createGroupChat);

  // 角色选择面板事件
  const characterSelectPanel = document.getElementById('characterSelectPanel');
  const closeCharacterSelectBtn = document.getElementById('closeCharacterSelectBtn');
  if (closeCharacterSelectBtn) closeCharacterSelectBtn.addEventListener('click', () => { if (characterSelectPanel) characterSelectPanel.classList.add('hidden'); });
  if (characterSelectPanel) characterSelectPanel.addEventListener('click', (e) => { if (e.target === characterSelectPanel) characterSelectPanel.classList.add('hidden'); });
  if (openCharacterFromGroupBtn) openCharacterFromGroupBtn.addEventListener('click', () => {
    closeCreateGroupPanel();
    openCharacterPanel();
  });

  /* ========================================================================
   * 三、存储与数据管理
   * ======================================================================== */

  const PROMPT_STORAGE_KEY = 'dsPrompts';
  let promptData;
  try {
    const rawPromptData = JSON.parse(localStorage.getItem(PROMPT_STORAGE_KEY));
    promptData = Array.isArray(rawPromptData) ? rawPromptData : [];
  } catch (e) {
    console.warn('dsPrompts 数据损坏，已重置:', e);
    promptData = [];
  }
  let editingPromptId = null;

  let renamingTabId = null;
  let confirmResolve = null;
  let optimizedCandidateText = '';
  let optimizeInProgress = false;

  // 搜索功能变量
  let searchQuery = '';
  let searchResults = [];
  let currentSearchIndex = -1;

  const MAX_CONTEXT_TOKENS = 131072;
  function isTokenLimitReached() {
    const currentMsgs = tabData.list[tabData.active].messages || [];
    const payloadMsgs = buildPayloadMessages(currentMsgs);
    let estimatedTokens = 0;
    payloadMsgs.forEach(m => {
      estimatedTokens += estimateTokensByText(m.content);
    });
    return estimatedTokens >= MAX_CONTEXT_TOKENS * 0.98;
  }

  function getTabDisplayName(id) {
    const tab = tabData.list[id];
    if (!tab) return id;
    const customTitle = (tab.title || '').trim();
    if (customTitle) return customTitle;
    if (tab.type === 'single-character' && tab.characterId) {
      const char = getCharacterById(tab.characterId);
      return char ? char.name : `对话 ${id.replace("tab", "")}`;
    }
    return `对话 ${id.replace("tab", "")}`;
  }

  const chat = document.getElementById("chat");
  const input = document.getElementById("input");
  const sendBtn = document.getElementById("sendBtn");
  const tabsEl = document.getElementById("tabs");
  const addTab = document.getElementById("addTab");
  const keyPanel = document.getElementById("keyPanel");
  const apiKeyInput = document.getElementById("apiKeyInput");
  const saveKey = document.getElementById("saveKey");
  const editPanel = document.getElementById("editPanel");
  const editTextarea = document.getElementById("editTextarea");
  const editCancelBtn = document.getElementById("editCancelBtn");
  const editSaveBtn = document.getElementById("editSaveBtn");
  const scrollToBottomBtn = document.getElementById("scrollToBottomBtn");
  const modelSelect = document.getElementById("modelSelect");
  const deepThinkToggle = document.getElementById("deepThinkToggle");

  const menuBtn = document.getElementById("menuBtn");
  const sidebar = document.getElementById("sidebar");
  const sidebarOverlay = document.getElementById("sidebarOverlay");
  const inputCounter = document.getElementById("inputCounter");

  const openDonateBtn = document.getElementById("openDonateBtn");
  const donatePanel = document.getElementById("donatePanel");
  const closeDonateBtn = document.getElementById("closeDonateBtn");

  const openInfoBtn = document.getElementById("openInfoBtn");
  const infoPanel = document.getElementById("infoPanel");
  const closeInfoBtn = document.getElementById("closeInfoBtn");

  const openPromptManagerBtn = document.getElementById("openPromptManagerBtn");
  const promptPanel = document.getElementById("promptPanel");
  const closePromptPanelBtn = document.getElementById("closePromptPanelBtn");
  const promptListView = document.getElementById("promptListView");
  const promptFormView = document.getElementById("promptFormView");
  const promptList = document.getElementById("promptList");
  const addPromptBtn = document.getElementById("addPromptBtn");
  const promptTitleInput = document.getElementById("promptTitleInput");
  const promptContentInput = document.getElementById("promptContentInput");
  const cancelPromptEditBtn = document.getElementById("cancelPromptEditBtn");
  const savePromptBtn = document.getElementById("savePromptBtn");
  const optimizePromptBtn = document.getElementById("optimizePromptBtn");

  const settingsBtn = document.getElementById("settingsBtn");
  const settingsPanel = document.getElementById("settingsPanel");
  const settingsCloseBtn = document.getElementById("settingsCloseBtn");
  const settingsApiKeyInput = document.getElementById("settingsApiKeyInput");
  const settingsCopyKeyBtn = document.getElementById("settingsCopyKeyBtn");
  const settingsSaveKeyBtn = document.getElementById("settingsSaveKeyBtn");
  const settingsDayModeToggle = document.getElementById("settingsDayModeToggle");
  const settingsTokenEstimateToggle = document.getElementById("settingsTokenEstimateToggle");
  const settingsMemorySelect = document.getElementById("settingsMemorySelect");
  const settingsMemoryCustom = document.getElementById("settingsMemoryCustom");

  const renameTabPanel = document.getElementById("renameTabPanel");
  const renameTabInput = document.getElementById("renameTabInput");
  const renameTabCancelBtn = document.getElementById("renameTabCancelBtn");
  const renameTabSaveBtn = document.getElementById("renameTabSaveBtn");

  const confirmPanel = document.getElementById("confirmPanel");
  const confirmTitle = document.getElementById("confirmTitle");
  const confirmDesc = document.getElementById("confirmDesc");
  const confirmCancelBtn = document.getElementById("confirmCancelBtn");
  const confirmOkBtn = document.getElementById("confirmOkBtn");

  const downloadPanel = document.getElementById("downloadPanel");
  const downloadCancelBtn = document.getElementById("downloadCancelBtn");
  const downloadAllBtn = document.getElementById("downloadAllBtn");
  const downloadAiOnlyBtn = document.getElementById("downloadAiOnlyBtn");
  const includeReasoningToggle = document.getElementById("includeReasoningToggle");
  let pendingDownloadTabId = null;

  const promptOptimizePreviewPanel = document.getElementById("promptOptimizePreviewPanel");
  const originalPromptPreview = document.getElementById("originalPromptPreview");
  const optimizedPromptPreview = document.getElementById("optimizedPromptPreview");
  const discardOptimizedPromptBtn = document.getElementById("discardOptimizedPromptBtn");
  const applyOptimizedPromptBtn = document.getElementById("applyOptimizedPromptBtn");

  const copyIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
  const deleteIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`;
  const editIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"></path></svg>`;
  const checkIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
  const downloadIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`;
  const renameIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"></path></svg>`;
  const chatIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>`;

  // 搜索功能元素
  const searchToggleBtn = document.getElementById('searchToggleBtn');
  const searchBox = document.getElementById('searchBox');
  const searchInput = document.getElementById('searchInput');
  const closeSearchBtn = document.getElementById('closeSearchBtn');
  const searchResultsInfo = document.getElementById('searchResultsInfo');
  const searchResultsText = document.getElementById('searchResultsText');
  const prevSearchResult = document.getElementById('prevSearchResult');
  const nextSearchResult = document.getElementById('nextSearchResult');
  const appTitle = document.getElementById('appTitle');

  // 存储用量相关元素
  const storageUsageText = document.getElementById('storageUsageText');
  const storageWarningIcon = document.getElementById('storageWarningIcon');

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }

  function updateStorageUsage() {
    let totalUsed = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key) {
        totalUsed += (localStorage.getItem(key) || '').length * 2; // UTF-16 每字符2字节
      }
    }
    const limit = 5 * 1024 * 1024; // 5MB
    const percent = Math.min(Math.round((totalUsed / limit) * 100), 100);
    const isWarning = percent >= 95;

    storageUsageText.textContent = '本地存储容量 ' + formatBytes(totalUsed) + '/5MB(' + percent + '%)';

    if (isWarning) {
      storageUsageText.classList.add('storage-warning');
      storageWarningIcon.classList.remove('hidden');
    } else {
      storageUsageText.classList.remove('storage-warning');
      storageWarningIcon.classList.add('hidden');
    }
  }

  function isStorageFull() {
    let totalUsed = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key) {
        totalUsed += (localStorage.getItem(key) || '').length * 2;
      }
    }
    return totalUsed / (5 * 1024 * 1024) >= 0.99;
  }

  storageWarningIcon.addEventListener('click', function() {
    alert('当前聊天内容接近本地存储上限，请及时导出并清理过期会话。');
  });

  updateStorageUsage();

  if (!apiKey) {
    keyPanel.classList.remove("hidden");
  } else {
    apiKeyInput.value = apiKey;
  }

  /* ========================================================================
   * 四、UI 工具函数（Toast、复制、格式化等）
   * ======================================================================== */

  function showToast(text) {
    const toast = document.createElement('div');
    toast.textContent = text;
    toast.style.position = 'fixed';
    toast.style.left = '50%';
    toast.style.bottom = '110px';
    toast.style.transform = 'translateX(-50%)';
    
    const isDayMode = document.body.classList.contains('day-mode');
    if (isDayMode) {
      toast.style.background = 'rgba(255,255,255,.95)';
      toast.style.color = '#111827';
      toast.style.border = '1px solid #e5e7eb';
      toast.style.boxShadow = '0 10px 30px rgba(0,0,0,.1)';
    } else {
      toast.style.background = 'rgba(17,24,39,.95)';
      toast.style.color = '#fff';
      toast.style.border = '1px solid #374151';
      toast.style.boxShadow = '0 10px 30px rgba(0,0,0,.35)';
    }
    
    toast.style.padding = '10px 14px';
    toast.style.borderRadius = '10px';
    toast.style.fontSize = '13px';
    toast.style.zIndex = '120';
    toast.style.opacity = '0';
    toast.style.transition = 'all .25s ease';
    document.body.appendChild(toast);
    requestAnimationFrame(() => {
      toast.style.opacity = '1';
      toast.style.bottom = '120px';
    });
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.bottom = '110px';
      setTimeout(() => toast.remove(), 250);
    }, 1800);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      lastPageHiddenAt = Date.now();
      if (isSending && abortController) {
        shouldToastOnVisible = true;
        abortStreaming('background');
      }
      return;
    }

    if (shouldToastOnVisible) {
      shouldToastOnVisible = false;
      showToast('已从后台返回：刚才的生成已中断，可点击“重新生成”继续');
    }
  });

  openDonateBtn.addEventListener("click", () => donatePanel.classList.remove("hidden"));
  closeDonateBtn.addEventListener("click", () => donatePanel.classList.add("hidden"));
  donatePanel.addEventListener("click", (e) => {
    if (e.target === donatePanel) donatePanel.classList.add("hidden");
  });

  openInfoBtn.addEventListener("click", () => infoPanel.classList.remove("hidden"));
  closeInfoBtn.addEventListener("click", () => infoPanel.classList.add("hidden"));
  infoPanel.addEventListener("click", (e) => {
    if (e.target === infoPanel) infoPanel.classList.add("hidden");
  });

  let savedModel = "deepseek-chat";
  modelSelect.value = savedModel;
  deepThinkToggle.checked = false;

  deepThinkToggle.addEventListener("change", (e) => {
    const newModel = e.target.checked ? "deepseek-reasoner" : "deepseek-chat";
    modelSelect.value = newModel;
  });

  const savedDayMode = localStorage.getItem("dsDayMode") === "true";
  if (settingsDayModeToggle) {
    settingsDayModeToggle.checked = savedDayMode;
  }
  if (savedDayMode) {
    document.body.classList.add("day-mode");
  }

  if (settingsDayModeToggle) {
    settingsDayModeToggle.addEventListener("change", (e) => {
      const isDayMode = e.target.checked;
      if (isDayMode) {
        document.body.classList.add("day-mode");
      } else {
        document.body.classList.remove("day-mode");
      }
      localStorage.setItem("dsDayMode", isDayMode.toString());
    });
  }

  const showTokenEstimate = localStorage.getItem("dsShowTokenEstimate") !== "false";
  if (settingsTokenEstimateToggle) {
    settingsTokenEstimateToggle.checked = showTokenEstimate;
  }
  if (!showTokenEstimate) {
    document.body.classList.add("hide-token-estimate");
  }

  if (settingsTokenEstimateToggle) {
    settingsTokenEstimateToggle.addEventListener("change", (e) => {
      const show = e.target.checked;
      if (show) {
        document.body.classList.remove("hide-token-estimate");
      } else {
        document.body.classList.add("hide-token-estimate");
      }
      localStorage.setItem("dsShowTokenEstimate", show.toString());
    });
  }

  const savedFontSize = localStorage.getItem("dsFontSize") || "default";
  applyFontSize(savedFontSize);
  if (document.querySelector('.font-size-option')) {
    updateFontSizeButtons(savedFontSize);
  }

  let globalMemoryLimit = localStorage.getItem("dsGlobalMemoryLimit") || "0";

  /* ========================================================================
   * 五、设置面板、侧边栏、导出、确认弹窗
   * ======================================================================== */

  function applyFontSize(size) {
    document.body.classList.remove("font-size-small", "font-size-smaller", "font-size-default", "font-size-larger", "font-size-large");
    document.body.classList.add(`font-size-${size}`);
  }

  function updateFontSizeButtons(activeSize) {
    document.querySelectorAll('.font-size-option').forEach(btn => {
      const btnSize = btn.getAttribute('data-size');
      if (btnSize === activeSize) {
        btn.classList.add('active');
        btn.classList.add('bg-blue-600', 'border-blue-500', 'text-white');
        btn.classList.remove('border-gray-700', 'text-gray-400');
      } else {
        btn.classList.remove('active');
        btn.classList.remove('bg-blue-600', 'border-blue-500', 'text-white');
        btn.classList.add('border-gray-700', 'text-gray-400');
      }
    });
  }

  document.querySelectorAll('.font-size-option').forEach(btn => {
    btn.addEventListener('click', () => {
      const size = btn.getAttribute('data-size');
      applyFontSize(size);
      updateFontSizeButtons(size);
      localStorage.setItem("dsFontSize", size);
    });
  });

  function openSettingsPanel() {
    if (settingsApiKeyInput) {
      settingsApiKeyInput.value = apiKey || "";
    }
    const currentFontSize = localStorage.getItem("dsFontSize") || "default";
    const currentDayMode = localStorage.getItem("dsDayMode") === "true";
    if (settingsDayModeToggle) {
      settingsDayModeToggle.checked = currentDayMode;
    }
    updateFontSizeButtons(currentFontSize);
    
    const currentMemoryLimit = globalMemoryLimit;
    if (settingsMemorySelect) {
      if (["0", "200", "100", "50"].includes(currentMemoryLimit)) {
        settingsMemorySelect.value = currentMemoryLimit;
        if (settingsMemoryCustom) {
          settingsMemoryCustom.classList.add("hidden");
        }
      } else {
        settingsMemorySelect.value = "custom";
        if (settingsMemoryCustom) {
          settingsMemoryCustom.value = currentMemoryLimit;
          settingsMemoryCustom.classList.remove("hidden");
        }
      }
    }
    
    if (settingsPanel) {
      settingsPanel.classList.remove("hidden");
    }
    closeSidebar();
  }

  function closeSettingsPanel() {
    if (settingsPanel) {
      settingsPanel.classList.add("hidden");
    }
  }

  if (settingsBtn) {
    settingsBtn.addEventListener("click", openSettingsPanel);
  }
  if (settingsCloseBtn) {
    settingsCloseBtn.addEventListener("click", closeSettingsPanel);
  }
  if (settingsPanel) {
    settingsPanel.addEventListener("click", (e) => {
      if (e.target === settingsPanel) closeSettingsPanel();
    });
  }

  if (settingsCopyKeyBtn) {
    settingsCopyKeyBtn.addEventListener("click", () => {
      if (!settingsApiKeyInput) return;
      const key = settingsApiKeyInput.value.trim();
      copyText(key)?.then(() => {
        if (key) {
          showToast("API Key 已复制");
          const originalHtml = settingsCopyKeyBtn.innerHTML;
          settingsCopyKeyBtn.innerHTML = checkIconSvg;
          setTimeout(() => { settingsCopyKeyBtn.innerHTML = originalHtml; }, 1500);
        }
      });
    });
  }

  if (settingsSaveKeyBtn) {
    settingsSaveKeyBtn.addEventListener("click", () => {
      if (!settingsApiKeyInput) return;
      const newKey = settingsApiKeyInput.value.trim();
      if (!newKey || !newKey.startsWith("sk-")) {
        return alert("请输入有效的以sk-开头的API Key！");
      }
      if (newKey.length < 20) {
        alert("API Key长度过短，可能是无效的Key，请检查！");
        return;
      }
      apiKey = newKey;
      localStorage.setItem("dsApiKey", apiKey);
      updateStorageUsage();
      if (apiKeyInput) {
        apiKeyInput.value = apiKey;
      }
      showToast("API Key 已保存");
      closeSettingsPanel();
    });
  }

  if (settingsMemorySelect) {
    settingsMemorySelect.addEventListener("change", (e) => {
      const val = e.target.value;
      if (val === "custom") {
        if (settingsMemoryCustom) {
          settingsMemoryCustom.classList.remove("hidden");
          settingsMemoryCustom.focus();
          const customVal = parseInt(settingsMemoryCustom.value) || 10;
          settingsMemoryCustom.value = customVal;
          globalMemoryLimit = customVal.toString();
        }
      } else {
        if (settingsMemoryCustom) {
          settingsMemoryCustom.classList.add("hidden");
        }
        globalMemoryLimit = val;
      }
      localStorage.setItem("dsGlobalMemoryLimit", globalMemoryLimit);
      renderChat();
    });
  }

  if (settingsMemoryCustom) {
    settingsMemoryCustom.addEventListener("input", (e) => {
      const val = parseInt(e.target.value);
      if (!isNaN(val) && val >= 0) {
        globalMemoryLimit = val.toString();
        localStorage.setItem("dsGlobalMemoryLimit", globalMemoryLimit);
        renderChat();
      }
    });
  }

  downloadCancelBtn.addEventListener("click", closeDownloadPanel);
  downloadPanel.addEventListener("click", (e) => {
    if (e.target === downloadPanel) closeDownloadPanel();
  });
  downloadAllBtn.addEventListener("click", () => {
    if (pendingDownloadTabId) {
      exportChatToTxt(pendingDownloadTabId, 'all', includeReasoningToggle.checked);
      closeDownloadPanel();
    }
  });
  downloadAiOnlyBtn.addEventListener("click", () => {
    if (pendingDownloadTabId) {
      exportChatToTxt(pendingDownloadTabId, 'ai_only', includeReasoningToggle.checked);
      closeDownloadPanel();
    }
  });

  function saveTabs() {
    localStorage.setItem("dsTabs", JSON.stringify(tabData));
    updateStorageUsage();
  }

  function savePrompts() {
    localStorage.setItem(PROMPT_STORAGE_KEY, JSON.stringify(promptData));
    updateStorageUsage();
  }



  let isSidebarOpen = false;

  function openSidebar() {
    isSidebarOpen = true;
    sidebar.classList.remove("-translate-x-full");
    sidebarOverlay.classList.remove("opacity-0", "pointer-events-none");
    sidebarOverlay.classList.add("opacity-100", "pointer-events-auto");
  }

  function closeSidebar() {
    isSidebarOpen = false;
    sidebar.classList.add("-translate-x-full");
    sidebarOverlay.classList.remove("opacity-100", "pointer-events-auto");
    sidebarOverlay.classList.add("opacity-0", "pointer-events-none");
  }

  menuBtn.addEventListener("click", openSidebar);
  sidebarOverlay.addEventListener("click", closeSidebar);

  let touchStartX = 0;
  let touchEndX = 0;

  document.addEventListener('touchstart', e => {
    touchStartX = e.changedTouches[0].screenX;
  }, { passive: true });

  document.addEventListener('touchend', e => {
    touchEndX = e.changedTouches[0].screenX;
    handleSwipe();
  }, { passive: true });

  function handleSwipe() {
    const swipeDist = touchEndX - touchStartX;
    if (swipeDist > 50 && touchStartX < 30 && !isSidebarOpen) {
      openSidebar();
    }
    if (swipeDist < -50 && isSidebarOpen) {
      closeSidebar();
    }
  }

  saveKey.onclick = () => {
    const newKey = apiKeyInput.value.trim();
    if (!newKey || !newKey.startsWith("sk-")) {
      return alert("请输入有效的以sk-开头的API Key！");
    }
    if (newKey.length < 20) {
      alert("API Key长度过短，可能是无效的Key，请检查！");
      return;
    }
    apiKey = newKey;
    localStorage.setItem("dsApiKey", apiKey);
    updateStorageUsage();
    keyPanel.classList.add("hidden");
    showToast("API Key 已保存");
  };

  function openRenameTabPanel(tabId) {
    renamingTabId = tabId;
    renameTabInput.value = tabData.list[tabId]?.title || '';
    renameTabPanel.classList.remove('hidden');
    setTimeout(() => {
      renameTabInput.focus();
      renameTabInput.select();
    }, 30);
  }

  function closeRenameTabPanel() {
    renamingTabId = null;
    renameTabPanel.classList.add('hidden');
    renameTabInput.value = '';
  }

  function saveRenamedTab() {
    if (!renamingTabId || !tabData.list[renamingTabId]) return;
    const finalName = renameTabInput.value.trim();
    tabData.list[renamingTabId].title = finalName;
    saveTabs();
    renderTabs();
    closeRenameTabPanel();
    showToast(finalName ? '会话名称已更新' : '已恢复默认会话名称');
  }

  function showConfirmModal({ title = '确认操作', desc = '确定继续吗？', okText = '确认', cancelText = '取消' } = {}) {
    confirmTitle.textContent = title;
    confirmDesc.textContent = desc;
    confirmOkBtn.textContent = okText;
    confirmCancelBtn.textContent = cancelText;
    confirmPanel.classList.remove('hidden');

    return new Promise(resolve => {
      confirmResolve = resolve;
    });
  }

  function closeConfirmModal(result) {
    confirmPanel.classList.add('hidden');
    if (confirmResolve) {
      confirmResolve(result);
      confirmResolve = null;
    }
  }

  async function optimizePromptWithAI() {
    if (optimizeInProgress) return;
    const original = promptContentInput.value.trim();

    if (!original) {
      showToast('请先填写指令内容');
      promptContentInput.focus();
      return;
    }

    if (!apiKey) {
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
5. 不要解释，不要分析，不要加前言，不要使用标题“优化后”，只输出优化后的 prompt 正文。
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
        "Authorization": `Bearer ${apiKey}`,
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
    showToast('已替换为优化结果');
  }

  function exportChatToTxt(tabId, mode = 'all', includeReasoning = true) {
    const msgs = tabData.list[tabId].messages || [];
    if (msgs.length === 0) {
      alert("当前对话为空，无法导出。");
      return;
    }

    let txtContent = `${getTabDisplayName(tabId)} - ${new Date().toLocaleString()}\n`;
    txtContent += `==================================================\n\n`;

    msgs.forEach(m => {
      if (mode === 'ai_only' && m.role === 'user') {
        return;
      }
      
      const currentTab = tabData.list[tabId];
      const isSingleChar = currentTab && currentTab.type === 'single-character';
      const charName = isSingleChar && currentTab.characterId ? (getCharacterById(currentTab.characterId) || {}).name || 'DeepSeek' : 'DeepSeek';
      const roleName = m.role === 'user' ? '我' : (m.role === 'character' ? (m.characterName || '角色') : charName);
      txtContent += `【${roleName}】:\n`;

      if (includeReasoning && m.reasoningContent) {
        txtContent += `[思考过程]:\n${m.reasoningContent}\n\n`;
        txtContent += `[正文]:\n`;
      }

      txtContent += `${m.content}\n\n`;
      txtContent += `--------------------------------------------------\n\n`;
    });

    const blob = new Blob([txtContent], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const modeSuffix = mode === 'ai_only' ? '_AI回复' : '';
    const reasoningSuffix = includeReasoning ? '' : '_不含思考';
    const safeName = getTabDisplayName(tabId).replace(/[\\/:*?"<>|]/g, '_');
    const a = document.createElement("a");
    a.href = url;
    a.download = `${safeName}${modeSuffix}${reasoningSuffix}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function openDownloadPanel(tabId) {
    const msgs = tabData.list[tabId].messages || [];
    if (msgs.length === 0) {
      alert("当前对话为空，无法导出。");
      return;
    }
    pendingDownloadTabId = tabId;
    includeReasoningToggle.checked = true;
    downloadPanel.classList.remove("hidden");
  }

  function closeDownloadPanel() {
    downloadPanel.classList.add("hidden");
    pendingDownloadTabId = null;
  }

  // Tab DOM 缓存，避免切换 tab 时全量重渲染
  let _tabDomCache = {};

  function getCachedTabHtml(tabId) {
    return _tabDomCache[tabId] || null;
  }

  function setCachedTabHtml(tabId, html) {
    _tabDomCache[tabId] = html;
  }

  function invalidateTabCache(tabId) {
    if (tabId) {
      delete _tabDomCache[tabId];
    } else {
      _tabDomCache = {};
    }
  }

  /* ========================================================================
   * 七、Tab 标签页管理
   * ======================================================================== */

  function renderTabs() {
    tabsEl.innerHTML = "";
    const tabIds = Object.keys(tabData.list);
    if (tabIds.length === 0) {
      tabData.list = { tab1: { messages: [], title: "" } };
      tabData.active = "tab1";
      saveTabs();
    }

    Object.keys(tabData.list).forEach(id => {
      const tab = tabData.list[id];
      const isGroup = tab.type === 'group';
      const isSingleChar = tab.type === 'single-character';
      const tabDiv = document.createElement("div");
      tabDiv.className = `tab ${id === tabData.active ? "active" : ""} ${isGroup ? "group-tab" : ""} ${isSingleChar ? "char-tab" : ""}`;
      tabDiv.innerHTML = `
        <span class="tab-title" title="${escapeHtml(getTabDisplayName(id))}">${escapeHtml(getTabDisplayName(id))}</span>
        <div class="tab-actions">
          <span class="tab-btn tab-rename" data-id="${id}" title="修改会话名称">${renameIconSvg}</span>
          <span class="tab-btn tab-export" data-id="${id}" title="导出对话">${downloadIconSvg}</span>
          <span class="tab-btn tab-del" data-id="${id}" title="删除对话">×</span>
        </div>
      `;
      tabDiv.addEventListener("click", (e) => {
        if (e.target.closest('.tab-del') || e.target.closest('.tab-export') || e.target.closest('.tab-rename')) return;
        // 缓存当前 tab 的 DOM
        setCachedTabHtml(tabData.active, chat.innerHTML);
        tabData.active = id;
        saveTabs();
        // 尝试使用缓存
        const cached = getCachedTabHtml(id);
        if (cached) {
          chat.innerHTML = cached;
          rebindChatButtons();
        } else {
          renderChat();
        }
        renderTabs();
        updateInputCounter();
        if(window.innerWidth < 768) closeSidebar();
      });
      tabsEl.appendChild(tabDiv);
    });

    document.querySelectorAll(".tab-rename").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const tabId = btn.dataset.id;
        openRenameTabPanel(tabId);
      });
    });

    document.querySelectorAll(".tab-export").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const exportId = btn.dataset.id;
        openDownloadPanel(exportId);
      });
    });

    document.querySelectorAll(".tab-del").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const delId = btn.dataset.id;
        if (confirm(`确定删除「${getTabDisplayName(delId)}」吗？删除后记录将永久消失！`)) {
          delete tabData.list[delId];

          const remainingTabIds = Object.keys(tabData.list);
          if (remainingTabIds.length === 0) {
            const newId = createNewTab();
            tabData.active = newId;
            return;
          }

          if (delId === tabData.active) {
            tabData.active = remainingTabIds[0];
          }
          saveTabs();
          renderChat();
          renderTabs();
          updateInputCounter();
        }
      });
    });
  }

  function copyText(text) {
    if (!text) return alert("暂无内容可复制");
    
    // 优先使用现代剪贴板API
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(() => {
        console.log("复制成功");
      }).catch(err => {
        // 如果现代API失败，尝试兼容性方法
        fallbackCopyText(text);
      });
    } else {
      // 使用兼容性方法
      fallbackCopyText(text);
    }
  }

  function fallbackCopyText(text) {
    try {
      const textArea = document.createElement("textarea");
      textArea.value = text;
      textArea.style.position = "fixed";
      textArea.style.left = "-999999px";
      textArea.style.top = "-999999px";
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      
      const successful = document.execCommand('copy');
      textArea.remove();
      
      if (successful) {
        console.log("复制成功");
      } else {
        alert("复制失败，请手动复制！");
      }
    } catch (err) {
      alert("复制失败，请手动复制！");
      console.error("复制错误：", err);
    }
  }

  function getLastUserMessageIndex() {
    const currentMsgs = tabData.list[tabData.active].messages || [];
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

  function editUserMessage(messageIndex) {
    const currentMsgs = tabData.list[tabData.active].messages || [];
    if (messageIndex < 0 || messageIndex >= currentMsgs.length) return alert("消息索引无效。");
    const targetMessage = currentMsgs[messageIndex];
    if (targetMessage.role !== 'user') return alert("只能编辑用户消息。");

    editingMessageIndex = messageIndex;
    editTextarea.value = targetMessage.content;
    editPanel.classList.remove("hidden");
    editTextarea.focus();
  }

  function regenerateResponse(messageIndex) {
    if (!apiKey) { keyPanel.classList.remove("hidden"); return; }
    const currentMsgs = tabData.list[tabData.active].messages || [];
    if (currentMsgs.length === 0) return alert("当前对话为空，无法重新生成。");
    if (messageIndex < 0 || messageIndex >= currentMsgs.length) return alert("消息索引无效。");
    const targetMessage = currentMsgs[messageIndex];
    if (targetMessage.role !== 'assistant') return alert("只能重新生成AI的回复。");

    fetchAndStreamResponse({ regenerateIndex: messageIndex });
  }

  // Markdown 渲染缓存（内存级，避免重复解析相同内容）
  const _mdCache = new Map();
  const _MD_CACHE_MAX = 500;

  /* ========================================================================
   * 六、Markdown 渲染与搜索高亮
   * ======================================================================== */

  function renderMarkdown(el, text, msgIndex, type) {
    if (!text) {
      el.innerHTML = '';
      return;
    }
    if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') {
      el.textContent = text;
      return;
    }

    // 搜索模式下不做缓存（高亮结果与 msgIndex/type 相关）
    let safeHtml;
    if (searchQuery) {
      const textWithLineBreaks = text.replace(/\n/g, '  \n');
      const rawHtml = marked.parse(textWithLineBreaks);
      safeHtml = DOMPurify.sanitize(rawHtml);
      safeHtml = addSearchHighlightToHtml(safeHtml, msgIndex, type);
    } else {
      let cached = _mdCache.get(text);
      if (!cached) {
        const textWithLineBreaks = text.replace(/\n/g, '  \n');
        const rawHtml = marked.parse(textWithLineBreaks);
        cached = DOMPurify.sanitize(rawHtml);
        _mdCache.set(text, cached);
        if (_mdCache.size > _MD_CACHE_MAX) {
          const firstKey = _mdCache.keys().next().value;
          _mdCache.delete(firstKey);
        }
      }
      safeHtml = cached;
    }

    el.innerHTML = safeHtml;
  }

  function addSearchHighlightToHtml(html, msgIndex, type) {
    if (!searchQuery) return html;
    
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = html;
    
    function highlightTextNodes(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent;
        const regex = new RegExp(`(${escapeRegExp(searchQuery)})`, 'gi');
        if (regex.test(text)) {
          const newHtml = text.replace(regex, (match) => {
            return `<span class="search-highlight">${match}</span>`;
          });
          const newNode = document.createElement('span');
          newNode.innerHTML = newHtml;
          node.parentNode.replaceChild(newNode, node);
        }
      } else if (node.nodeType === Node.ELEMENT_NODE && 
                 node.tagName !== 'SCRIPT' && 
                 node.tagName !== 'STYLE' &&
                 node.tagName !== 'CODE' &&
                 !node.classList.contains('search-highlight')) {
        for (let i = node.childNodes.length - 1; i >= 0; i--) {
          highlightTextNodes(node.childNodes[i]);
        }
      }
    }
    
    highlightTextNodes(tempDiv);
    
    // 如果是当前搜索结果，添加动画
    if (isCurrentSearchResult(msgIndex, type)) {
      tempDiv.classList.add('search-result-active');
    }
    
    return tempDiv.innerHTML;
  }

  function countChars(text) {
    return String(text || '').replace(/\s/g, '').length;
  }

  function estimateTokensByChars(charCount) {
    return Math.ceil(charCount / 1.5);
  }

  function estimateTokensByText(text) {
    return estimateTokensByChars(countChars(text));
  }

  function buildPayloadMessages(messages, endExclusive = messages.length) {
    let payloadMsgs = messages.slice(0, endExclusive).map(m => ({
      role: m.role,
      content: m.content
    }));

    const limit = parseInt(globalMemoryLimit || "0");
    if (limit > 0 && payloadMsgs.length > limit) {
      payloadMsgs = payloadMsgs.slice(-limit);
    }

    // 单角色聊天：注入角色 system prompt
    const currentTab = tabData.list[tabData.active];
    if (currentTab && currentTab.type === 'single-character' && currentTab.characterId) {
      const char = getCharacterById(currentTab.characterId);
      if (char) {
        const systemPrompt = buildCharacterSystemPrompt(char);
        payloadMsgs.unshift({ role: "system", content: systemPrompt });
      }
    }

    return payloadMsgs;
  }

  function buildCharacterSystemPrompt(char) {
    return `你是${char.name}。
性格：${char.personality || '无特殊设定'}
背景：${char.background || '无'}
外貌：${char.appearance || '无'}
说话风格：${char.speakingStyle || '自然'}
口头禅参考（仅供参考语气，不要刻意堆砌）：${(char.catchphrases || []).join('、') || '无'}

规则：
- 你需要始终以${char.name}的身份和性格进行回复
- 保持角色一致性，不要脱离角色设定
- 用自然的对话方式回复，不要过于生硬`;
  }

  function buildUserInputMeta(messages, userIndex) {
    const currentMessage = messages[userIndex];
    if (!currentMessage || currentMessage.role !== 'user') return null;

    const payloadMsgs = buildPayloadMessages(messages, userIndex + 1);
    const inputChars = countChars(currentMessage.content);
    const inputTokens = estimateTokensByChars(inputChars);
    const historyTokens = payloadMsgs
      .slice(0, -1)
      .reduce((sum, msg) => sum + estimateTokensByText(msg.content), 0);

    return {
      inputChars,
      inputTokens,
      historyTokens,
      totalInputTokens: inputTokens + historyTokens
    };
  }

  // 绑定聊天区域内的按钮事件（供 renderChat 和缓存恢复时复用）
  /* ========================================================================
   * 八、聊天核心（渲染、发送、流式请求、群聊发送）
   * ======================================================================== */

  function rebindChatButtons() {
    document.querySelectorAll('.copy-btn').forEach(btn => {
      btn.addEventListener('click', function() {
        const index = parseInt(this.getAttribute('data-index'));
        const currentMsgs = tabData.list[tabData.active].messages || [];
        if (currentMsgs[index]) copyText(currentMsgs[index].content);

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
          invalidateTabCache(tabData.active);
          tabData.list[tabData.active].messages.splice(index, 1);
          saveTabs();
          renderChat();
        }
      });
    });

    document.querySelectorAll('.prev-version-btn').forEach(btn => {
      btn.addEventListener('click', function() {
        if (this.classList.contains('disabled')) return;
        const index = parseInt(this.getAttribute('data-index'));
        const msg = tabData.list[tabData.active].messages[index];
        if (msg.historyIndex > 0) {
          invalidateTabCache(tabData.active);
          msg.historyIndex--;
          msg.content = msg.history[msg.historyIndex].content;
          msg.reasoningContent = msg.history[msg.historyIndex].reasoningContent;
          msg.generationState = msg.history[msg.historyIndex].state || 'complete';
          saveTabs();
          renderChat();
        }
      });
    });

    document.querySelectorAll('.next-version-btn').forEach(btn => {
      btn.addEventListener('click', function() {
        if (this.classList.contains('disabled')) return;
        const index = parseInt(this.getAttribute('data-index'));
        const msg = tabData.list[tabData.active].messages[index];
        if (msg.historyIndex < msg.history.length - 1) {
          invalidateTabCache(tabData.active);
          msg.historyIndex++;
          msg.content = msg.history[msg.historyIndex].content;
          msg.reasoningContent = msg.history[msg.historyIndex].reasoningContent;
          msg.generationState = msg.history[msg.historyIndex].state || 'complete';
          saveTabs();
          renderChat();
        }
      });
    });

    // token limit 提示中的复制按钮
    const copyPromptBtn = document.querySelector('#copyPromptBtn');
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

  function renderChat() {
    const currentTab = tabData.list[tabData.active];
    const currentMsgs = currentTab.messages || [];
    const lastUserMsgIndex = getLastUserMessageIndex();
    const isGroupChat = currentTab.type === 'group';
    const isSingleCharChat = currentTab.type === 'single-character';

    // renderChat 执行全量渲染，清除当前 tab 的缓存
    invalidateTabCache(tabData.active);

    chat.innerHTML = "";

    // 群聊头部：显示参与角色
    if (isGroupChat && currentTab.characterIds) {
      const groupChars = currentTab.characterIds.map(id => getCharacterById(id)).filter(Boolean);
      if (groupChars.length > 0) {
        const headerDiv = document.createElement("div");
        headerDiv.className = "group-chat-header";
        const memberTags = groupChars.map((c, i) => {
          const color = getCharacterColor(i);
          return `<span class="group-chat-member-tag" style="background:${color}">${escapeHtml(c.name)}</span>`;
        }).join('');
        headerDiv.innerHTML = `<div class="group-chat-header-text">群聊成员</div><div class="group-chat-members">${memberTags}</div>`;
        chat.appendChild(headerDiv);
      }
    }

    // 单角色聊天头部：显示角色信息
    if (isSingleCharChat && currentTab.characterId) {
      const char = getCharacterById(currentTab.characterId);
      if (char) {
        const headerDiv = document.createElement("div");
        headerDiv.className = "group-chat-header";
        const color = getCharacterColor(0);
        const tag = `<span class="group-chat-member-tag" style="background:${color}">${escapeHtml(char.name)}</span>`;
        headerDiv.innerHTML = `<div class="group-chat-header-text">正在与角色对话</div><div class="group-chat-members">${tag}</div>`;
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
      msgBox.id = `msg-${i}`;

      if (isCharacter || isGroupAssistant) {
        // 群聊角色消息
        const charIndex = (currentTab.characterIds || []).indexOf(m.characterId);
        const color = getCharacterColor(charIndex >= 0 ? charIndex : 0);
        msgBox.className = `message-box character-msg p-3 rounded-xl bg-gray-800 mr-auto max-w-[85%] text-white`;
        msgBox.style.setProperty('border-left-color', color, 'important');

        let buttonsHtml = `<button class="delete-btn" data-index="${i}" title="删除">${deleteIconSvg}</button>`;
        buttonsHtml += `<button class="copy-btn" data-index="${i}" title="复制">${copyIconSvg}</button>`;

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
        // 单聊消息（原有逻辑）
        const isSingleCharAssistant = isSingleCharChat && isAssistant;
        msgBox.className = `message-box p-3 rounded-xl ${isUser?'bg-blue-600 ml-auto':'bg-gray-800 mr-auto'} max-w-[85%] text-white`;

        // 单角色聊天：AI 回复上方显示角色名标签
        let singleCharLabelHtml = '';
        if (isSingleCharAssistant && currentTab.characterId) {
          const char = getCharacterById(currentTab.characterId);
          if (char) {
            const color = getCharacterColor(0);
            msgBox.style.setProperty('border-left-color', color, 'important');
            msgBox.classList.add('character-msg');
            singleCharLabelHtml = `<div class="character-msg-label" style="background:${color}20;color:${color}">${escapeHtml(char.name)}</div>`;
          }
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

        msgBox.innerHTML = singleCharLabelHtml + versionHtml + buttonsHtml;

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
            const statusDiv = document.createElement('div');
            statusDiv.className = "generation-status mt-1 text-xs text-amber-400";
            statusDiv.textContent = '生成中断，可重新生成';
            msgBox.appendChild(statusDiv);
          }
        }
      }

      chat.appendChild(msgBox);
    });

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

    // 仅在用户原本就在底部时才自动滚到底，不打断用户阅读
    if (chat.scrollTop + chat.clientHeight >= chat.scrollHeight - 60) {
      chat.scrollTop = chat.scrollHeight;
    }
    setTimeout(checkScrollButton, 50);
    
    // 检查是否需要显示空对话提示
    if (currentMsgs.length === 0) {
      showEmptyChatHint();
    } else {
      hideEmptyChatHint();
    }
  }

  async function saveEditAndRegenerate() {
    const newContent = editTextarea.value.trim();
    if (!newContent) return alert("消息内容不能为空！");
    const currentTab = tabData.list[tabData.active];
    const currentMsgs = currentTab.messages || [];
    if (editingMessageIndex < 0 || editingMessageIndex >= currentMsgs.length) return alert("编辑的消息不存在。");

    // 截断该消息之后的所有消息
    const editIdx = editingMessageIndex;
    const messagesToKeep = currentMsgs.slice(0, editIdx + 1);
    messagesToKeep[editIdx].content = newContent;
    currentTab.messages = messagesToKeep;
    saveTabs();

    editPanel.classList.add("hidden");
    editingMessageIndex = -1;
    renderChat();

    // 群聊走群聊发送逻辑
    if (currentTab.type === 'group') {
      await sendGroupMessage(tabData.active, newContent);
    } else {
      if (messagesToKeep[editIdx]?.role === 'user') {
        messagesToKeep[editIdx].inputMeta = buildUserInputMeta(messagesToKeep, editIdx);
        saveTabs();
      }
      await fetchAndStreamResponse();
    }
  }

  function cancelEdit() {
    editPanel.classList.add("hidden");
    editingMessageIndex = -1;
  }

  function autoHeight() {
    input.style.height = "44px";
    const scrollH = input.scrollHeight;
    input.style.height = Math.min(Math.max(scrollH, 44), 88) + "px";
  }

  function updateInputCounter() {
    const text = input.value;
    const charCount = text.length;
    const tokenEstimate = estimateTokensByChars(charCount);
    if (charCount > 0) {
      inputCounter.textContent = `${charCount} 字 / 约 ${tokenEstimate} tokens`;
    } else {
      inputCounter.textContent = "0 字";
    }
  }

  async function generateTitleForCurrentTab() {
    const titleTabId = tabData.active;
    const currentMsgs = tabData.list[titleTabId].messages || [];
    if (currentMsgs.length < 2) return;
    
    const firstUserMsg = currentMsgs.find(m => m.role === 'user');
    if (!firstUserMsg) return;
    
    try {
      const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
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
          tabData.list[titleTabId].title = title;
          saveTabs();
          renderTabs();
        }
      }
    } catch (e) {
      console.log('生成标题失败，不影响功能', e);
    }
  }

  input.addEventListener("input", () => {
    autoHeight();
    updateInputCounter();
  });
  autoHeight();
  updateInputCounter();

  function createNewTab() {
    const tabIds = Object.keys(tabData.list);
    let maxIdNum = 0;
    tabIds.forEach(id => {
      const num = parseInt(id.replace('tab', ''), 10);
      if (num > maxIdNum) maxIdNum = num;
    });

    const newId = `tab${maxIdNum + 1}`;
    tabData.list[newId] = { messages: [], title: "" };
    tabData.active = newId;
    saveTabs();
    renderChat();
    renderTabs();
    updateInputCounter();
    
    // 新对话显示提示
    showEmptyChatHint();
    
    return newId;
  }

  function createCharacterChatTab(characterId) {
    const char = getCharacterById(characterId);
    if (!char) return;

    const tabIds = Object.keys(tabData.list);
    let maxIdNum = 0;
    tabIds.forEach(id => {
      const num = parseInt(id.replace('tab', ''), 10);
      if (num > maxIdNum) maxIdNum = num;
    });

    const newId = `tab${maxIdNum + 1}`;
    tabData.list[newId] = {
      messages: [],
      title: "",
      type: 'single-character',
      characterId: characterId
    };
    tabData.active = newId;
    saveTabs();
    renderChat();
    renderTabs();
    updateInputCounter();
    closeSidebar();
    closeCharacterPanel();
    input.focus();
    return newId;
  }

  function openCharacterSelectPanel() {
    const panel = document.getElementById('characterSelectPanel');
    const list = document.getElementById('characterSelectList');
    if (!panel || !list) return;
    list.innerHTML = '';
    characterData.forEach(char => {
      const item = document.createElement('div');
      item.className = 'character-select-item';
      item.innerHTML = `
        <div class="character-select-info">
          <div class="character-select-name">${escapeHtml(char.name)}</div>
          <div class="character-select-summary">${escapeHtml(char.summary || '暂无描述')}</div>
        </div>
      `;
      item.addEventListener('click', () => {
        panel.classList.add('hidden');
        createCharacterChatTab(char.id);
      });
      list.appendChild(item);
    });
    panel.classList.remove('hidden');
  }

  const addTabDropdown = document.getElementById("addTabDropdown");
  const addTabSingle = document.getElementById("addTabSingle");
  const addTabGroup = document.getElementById("addTabGroup");
  const addTabCharacter = document.getElementById("addTabCharacter");

  addTab.onclick = (e) => {
    e.stopPropagation();
    addTabDropdown.classList.toggle("hidden");
  };

  addTabSingle.onclick = () => {
    addTabDropdown.classList.add("hidden");
    createNewTab();
    closeSidebar();
    input.focus();
  };

  addTabGroup.onclick = () => {
    addTabDropdown.classList.add("hidden");
    openCreateGroupPanel();
  };

  addTabCharacter.onclick = () => {
    addTabDropdown.classList.add("hidden");
    if (characterData.length === 0) {
      showToast('还没有创建任何角色，请先去角色卡管理中创建角色');
      return;
    }
    if (characterData.length === 1) {
      createCharacterChatTab(characterData[0].id);
      return;
    }
    openCharacterSelectPanel();
  };

  // 点击页面其他区域关闭下拉菜单
  document.addEventListener("click", () => {
    addTabDropdown.classList.add("hidden");
  });

  async function fetchAndStreamResponse(opts = {}) {
    isSending = true;
    sendBtn.textContent = "停止";
    sendBtn.classList.add("stop-mode");

    // 锁定当前 tab，防止流式输出期间用户切换 tab 导致数据写入错误
    const lockedTabId = tabData.active;

    abortReason = null;
    abortController = new AbortController();

    // 120秒无响应自动超时
    const fetchTimeout = setTimeout(() => {
      if (abortController && !isSending) return;
      abortReason = 'timeout';
      abortController.abort();
    }, 120000);

    trackEvent('发送消息');

    const currentMsgs = tabData.list[lockedTabId].messages || [];
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

      // 单角色聊天：流式消息添加角色名标签和彩色边框
      let streamLabelHtml = '';
      const lockedTab = tabData.list[lockedTabId];
      if (lockedTab && lockedTab.type === 'single-character' && lockedTab.characterId) {
        const streamChar = getCharacterById(lockedTab.characterId);
        if (streamChar) {
          const streamColor = getCharacterColor(0);
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
      if (abortReason === "background") return true;
      if (Date.now() - lastPageHiddenAt > 6000) return false;
      const msg = String(err && err.message ? err.message : "");
      if (!msg) return true;
      return /(load failed|failed to fetch|networkerror|cancelled|canceled)/i.test(msg);
    }

    try {
      const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
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
        signal: abortController.signal
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
        if (abortReason === 'background' || abortReason === 'manual') markInterrupted();
        else if (abortReason === 'timeout') {
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
      isSending = false;
      sendBtn.textContent = "发送";
      sendBtn.classList.remove("stop-mode");
      abortController = null;
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
      tabData.list[lockedTabId].messages = currentMsgs;
      saveTabs();
      renderChat();
    }
  }

  async function sendMessage() {
    if (isSending) return;
    const text = input.value.trim();
    if (!text) { input.focus(); return; }
    if (!apiKey) { keyPanel.classList.remove("hidden"); return; }
    if (isStorageFull()) {
      alert('本地存储空间已满，无法保存新消息。请先导出重要对话，再清理过期会话后继续使用。');
      return;
    }

    const sendingTabId = tabData.active;
    const currentTab = tabData.list[sendingTabId];
    const currentMsgs = currentTab.messages || [];
    const isFirstMessage = currentMsgs.length === 0;

    // 群聊分支
    if (currentTab.type === 'group' && currentTab.characterIds && currentTab.characterIds.length > 0) {
      currentMsgs.push({ role: "user", content: text });
      tabData.list[sendingTabId].messages = currentMsgs;
      saveTabs();
      renderChat();

      input.value = "";
      autoHeight();
      updateInputCounter();

      await sendGroupMessage(sendingTabId, text);

      if (isFirstMessage && tabData.active === sendingTabId) {
        generateTitleForCurrentTab();
      }
      return;
    }

    // 单聊分支（原有逻辑）
    currentMsgs.push({ role: "user", content: text });
    currentMsgs[currentMsgs.length - 1].inputMeta = buildUserInputMeta(currentMsgs, currentMsgs.length - 1);
    tabData.list[sendingTabId].messages = currentMsgs;
    saveTabs();
    renderChat();

    input.value = "";
    autoHeight();
    updateInputCounter();
    await fetchAndStreamResponse();
    
    if (isFirstMessage && tabData.active === sendingTabId) {
      const tab = tabData.list[sendingTabId];
      if (tab.type !== 'single-character') {
        generateTitleForCurrentTab();
      }
    }
  }

  // ========== 群聊消息发送 ==========
  async function sendGroupMessage(tabId, userMessage) {
    isSending = true;
    sendBtn.textContent = "停止";
    sendBtn.classList.add("stop-mode");

    const lockedTabId = tabId;
    abortReason = null;
    abortController = new AbortController();
    const signal = abortController.signal;

    const currentTab = tabData.list[lockedTabId];
    const characters = (currentTab.characterIds || []).map(id => getCharacterById(id)).filter(Boolean);
    if (characters.length === 0) {
      isSending = false;
      sendBtn.textContent = "发送";
      sendBtn.classList.remove("stop-mode");
      return;
    }

    const currentMsgs = currentTab.messages || [];
    const history = currentMsgs;

    try {
      const replies = await orchestrateGroupChat(userMessage, characters, history, {
        signal,
        model: modelSelect.value === 'deepseek-reasoner' ? 'deepseek-reasoner' : 'deepseek-chat',
        onCharacterStart(character, idx) {
          // 创建角色消息 DOM
          const msgIndex = currentMsgs.length;
          const color = getCharacterColor(idx);
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
          // 找到该角色最新的消息 DOM 并更新
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
          // 保存角色消息到数据（不触发 renderChat，避免流式过程中 DOM 重建）
          const msgs = tabData.list[lockedTabId].messages;
          msgs.push({
            role: "character",
            characterId: character.id,
            characterName: character.name,
            content: content || '',
            generationState: abortReason ? 'interrupted' : 'complete',
            history: [{ content: content || '', reasoningContent: '', state: abortReason ? 'interrupted' : 'complete' }],
            historyIndex: 0
          });
          tabData.list[lockedTabId].messages = msgs;
          saveTabs();
        }
      });
    } catch (e) {
      if (e.name !== 'AbortError') {
        console.error('群聊发送错误:', e);
        showToast('群聊发送失败：' + e.message);
      }
    } finally {
      isSending = false;
      sendBtn.textContent = "发送";
      sendBtn.classList.remove("stop-mode");
      abortController = null;
      renderChat();
    }
  }

  /* ========================================================================
   * 九、指令管理（CRUD + AI 优化）
   * ======================================================================== */

  function openPromptPanel() {
    promptPanel.classList.remove('hidden');
    showPromptListView();
    renderPromptList();
  }

  function closePromptPanel() {
    promptPanel.classList.add('hidden');
  }

  function showPromptListView() {
    promptListView.classList.remove('hidden');
    promptFormView.classList.add('hidden');
    editingPromptId = null;
    promptTitleInput.value = '';
    promptContentInput.value = '';
  }

  function showPromptFormView(prompt = null) {
    promptListView.classList.add('hidden');
    promptFormView.classList.remove('hidden');

    if (prompt) {
      editingPromptId = prompt.id;
      promptTitleInput.value = prompt.title || '';
      promptContentInput.value = prompt.content || '';
    } else {
      editingPromptId = null;
      promptTitleInput.value = '';
      promptContentInput.value = '';
    }

    setTimeout(() => promptTitleInput.focus(), 50);
  }

  function renderPromptList() {
    promptList.innerHTML = '';

    if (!promptData.length) {
      promptList.innerHTML = `
        <div class="prompt-empty">
          <div class="text-base mb-2">还没有保存任何指令</div>
          <div class="text-sm text-gray-500">你可以新建一些常用指令，比如翻译、润色、总结、角色设定等。</div>
        </div>
      `;
      return;
    }

    promptData.forEach(item => {
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
        const item = promptData.find(p => p.id === id);
        if (!item) return;
        insertPromptToNewChat(item.content || '');
      });
    });

    document.querySelectorAll('.prompt-copy-btn').forEach(btn => {
      btn.addEventListener('click', function() {
        const id = this.dataset.id;
        const item = promptData.find(p => p.id === id);
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
        const item = promptData.find(p => p.id === id);
        if (!item) return;
        showPromptFormView(item);
      });
    });

    document.querySelectorAll('.prompt-delete-btn2').forEach(btn => {
      btn.addEventListener('click', function() {
        const id = this.dataset.id;
        const item = promptData.find(p => p.id === id);
        if (!item) return;
        if (!confirm(`确定删除指令「${item.title || '未命名指令'}」吗？`)) return;
        promptData = promptData.filter(p => p.id !== id);
        savePrompts();
        renderPromptList();
      });
    });
  }

  function insertPromptToNewChat(text) {
    if (!text) return;
    createNewTab();
    input.value = text;
    autoHeight();
    closePromptPanel();
    closeSidebar();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
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

    if (editingPromptId) {
      const idx = promptData.findIndex(p => p.id === editingPromptId);
      if (idx > -1) {
        promptData[idx].title = title;
        promptData[idx].content = content;
        promptData[idx].updatedAt = Date.now();
      }
    } else {
      promptData.unshift({
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

  openPromptManagerBtn.addEventListener('click', () => {
    closeSidebar();
    openPromptPanel();
  });

  // 角色卡侧边栏按钮
  const openCharacterBtn = document.getElementById('openCharacterBtn');
  const cancelCreateGroupBtn = document.getElementById('cancelCreateGroupBtn');
  if (openCharacterBtn) openCharacterBtn.addEventListener('click', () => { closeSidebar(); openCharacterPanel(); });
  if (cancelCreateGroupBtn) cancelCreateGroupBtn.addEventListener('click', closeCreateGroupPanel);

  closePromptPanelBtn.addEventListener('click', closePromptPanel);
  promptPanel.addEventListener('click', (e) => {
    if (e.target === promptPanel) closePromptPanel();
  });

  addPromptBtn.addEventListener('click', () => showPromptFormView());
  cancelPromptEditBtn.addEventListener('click', showPromptListView);
  savePromptBtn.addEventListener('click', savePromptItem);
  optimizePromptBtn.addEventListener('click', optimizePromptWithAI);

  renameTabCancelBtn.addEventListener('click', closeRenameTabPanel);
  renameTabSaveBtn.addEventListener('click', saveRenamedTab);
  renameTabPanel.addEventListener('click', (e) => {
    if (e.target === renameTabPanel) closeRenameTabPanel();
  });
  renameTabInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveRenamedTab();
  });

  confirmCancelBtn.addEventListener('click', () => closeConfirmModal(false));
  confirmOkBtn.addEventListener('click', () => closeConfirmModal(true));
  confirmPanel.addEventListener('click', (e) => {
    if (e.target === confirmPanel) closeConfirmModal(false);
  });

  discardOptimizedPromptBtn.addEventListener('click', closeOptimizePreviewPanel);
  applyOptimizedPromptBtn.addEventListener('click', applyOptimizedPrompt);
  promptOptimizePreviewPanel.addEventListener('click', (e) => {
    if (e.target === promptOptimizePreviewPanel) closeOptimizePreviewPanel();
  });

  sendBtn.addEventListener("click", () => {
    if (isSending) {
      abortStreaming('manual');
    } else {
      sendMessage();
    }
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (!isSending) {
        sendMessage();
      }
    }
  });

  editCancelBtn.addEventListener("click", cancelEdit);
  editSaveBtn.addEventListener("click", saveEditAndRegenerate);
  editPanel.addEventListener("click", function(e) { if (e.target === editPanel) cancelEdit(); });

  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      if (!settingsPanel.classList.contains('hidden')) closeSettingsPanel();
      if (!editPanel.classList.contains('hidden')) cancelEdit();
      if (!renameTabPanel.classList.contains('hidden')) closeRenameTabPanel();
      if (!confirmPanel.classList.contains('hidden')) closeConfirmModal(false);
      if (!promptOptimizePreviewPanel.classList.contains('hidden')) closeOptimizePreviewPanel();
      if (!promptPanel.classList.contains('hidden')) closePromptPanel();
      if (characterPanel && !characterPanel.classList.contains('hidden')) closeCharacterPanel();
      if (createGroupPanel && !createGroupPanel.classList.contains('hidden')) closeCreateGroupPanel();
      if (characterSelectPanel && !characterSelectPanel.classList.contains('hidden')) characterSelectPanel.classList.add('hidden');
      if (!infoPanel.classList.contains('hidden')) infoPanel.classList.add('hidden');
      if (!donatePanel.classList.contains('hidden')) donatePanel.classList.add('hidden');
      if (!downloadPanel.classList.contains('hidden')) closeDownloadPanel();
    }
  });

  scrollToBottomBtn.addEventListener("click", scrollToBottom);
  chat.addEventListener("scroll", checkScrollButton);

  // 指令市场预设指令从 prompts.js 加载
  // MARKET_PROMPTS 在 prompts.js 中定义，如果加载失败则使用空数组
  if (typeof MARKET_PROMPTS === 'undefined') {
    window.MARKET_PROMPTS = [];
  }

  // 从 prompts.js 加载指令（已在页面中引入，此函数保留用于兼容性）
  /* ========================================================================
   * 十、指令市场与 AI 生成
   * ======================================================================== */

  async function loadPromptsFromFile() {
    // 数据已在 prompts.js 中定义
    return;
  }

  // 指令市场相关元素
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

  let currentMarketPrompt = null;
  let lastShownPromptIndex = -1;

  // 空对话提示相关元素
  const emptyChatHint = document.getElementById('emptyChatHint');
  const openMarketFromHint = document.getElementById('openMarketFromHint');

  // 显示/隐藏空对话提示
  function showEmptyChatHint() {
    emptyChatHint.classList.remove('hidden');
  }

  function hideEmptyChatHint() {
    emptyChatHint.classList.add('hidden');
  }



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
      showToast('指令内容不能为空');
      return;
    }
    
    const title = generatePromptTitle(content);
    
    promptData.unshift({
      id: 'prompt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      title: title,
      content: content,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    
    savePrompts();
    showToast('已保存到指令管理');
  }

  // 新建对话并插入指令
  function createChatWithMarketPrompt() {
    const content = promptMarketContent.value.trim();
    if (!content) {
      showToast('指令内容不能为空');
      return;
    }
    
    createNewTab();
    input.value = content;
    autoHeight();
    closePromptMarketPanel();
    closeSidebar();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

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

  // 事件监听
  openPromptMarketBtn.addEventListener('click', () => {
    closeSidebar();
    openPromptMarketPanel();
  });

  // 空对话提示点击打开指令市场
  openMarketFromHint.addEventListener('click', () => {
    openPromptMarketPanel();
  });

  closePromptMarketBtn.addEventListener('click', closePromptMarketPanel);
  promptMarketPanel.addEventListener('click', (e) => {
    if (e.target === promptMarketPanel) closePromptMarketPanel();
  });

  refreshPromptMarketBtn.addEventListener('click', refreshMarketPrompt);
  saveToPromptManagerBtn.addEventListener('click', saveCurrentPromptToManager);
  createChatWithPromptBtn.addEventListener('click', createChatWithMarketPrompt);

  // ESC键关闭
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      if (!promptMarketPanel.classList.contains('hidden')) closePromptMarketPanel();
      if (!aiGeneratePromptPanel.classList.contains('hidden')) closeAiGeneratePanel();
    }
  });

  // 智能生成指令相关函数
  function openAiGeneratePanel() {
    aiPromptInput.value = '';
    aiGeneratePromptPanel.classList.remove('hidden');
    setTimeout(() => aiPromptInput.focus(), 50);
  }

  function closeAiGeneratePanel() {
    aiGeneratePromptPanel.classList.add('hidden');
  }

  async function generatePromptWithAI() {
    const userInput = aiPromptInput.value.trim();
    if (!userInput) {
      alert('请输入关键词或描述');
      aiPromptInput.focus();
      return;
    }

    if (!apiKey) {
      keyPanel.classList.remove("hidden");
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

      showToast('指令生成成功！');
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
        "Authorization": `Bearer ${apiKey}`,
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

  // 智能生成指令事件监听
  aiGeneratePromptBtn.addEventListener('click', openAiGeneratePanel);
  closeAiGenerateBtn.addEventListener('click', closeAiGeneratePanel);
  cancelAiGenerateBtn.addEventListener('click', closeAiGeneratePanel);
  aiGeneratePromptPanel.addEventListener('click', (e) => {
    if (e.target === aiGeneratePromptPanel) closeAiGeneratePanel();
  });
  confirmAiGenerateBtn.addEventListener('click', generatePromptWithAI);

  // ========== 搜索功能实现 ==========
  
  /* ========================================================================
   * 十一、搜索功能
   * ======================================================================== */

  function openSearch() {
    appTitle.classList.add('hidden');
    searchBox.classList.remove('hidden');
    searchInput.value = searchQuery;
    document.body.classList.add('search-active');
    setTimeout(() => searchInput.focus(), 50);
  }

  function closeSearch() {
    appTitle.classList.remove('hidden');
    searchBox.classList.add('hidden');
    searchResultsInfo.classList.add('hidden');
    document.body.classList.remove('search-active');
    searchQuery = '';
    searchResults = [];
    currentSearchIndex = -1;
    renderChat();
  }

  function performSearch(query) {
    searchQuery = query.trim().toLowerCase();
    searchResults = [];
    currentSearchIndex = -1;
    invalidateTabCache(); // 搜索会改变 DOM 高亮，清除所有缓存

    if (!searchQuery) {
      searchResultsInfo.classList.add('hidden');
      renderChat();
      return;
    }

    const currentMsgs = tabData.list[tabData.active].messages || [];
    
    currentMsgs.forEach((msg, msgIndex) => {
      const content = msg.content.toLowerCase();
      const reasoning = (msg.reasoningContent || '').toLowerCase();
      
      if (content.includes(searchQuery)) {
        searchResults.push({
          msgIndex,
          type: 'content',
          text: msg.content
        });
      }
      
      if (reasoning.includes(searchQuery)) {
        searchResults.push({
          msgIndex,
          type: 'reasoning',
          text: msg.reasoningContent
        });
      }
    });

    document.body.classList.add('search-active');
    if (searchResults.length > 0) {
      currentSearchIndex = 0;
      updateSearchResultsInfo();
      searchResultsInfo.classList.remove('hidden');
      renderChat();
      scrollToCurrentSearchResult();
    } else {
      searchResultsText.textContent = '未找到匹配结果';
      searchResultsInfo.classList.remove('hidden');
      renderChat();
    }
  }

  function updateSearchResultsInfo() {
    if (searchResults.length > 0) {
      searchResultsText.textContent = `${currentSearchIndex + 1} / ${searchResults.length} 个结果`;
    }
  }

  function scrollToCurrentSearchResult() {
    if (currentSearchIndex < 0 || currentSearchIndex >= searchResults.length) return;
    
    const result = searchResults[currentSearchIndex];
    const msgEl = document.getElementById(`msg-${result.msgIndex}`);
    
    if (msgEl) {
      msgEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  function prevSearchResultHandler() {
    if (searchResults.length === 0) return;
    
    currentSearchIndex--;
    if (currentSearchIndex < 0) {
      currentSearchIndex = searchResults.length - 1;
    }
    
    updateSearchResultsInfo();
    renderChat();
    scrollToCurrentSearchResult();
  }

  function nextSearchResultHandler() {
    if (searchResults.length === 0) return;
    
    currentSearchIndex++;
    if (currentSearchIndex >= searchResults.length) {
      currentSearchIndex = 0;
    }
    
    updateSearchResultsInfo();
    renderChat();
    scrollToCurrentSearchResult();
  }

  function highlightSearchText(text) {
    if (!searchQuery) return escapeHtml(text);
    
    const regex = new RegExp(`(${escapeRegExp(searchQuery)})`, 'gi');
    return escapeHtml(text).replace(regex, (match) => {
      return `<span class="search-highlight">${match}</span>`;
    });
  }

  function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function isCurrentSearchResult(msgIndex, type) {
    if (currentSearchIndex < 0 || currentSearchIndex >= searchResults.length) return false;
    const result = searchResults[currentSearchIndex];
    return result.msgIndex === msgIndex && result.type === type;
  }

  // 搜索功能事件监听
  searchToggleBtn.addEventListener('click', openSearch);
  closeSearchBtn.addEventListener('click', closeSearch);
  
  searchInput.addEventListener('input', (e) => {
    performSearch(e.target.value);
  });

  prevSearchResult.addEventListener('click', prevSearchResultHandler);
  nextSearchResult.addEventListener('click', nextSearchResultHandler);

  // Ctrl+F 快捷键打开搜索
  document.addEventListener('keydown', function(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      openSearch();
    }
  });

  // ESC 键关闭搜索
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && !searchBox.classList.contains('hidden')) {
      e.preventDefault();
      closeSearch();
    }
  });

  /* ========================================================================
   * 十二、初始化与全局事件
   * ======================================================================== */

  // 页面加载时预加载指令
  loadPromptsFromFile();

  renderTabs();
  renderChat();
  setTimeout(checkScrollButton, 100);
  input.focus();
  } catch (e) {
    console.error('MyDeepSeek 初始化失败:', e);
    try {
      const raw = localStorage.getItem("dsTabs");
      const parsed = JSON.parse(raw);
      if (parsed && parsed.list && typeof parsed.list === 'object') {
        Object.keys(parsed.list).forEach(function(id) {
          const tab = parsed.list[id];
          if (Array.isArray(tab)) {
            parsed.list[id] = { messages: tab, memoryLimit: "0", title: "" };
          } else {
            tab.messages = Array.isArray(tab.messages) ? tab.messages : [];
            tab.memoryLimit = tab.memoryLimit || "0";
            tab.title = tab.title || "";
            tab.messages.forEach(function(msg) {
              if (!msg.role) msg.role = 'user';
              if (!msg.content) msg.content = '';
              if (msg.history && typeof msg.history[0] === 'string') {
                msg.history = msg.history.map(function(c) { return { content: c, reasoningContent: "" }; });
              }
              if (msg.historyIndex === undefined) msg.historyIndex = 0;
              if (!msg.generationState) msg.generationState = 'complete';
            });
          }
        });
        if (parsed.active && !parsed.list[parsed.active]) {
          const firstKey = Object.keys(parsed.list)[0];
          if (firstKey) parsed.active = firstKey;
        }
        localStorage.setItem("dsTabs", JSON.stringify(parsed));
        location.reload();
      } else {
        throw new Error('tabData 结构无效');
      }
    } catch (repairErr) {
      console.error('数据修复失败，执行重置:', repairErr);
      localStorage.removeItem("dsTabs");
      location.reload();
    }
  }
});
