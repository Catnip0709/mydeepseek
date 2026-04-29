/**
 * character.js — 角色卡管理模块
 *
 * 负责角色卡的 CRUD、AI 增强、面板管理、角色选择面板等。
 */

import { state, CHARACTER_COLORS } from './state.js';
import { escapeHtml, editIconSvg, deleteIconSvg } from './utils.js';
import { saveCharacters, getTabDisplayName, saveTabs, generateNewTabId } from './storage.js';
import { callLLMJSON } from './llm.js';
import { showToast, closeSidebar } from './panels.js';
import { call as coreCall } from './core.js';

// ========== 角色 CRUD ==========

export function getCharacterById(id) {
  return state.characterData.find(c => c.id === id) || null;
}

export function getCharacterColor(index) {
  return CHARACTER_COLORS[index % CHARACTER_COLORS.length];
}

export function createCharacter(data) {
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
    talkativeness: data.talkativeness ?? 0.8,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  state.characterData.push(character);
  saveCharacters();
  return character;
}

export function updateCharacter(id, data) {
  const idx = state.characterData.findIndex(c => c.id === id);
  if (idx === -1) return null;
  Object.assign(state.characterData[idx], data, { updatedAt: Date.now() });
  saveCharacters();
  return state.characterData[idx];
}

export function deleteCharacter(id) {
  state.characterData = state.characterData.filter(c => c.id !== id);
  saveCharacters();
}

