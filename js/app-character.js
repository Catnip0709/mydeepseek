// app-character.js - 角色卡管理
(function() {
  'use strict';
  const App = window.App;

  // ========== 获取 DOM 元素 ==========
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
  const cancelCharacterEditBtn = document.getElementById('cancelCharacterEditBtn');
  const saveCharacterBtn = document.getElementById('saveCharacterBtn');
  const closeCharacterEditPanelBtn = document.getElementById('closeCharacterEditPanelBtn');
  const openCharacterBtn = document.getElementById('openCharacterBtn');

  // ========== 数据操作函数 ==========

  App.getCharacterById = function(id) {
    return App.characterData.find(c => c.id === id) || null;
  };

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
    App.characterData.push(character);
    App.saveCharacters();
    return character;
  }

  function updateCharacter(id, data) {
    const idx = App.characterData.findIndex(c => c.id === id);
    if (idx === -1) return null;
    Object.assign(App.characterData[idx], data, { updatedAt: Date.now() });
    App.saveCharacters();
    return App.characterData[idx];
  }

  function deleteCharacter(id) {
    App.characterData = App.characterData.filter(c => c.id !== id);
    App.saveCharacters();
  }

  // ========== AI 增强 ==========

  async function aiEnhanceCharacter(brief) {
    if (!App.apiKey) { App.openSettingsPanel(); return null; }
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
    const result = await App.callLLMJSON({ messages, temperature: 0.8, maxTokens: 1500 });
    return result;
  }

  // ========== UI 函数 ==========

  function openCharacterPanel() {
    characterPanel.classList.remove('hidden');
    renderCharacterList();
  }

  function closeCharacterPanel() {
    characterPanel.classList.add('hidden');
  }

  function renderCharacterList() {
    characterListEl.innerHTML = '';
    if (!App.characterData.length) {
      characterListEl.innerHTML = '<div class="prompt-empty"><div class="text-base mb-2">还没有创建任何角色</div><div class="text-sm text-gray-500">点击下方按钮创建角色卡，或用 AI 智能生成。</div></div>';
      return;
    }
    App.characterData.forEach(char => {
      const div = document.createElement('div');
      div.className = 'character-item';
      div.innerHTML = `
        <div class="character-item-header">
          <div class="flex-1 min-w-0">
            <div class="character-name">${App.escapeHtml(char.name)}</div>
            <div class="character-summary">${App.escapeHtml(char.summary || '暂无描述')}</div>
          </div>
          <div class="character-actions">
            <button class="prompt-icon-btn character-edit-btn" data-id="${char.id}" title="编辑">${App.icons.edit}</button>
            <button class="prompt-icon-btn character-delete-btn delete" data-id="${char.id}" title="删除">${App.icons.delete}</button>
          </div>
        </div>
      `;
      characterListEl.appendChild(div);
    });

    document.querySelectorAll('.character-edit-btn').forEach(btn => {
      btn.addEventListener('click', function() {
        const char = App.getCharacterById(this.dataset.id);
        if (char) showCharacterEditForm(char);
      });
    });

    document.querySelectorAll('.character-delete-btn').forEach(btn => {
      btn.addEventListener('click', function() {
        const char = App.getCharacterById(this.dataset.id);
        if (!char) return;
        if (!confirm('确定删除角色「' + char.name + '」吗？')) return;
        deleteCharacter(char.id);
        renderCharacterList();
        App.showToast('角色已删除');
      });
    });
  }

  function showCharacterEditForm(char = null) {
    characterEditPanel.classList.remove('hidden');
    if (char) {
      App.editingCharacterId = char.id;
      characterEditName.value = char.name || '';
      characterEditSummary.value = char.summary || '';
      characterEditPersonality.value = char.personality || '';
      characterEditBackground.value = char.background || '';
      characterEditAppearance.value = char.appearance || '';
      characterEditSpeakingStyle.value = char.speakingStyle || '';
      characterEditCatchphrases.value = (char.catchphrases || []).join('、');
      characterEditBrief.value = '';
    } else {
      App.editingCharacterId = null;
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
    App.editingCharacterId = null;
  }

  async function handleAiEnhance() {
    const brief = characterEditBrief.value.trim();
    if (!brief) { App.showToast('请先输入简要描述'); characterEditBrief.focus(); return; }
    if (!App.apiKey) { App.openSettingsPanel(); return; }

    const oldHtml = aiEnhanceBtn.innerHTML;
    aiEnhanceBtn.disabled = true;
    aiEnhanceBtn.innerHTML = '<div class="loading-spinner"></div> 生成中...';

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
      App.showToast('角色卡已生成');
    } catch (e) {
      console.error(e);
      alert('AI 生成失败：' + e.message);
    } finally {
      aiEnhanceBtn.disabled = false;
      aiEnhanceBtn.innerHTML = oldHtml;
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

    if (App.editingCharacterId) {
      updateCharacter(App.editingCharacterId, data);
      App.showToast('角色已更新');
    } else {
      createCharacter(data);
      App.showToast('角色已创建');
    }
    hideCharacterEditForm();
    renderCharacterList();
  }

  // ========== 注册到 App ==========
  App.getCharacterColor = function(index) {
    return App.CHARACTER_COLORS[index % App.CHARACTER_COLORS.length];
  };

  App.openCharacterPanel = openCharacterPanel;
  App.closeCharacterPanel = closeCharacterPanel;

  // ========== 事件绑定 ==========

  // 关闭角色卡面板
  if (closeCharacterPanelBtn) closeCharacterPanelBtn.addEventListener('click', closeCharacterPanel);
  if (characterPanel) characterPanel.addEventListener('click', function(e) { if (e.target === characterPanel) closeCharacterPanel(); });

  // 侧边栏打开角色卡按钮
  if (openCharacterBtn) openCharacterBtn.addEventListener('click', function() { App.closeSidebar(); openCharacterPanel(); });

  // 添加角色
  if (addCharacterBtn) addCharacterBtn.addEventListener('click', function() { showCharacterEditForm(); });

  // 取消编辑
  if (cancelCharacterEditBtn) cancelCharacterEditBtn.addEventListener('click', hideCharacterEditForm);

  // 关闭编辑面板
  if (closeCharacterEditPanelBtn) closeCharacterEditPanelBtn.addEventListener('click', hideCharacterEditForm);
  if (characterEditPanel) characterEditPanel.addEventListener('click', function(e) { if (e.target === characterEditPanel) hideCharacterEditForm(); });

  // 保存角色
  if (saveCharacterBtn) saveCharacterBtn.addEventListener('click', saveCharacterForm);

  // AI 增强
  if (aiEnhanceBtn) aiEnhanceBtn.addEventListener('click', handleAiEnhance);
})();
