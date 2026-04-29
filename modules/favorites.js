import { state } from './state.js';
import { saveFavorites, saveTabs, getTabDisplayName } from './storage.js';
import { closeSidebar, showToast } from './panels.js';
import { escapeHtml, generateFavoriteId } from './utils.js';
import { call as coreCall } from './core.js';

const FAVORITE_HIGHLIGHT_CLASS = 'favorite-target-highlight';
const FAVORITE_HIGHLIGHT_MS = 1800;
let currentPreviewFavoriteId = null;

function getFavoritesPanelElements() {
  return {
    panel: document.getElementById('favoritesPanel'),
    list: document.getElementById('favoritesList'),
    previewPanel: document.getElementById('favoritePreviewPanel'),
    previewContent: document.getElementById('favoritePreviewContent'),
    previewMeta: document.getElementById('favoritePreviewMeta')
  };
}

export function canFavoriteMessage(message) {
  if (!message || typeof message !== 'object') return false;
  if (message.isNarration) return false;
  return message.role === 'user' || message.role === 'assistant' || message.role === 'character';
}

function findMessageById(tabId, messageId) {
  const tab = state.tabData.list[tabId];
  if (!tab || !Array.isArray(tab.messages)) return null;
  const index = tab.messages.findIndex(msg => msg && msg.id === messageId);
  if (index < 0) return null;
  return { tab, message: tab.messages[index], index };
}

function getFavoriteIndex(tabId, messageId) {
  return state.favoriteData.findIndex(item => item.tabId === tabId && item.messageId === messageId);
}

function getMessagePreview(message) {
  const text = getMessageDisplayText(message).replace(/\s+/g, ' ').trim();
  if (!text) return '（空内容）';
  return text.length > 180 ? `${text.slice(0, 180)}...` : text;
}

function getMessageDisplayText(message) {
  if (!message || typeof message !== 'object') return '';
  if (message.role === 'user' && message.fileAttachment) {
    const fileName = String(message.fileAttachment.fileName || '已上传文件').trim();
    const fileMode = message.fileAttachment.mode === 'summary' ? '摘要发送' : '全文发送';
    const question = String(message.userQuestion || message.content || '').trim();
    return question
      ? `${question}\n\n[TXT附件：${fileName}，${fileMode}]`
      : `[TXT附件：${fileName}，${fileMode}]`;
  }
  return String(message.content || '').trim();
}

function getMessageIdentityLabel(tab, message) {
  if (message.role === 'user') return '用户';
  if (message.role === 'character') {
    return message.characterName || message.name || '角色';
  }
  if (tab?.type === 'single-character' && tab.characterId) {
    const character = state.characterData.find(item => item.id === tab.characterId);
    return character?.name || '角色';
  }
  return 'AI';
}

function resolveFavoriteItem(item) {
  const resolved = findMessageById(item.tabId, item.messageId);
  if (!resolved) return null;
  return {
    ...item,
    tab: resolved.tab,
    message: resolved.message,
    messageIndex: resolved.index,
    tabName: getTabDisplayName(item.tabId),
    identityLabel: getMessageIdentityLabel(resolved.tab, resolved.message),
    preview: getMessagePreview(resolved.message)
  };
}

function pruneInvalidFavorites() {
  const before = state.favoriteData.length;
  state.favoriteData = state.favoriteData.filter(item => !!resolveFavoriteItem(item));
  if (state.favoriteData.length !== before) {
    saveFavorites();
    return true;
  }
  return false;
}

function applyFavoriteButtonState(button, isFavorited) {
  if (!button) return;
  button.classList.toggle('favorited', !!isFavorited);
  button.title = isFavorited ? '取消收藏' : '收藏';
}

function syncFavoriteStateToChat(tabId, messageIds = [], options = {}) {
  if (!tabId || state.tabData.active !== tabId) return;
  const ids = Array.isArray(messageIds)
    ? messageIds.filter(Boolean)
    : (messageIds ? [messageIds] : []);

  if (options.forceRender || ids.length === 0) {
    coreCall('renderChat');
    return;
  }

  let updatedCount = 0;
  ids.forEach(messageId => {
    const selector = `[data-message-id="${CSS.escape(messageId)}"] .favorite-btn`;
    const buttons = document.querySelectorAll(selector);
    const isFavorited = isMessageFavorited(tabId, messageId);
    buttons.forEach(button => {
      applyFavoriteButtonState(button, isFavorited);
      updatedCount++;
    });
  });

  if (updatedCount === 0) {
    coreCall('renderChat');
  }
}