export function findCharacterRefs(charId, charName) {
  const refs = [];
  const list = state.tabData.list;
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

// ========== AI 增强 ==========

export async function aiEnhanceCharacter(brief) {
  const keyPanel = document.getElementById('keyPanel');
  if (!state.apiKey) { keyPanel.classList.remove("hidden"); return null; }
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
  const result = await callLLMJSON({ model: state.selectedModel, messages, temperature: 0.8, maxTokens: 1500 });
  return result;
}

// ========== 角色卡面板管理 ==========

export function openCharacterPanel() {
  const characterPanel = document.getElementById('characterPanel');
  characterPanel.classList.remove('hidden');
  renderCharacterList();
}

export function closeCharacterPanel() {
  const characterPanel = document.getElementById('characterPanel');
  characterPanel.classList.add('hidden');
}

export function renderCharacterList() {
  const characterListEl = document.getElementById('characterList');
  characterListEl.innerHTML = '';
  if (!state.characterData.length) {
    characterListEl.innerHTML = '<div class="prompt-empty"><div class="text-base mb-2">还没有创建任何角色</div><div class="text-sm text-gray-500">点击下方按钮创建角色卡，或用 AI 智能生成。</div></div>';
    return;
  }
  state.characterData.forEach(char => {
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
        <button class="prompt-icon-btn character-edit-btn" data-id="${char.id}" title="编辑">${editIconSvg}</button>
        <button class="prompt-icon-btn character-delete-btn delete" data-id="${char.id}" title="删除">${deleteIconSvg}</button>
      </div>
    `;
    characterListEl.appendChild(div);
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

// ========== 角色编辑表单 ==========

export function showCharacterEditForm(char = null) {
  const characterEditPanel = document.getElementById('characterEditPanel');
  const characterEditName = document.getElementById('characterEditName');
  const characterEditSummary = document.getElementById('characterEditSummary');
  const characterEditPersonality = document.getElementById('characterEditPersonality');
  const characterEditBackground = document.getElementById('characterEditBackground');
  const characterEditAppearance = document.getElementById('characterEditAppearance');
  const characterEditSpeakingStyle = document.getElementById('characterEditSpeakingStyle');
  const characterEditCatchphrases = document.getElementById('characterEditCatchphrases');
  const characterEditTalkativeness = document.getElementById('characterEditTalkativeness');
  const characterEditTalkativenessVal = document.getElementById('characterEditTalkativenessVal');
  const characterEditBrief = document.getElementById('characterEditBrief');

  characterEditPanel.classList.remove('hidden');
  if (char) {
    state.editingCharacterId = char.id;
    characterEditName.value = char.name || '';
    characterEditSummary.value = char.summary || '';
    characterEditPersonality.value = char.personality || '';
    characterEditBackground.value = char.background || '';
    characterEditAppearance.value = char.appearance || '';
    characterEditSpeakingStyle.value = char.speakingStyle || '';
    characterEditCatchphrases.value = (char.catchphrases || []).join('、');
    const talkVal = char.talkativeness ?? 0.8;
    characterEditTalkativeness.value = talkVal;
    characterEditTalkativenessVal.textContent = talkVal.toFixed(1);
    characterEditBrief.value = '';
  } else {
    state.editingCharacterId = null;
    characterEditName.value = '';
    characterEditSummary.value = '';
    characterEditPersonality.value = '';
    characterEditBackground.value = '';
    characterEditAppearance.value = '';
    characterEditSpeakingStyle.value = '';
    characterEditCatchphrases.value = '';
    characterEditTalkativeness.value = 0.8;
    characterEditTalkativenessVal.textContent = '0.8';
    characterEditBrief.value = '';
  }
  setTimeout(() => characterEditName.focus(), 50);
}

export function hideCharacterEditForm() {
  const characterEditPanel = document.getElementById('characterEditPanel');
  characterEditPanel.classList.add('hidden');
  state.editingCharacterId = null;
}

export async function handleAiEnhance() {
  const characterEditBrief = document.getElementById('characterEditBrief');
  const aiEnhanceBtn = document.getElementById('aiEnhanceBtn');
  const aiEnhanceLabel = document.getElementById('aiEnhanceLabel');
  const keyPanel = document.getElementById('keyPanel');

  const brief = characterEditBrief.value.trim();
  if (!brief) { showToast('请先输入简要描述'); characterEditBrief.focus(); return; }
  if (!state.apiKey) { keyPanel.classList.remove("hidden"); return; }

  aiEnhanceBtn.disabled = true;
  if (aiEnhanceLabel) aiEnhanceLabel.textContent = '生成中';
  const aiBtnContainer = aiEnhanceBtn.closest('.character-brief-ai-btn');
  if (aiBtnContainer) aiBtnContainer.classList.add('ai-generating');

  try {
    const result = await aiEnhanceCharacter(brief);
    if (!result) throw new Error('AI 未返回有效结果');
    const characterEditName = document.getElementById('characterEditName');
    const characterEditSummary = document.getElementById('characterEditSummary');
    const characterEditPersonality = document.getElementById('characterEditPersonality');
    const characterEditBackground = document.getElementById('characterEditBackground');
    const characterEditAppearance = document.getElementById('characterEditAppearance');
    const characterEditSpeakingStyle = document.getElementById('characterEditSpeakingStyle');
    const characterEditCatchphrases = document.getElementById('characterEditCatchphrases');

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
    if (aiBtnContainer) aiBtnContainer.classList.remove('ai-generating');
  }
}

export function saveCharacterForm() {
  const characterEditName = document.getElementById('characterEditName');
  const characterEditSummary = document.getElementById('characterEditSummary');
  const characterEditPersonality = document.getElementById('characterEditPersonality');
  const characterEditBackground = document.getElementById('characterEditBackground');
  const characterEditAppearance = document.getElementById('characterEditAppearance');
  const characterEditSpeakingStyle = document.getElementById('characterEditSpeakingStyle');
  const characterEditCatchphrases = document.getElementById('characterEditCatchphrases');
  const characterEditTalkativeness = document.getElementById('characterEditTalkativeness');

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
    catchphrases,
    talkativeness: parseFloat(characterEditTalkativeness.value) ?? 0.8
  };

  if (state.editingCharacterId) {
    updateCharacter(state.editingCharacterId, data);
    showToast('角色已更新');
  } else {
    createCharacter(data);
    showToast('角色已创建');
  }
  hideCharacterEditForm();
  renderCharacterList();
}

// ========== 创建角色对话 Tab ==========

export function createCharacterChatTab(characterId) {
  const char = getCharacterById(characterId);
  if (!char) return;

  coreCall('clearPendingTextAttachment');
  const newId = generateNewTabId();
  state.tabData.list[newId] = {
    messages: [],
    title: "",
    type: 'single-character',
    characterId: characterId,
    storyArchive: null
  };
  state.tabData.active = newId;
  saveTabs();
  coreCall('renderChat');
  coreCall('renderTabs');
  coreCall('updateInputCounter');
  closeSidebar();
  closeCharacterPanel();
  const input = document.getElementById("input");
  if (input) input.focus();
  return newId;
}

// ========== 角色选择面板 ==========

export function openCharacterSelectPanel() {
  const panel = document.getElementById('characterSelectPanel');
  const list = document.getElementById('characterSelectList');
  if (!panel || !list) return;
  list.innerHTML = '';
  state.characterData.forEach(char => {
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

// ========== 角色卡事件绑定 ==========

export function bindCharacterEvents() {
  const closeCharacterPanelBtn = document.getElementById('closeCharacterPanelBtn');
  const characterPanel = document.getElementById('characterPanel');
  const addCharacterBtn = document.getElementById('addCharacterBtn');
  const cancelCharacterEditBtn = document.getElementById('cancelCharacterEditBtn');
  const saveCharacterBtn = document.getElementById('saveCharacterBtn');
  const closeCharacterEditPanelBtn = document.getElementById('closeCharacterEditPanelBtn');
  const characterEditPanel = document.getElementById('characterEditPanel');
  const aiEnhanceBtn = document.getElementById('aiEnhanceBtn');
  const openCharacterBtn = document.getElementById('openCharacterBtn');

  if (closeCharacterPanelBtn) closeCharacterPanelBtn.addEventListener('click', closeCharacterPanel);
  if (characterPanel) characterPanel.addEventListener('click', (e) => { if (e.target === characterPanel) closeCharacterPanel(); });
  if (addCharacterBtn) addCharacterBtn.addEventListener('click', () => showCharacterEditForm());
  if (cancelCharacterEditBtn) cancelCharacterEditBtn.addEventListener('click', hideCharacterEditForm);
  if (closeCharacterEditPanelBtn) closeCharacterEditPanelBtn.addEventListener('click', hideCharacterEditForm);
  if (characterEditPanel) characterEditPanel.addEventListener('click', (e) => { if (e.target === characterEditPanel) hideCharacterEditForm(); });
  if (saveCharacterBtn) saveCharacterBtn.addEventListener('click', saveCharacterForm);
  if (aiEnhanceBtn) aiEnhanceBtn.addEventListener('click', handleAiEnhance);
  if (openCharacterBtn) openCharacterBtn.addEventListener('click', () => { closeSidebar(); openCharacterPanel(); });

  // 活跃度滑块实时更新数值
  const talkSlider = document.getElementById('characterEditTalkativeness');
  const talkVal = document.getElementById('characterEditTalkativenessVal');
  if (talkSlider && talkVal) {
    talkSlider.addEventListener('input', () => {
      talkVal.textContent = parseFloat(talkSlider.value).toFixed(1);
    });
  }
}
