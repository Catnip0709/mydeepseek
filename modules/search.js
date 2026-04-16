/**
 * search.js — 搜索功能模块
 *
 * 负责对话内容的搜索、高亮、导航等功能。
 */

import { state } from './state.js';
import { renderChat } from './chat.js';

// ========== 搜索操作 ==========

export function performSearch(query) {
  state.searchQuery = query.trim().toLowerCase();
  state.searchResults = [];
  state.currentSearchIndex = -1;

  // 搜索会改变 DOM 高亮，清除所有缓存
  const chat = document.getElementById("chat");
  state._tabDomCache = {};

  const searchResultsInfo = document.getElementById('searchResultsInfo');
  const searchResultsText = document.getElementById('searchResultsText');

  if (!state.searchQuery) {
    searchResultsInfo.classList.add('hidden');
    renderChat();
    return;
  }

  const currentMsgs = state.tabData.list[state.tabData.active].messages || [];

  currentMsgs.forEach((msg, msgIndex) => {
    const content = msg.content.toLowerCase();
    const reasoning = (msg.reasoningContent || '').toLowerCase();

    if (content.includes(state.searchQuery)) {
      state.searchResults.push({
        msgIndex,
        type: 'content',
        text: msg.content
      });
    }

    if (reasoning.includes(state.searchQuery)) {
      state.searchResults.push({
        msgIndex,
        type: 'reasoning',
        text: msg.reasoningContent
      });
    }
  });

  document.body.classList.add('search-active');
  if (state.searchResults.length > 0) {
    state.currentSearchIndex = 0;
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

export function clearSearch() {
  const appTitle = document.getElementById('appTitle');
  const searchBox = document.getElementById('searchBox');
  const searchResultsInfo = document.getElementById('searchResultsInfo');

  appTitle.classList.remove('hidden');
  searchBox.classList.add('hidden');
  searchResultsInfo.classList.add('hidden');
  document.body.classList.remove('search-active');
  state.searchQuery = '';
  state.searchResults = [];
  state.currentSearchIndex = -1;
  renderChat();
}

export function goToSearchResult(direction) {
  if (state.searchResults.length === 0) return;

  if (direction === 'prev') {
    state.currentSearchIndex--;
    if (state.currentSearchIndex < 0) {
      state.currentSearchIndex = state.searchResults.length - 1;
    }
  } else {
    state.currentSearchIndex++;
    if (state.currentSearchIndex >= state.searchResults.length) {
      state.currentSearchIndex = 0;
    }
  }

  updateSearchResultsInfo();
  renderChat();
  scrollToCurrentSearchResult();
}

// ========== 内部辅助函数 ==========

function updateSearchResultsInfo() {
  const searchResultsText = document.getElementById('searchResultsText');
  if (state.searchResults.length > 0) {
    searchResultsText.textContent = `${state.currentSearchIndex + 1} / ${state.searchResults.length} 个结果`;
  }
}

function scrollToCurrentSearchResult() {
  if (state.currentSearchIndex < 0 || state.currentSearchIndex >= state.searchResults.length) return;

  const result = state.searchResults[state.currentSearchIndex];
  const msgEl = document.getElementById(`msg-${result.msgIndex}`);

  if (msgEl) {
    msgEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

// ========== 搜索事件绑定 ==========

export function bindSearchEvents() {
  const searchToggleBtn = document.getElementById('searchToggleBtn');
  const closeSearchBtn = document.getElementById('closeSearchBtn');
  const searchInput = document.getElementById('searchInput');
  const prevSearchResult = document.getElementById('prevSearchResult');
  const nextSearchResult = document.getElementById('nextSearchResult');
  const searchBox = document.getElementById('searchBox');
  const appTitle = document.getElementById('appTitle');

  function openSearch() {
    appTitle.classList.add('hidden');
    searchBox.classList.remove('hidden');
    searchInput.value = state.searchQuery;
    document.body.classList.add('search-active');
    setTimeout(() => searchInput.focus(), 50);
  }

  if (searchToggleBtn) searchToggleBtn.addEventListener('click', openSearch);
  if (closeSearchBtn) closeSearchBtn.addEventListener('click', clearSearch);

  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      performSearch(e.target.value);
    });
  }

  if (prevSearchResult) prevSearchResult.addEventListener('click', () => goToSearchResult('prev'));
  if (nextSearchResult) nextSearchResult.addEventListener('click', () => goToSearchResult('next'));

  // Ctrl+F 快捷键打开搜索
  document.addEventListener('keydown', function(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      openSearch();
    }
  });
}