export function isMessageFavorited(tabId, messageId) {
  return getFavoriteIndex(tabId, messageId) >= 0;
}

export function toggleFavoriteForMessage(tabId, message) {
  if (!tabId || !message?.id || !canFavoriteMessage(message)) return false;
  const favoriteIndex = getFavoriteIndex(tabId, message.id);
  if (favoriteIndex >= 0) {
    state.favoriteData.splice(favoriteIndex, 1);
    saveFavorites();
    renderFavoritesPanel();
    syncFavoriteStateToChat(tabId, message.id);
    showToast('已取消收藏');
    return false;
  }

  state.favoriteData.unshift({
    id: generateFavoriteId(),
    tabId,
    messageId: message.id,
    createdAt: Date.now()
  });
  saveFavorites();
  renderFavoritesPanel();
  syncFavoriteStateToChat(tabId, message.id);
  showToast('已收藏');
  return true;
}

export function removeFavoriteById(favoriteId, options = {}) {
  const { silent = false } = options;
  const removedItem = state.favoriteData.find(item => item.id === favoriteId) || null;
  const before = state.favoriteData.length;
  state.favoriteData = state.favoriteData.filter(item => item.id !== favoriteId);
  if (state.favoriteData.length !== before) {
    saveFavorites();
    renderFavoritesPanel();
    if (currentPreviewFavoriteId === favoriteId) closeFavoritePreviewPanel();
    syncFavoriteStateToChat(removedItem?.tabId, removedItem?.messageId);
    if (!silent) showToast('已移除收藏');
  }
}

export function removeFavoritesForMessageIds(tabId, messageIds = [], options = {}) {
  const ids = new Set((Array.isArray(messageIds) ? messageIds : []).filter(Boolean));
  if (!tabId || ids.size === 0) return 0;
  const before = state.favoriteData.length;
  state.favoriteData = state.favoriteData.filter(item => !(item.tabId === tabId && ids.has(item.messageId)));
  const removed = before - state.favoriteData.length;
  if (removed > 0) {
    saveFavorites();
    renderFavoritesPanel();
    syncFavoriteStateToChat(tabId, [...ids]);
    if (!options.silent) showToast(`已移除 ${removed} 条收藏`);
  }
  return removed;
}

export function removeFavoritesForTab(tabId, options = {}) {
  if (!tabId) return 0;
  const removedMessageIds = state.favoriteData
    .filter(item => item.tabId === tabId)
    .map(item => item.messageId)
    .filter(Boolean);
  const before = state.favoriteData.length;
  state.favoriteData = state.favoriteData.filter(item => item.tabId !== tabId);
  const removed = before - state.favoriteData.length;
  if (removed > 0) {
    saveFavorites();
    renderFavoritesPanel();
    if (currentPreviewFavoriteId && !state.favoriteData.some(item => item.id === currentPreviewFavoriteId)) {
      closeFavoritePreviewPanel();
    }
    syncFavoriteStateToChat(tabId, removedMessageIds);
    if (!options.silent) showToast(`已移除 ${removed} 条收藏`);
  }
  return removed;
}

export function closeFavoritesPanel() {
  const { panel } = getFavoritesPanelElements();
  if (panel) panel.classList.add('hidden');
}

export function closeFavoritePreviewPanel() {
  const { previewPanel } = getFavoritesPanelElements();
  currentPreviewFavoriteId = null;
  if (previewPanel) previewPanel.classList.add('hidden');
}

export function renderFavoritesPanel() {
  const { list } = getFavoritesPanelElements();
  if (!list) return;

  pruneInvalidFavorites();
  // pruneInvalidFavorites 内部已修改 state.favoriteData 并保存，
  // 下面的 .map(resolveFavoriteItem).filter(Boolean) 会自然过滤无效项。

  const items = state.favoriteData
    .map(resolveFavoriteItem)
    .filter(Boolean)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  if (!items.length) {
    list.innerHTML = '<div class="favorites-empty">还没有收藏内容，去对话里点星标试试吧。</div>';
    return;
  }

  list.innerHTML = items.map(item => `
    <div class="favorite-item" data-favorite-id="${escapeHtml(item.id)}">
      <div class="favorite-item-meta">
        <span class="favorite-item-tab">${escapeHtml(item.tabName)}</span>
        <span class="favorite-item-role">${escapeHtml(item.identityLabel)}</span>
      </div>
      <div class="favorite-item-preview">${escapeHtml(item.preview)}</div>
      <div class="favorite-item-actions">
        <button type="button" class="favorite-item-btn" data-action="preview" data-favorite-id="${escapeHtml(item.id)}">查看原文</button>
        <button type="button" class="favorite-item-btn" data-action="jump" data-favorite-id="${escapeHtml(item.id)}">跳转原文</button>
        <button type="button" class="favorite-item-btn danger" data-action="remove" data-favorite-id="${escapeHtml(item.id)}">移除</button>
      </div>
    </div>
  `).join('');
}

export function openFavoritesPanel() {
  const { panel } = getFavoritesPanelElements();
  if (!panel) return;
  renderFavoritesPanel();
  panel.classList.remove('hidden');
  closeSidebar();
}

function highlightMessageById(messageId) {
  const messageElement = document.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
  if (!messageElement) return false;
  messageElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
  messageElement.classList.remove(FAVORITE_HIGHLIGHT_CLASS);
  void messageElement.offsetWidth;
  messageElement.classList.add(FAVORITE_HIGHLIGHT_CLASS);
  window.setTimeout(() => {
    messageElement.classList.remove(FAVORITE_HIGHLIGHT_CLASS);
  }, FAVORITE_HIGHLIGHT_MS);
  return true;
}

function openFavoritePreview(favoriteId) {
  const favorite = state.favoriteData.find(item => item.id === favoriteId);
  const resolved = favorite ? resolveFavoriteItem(favorite) : null;
  const { previewPanel, previewContent, previewMeta } = getFavoritesPanelElements();
  if (!resolved || !previewPanel || !previewContent || !previewMeta) {
    if (favoriteId) removeFavoriteById(favoriteId, { silent: true });
    showToast('收藏已失效，已自动移除');
    return;
  }

  currentPreviewFavoriteId = favoriteId;
  previewMeta.textContent = `${resolved.tabName} · ${resolved.identityLabel}`;
  previewContent.textContent = getMessageDisplayText(resolved.message) || '（空内容）';
  previewPanel.classList.remove('hidden');
}

export function jumpToFavorite(favoriteId) {
  const favorite = state.favoriteData.find(item => item.id === favoriteId);
  const resolved = favorite ? resolveFavoriteItem(favorite) : null;
  if (!resolved) {
    if (favoriteId) removeFavoriteById(favoriteId, { silent: true });
    showToast('收藏已失效，已自动移除');
    return;
  }

  closeFavoritePreviewPanel();
  closeFavoritesPanel();

  state.tabData.active = resolved.tabId;
  saveTabs();
  coreCall('renderTabs');
  coreCall('renderChat');
  coreCall('updateInputCounter');
  coreCall('updateComposerPrimaryButtonState');
  coreCall('updateBgInfoChip');

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      highlightMessageById(resolved.messageId);
    });
  });
}

export function bindFavoritesEvents() {
  document.getElementById('openFavoritesBtn')?.addEventListener('click', openFavoritesPanel);
  document.getElementById('favoritesPanelCloseBtn')?.addEventListener('click', closeFavoritesPanel);
  document.getElementById('favoritesPanelMask')?.addEventListener('click', closeFavoritesPanel);
  document.getElementById('favoritePreviewPanelCloseBtn')?.addEventListener('click', closeFavoritePreviewPanel);
  document.getElementById('favoritePreviewPanelMask')?.addEventListener('click', (e) => {
    e.stopPropagation(); // 防止冒泡到收藏栏遮罩，避免同时关闭两层面板
    closeFavoritePreviewPanel();
  });
  document.getElementById('favoritesList')?.addEventListener('click', e => {
    const target = e.target.closest('[data-action][data-favorite-id]');
    if (!target) return;
    const favoriteId = target.dataset.favoriteId;
    const action = target.dataset.action;
    if (action === 'preview') {
      openFavoritePreview(favoriteId);
    } else if (action === 'jump') {
      jumpToFavorite(favoriteId);
    } else if (action === 'remove') {
      if (!confirm('确定移除这条收藏吗？')) return;
      removeFavoriteById(favoriteId);
    }
  });
}
