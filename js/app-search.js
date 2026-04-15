// app-search.js - 搜索功能
(function() {
  'use strict';
  const App = window.App;

  // ==================== DOM 元素 ====================
  const searchToggleBtn = document.getElementById('searchToggleBtn');
  const searchBox = document.getElementById('searchBox');
  const searchInput = document.getElementById('searchInput');
  const closeSearchBtn = document.getElementById('closeSearchBtn');
  const searchResultsInfo = document.getElementById('searchResultsInfo');
  const searchResultsText = document.getElementById('searchResultsText');
  const prevSearchResult = document.getElementById('prevSearchResult');
  const nextSearchResult = document.getElementById('nextSearchResult');
  const appTitle = document.getElementById('appTitle');

  // ==================== 搜索函数 ====================

  function openSearch() {
    appTitle.classList.add('hidden');
    searchBox.classList.remove('hidden');
    searchInput.value = App.searchQuery;
    document.body.classList.add('search-active');
    setTimeout(() => searchInput.focus(), 50);
  }

  function closeSearch() {
    appTitle.classList.remove('hidden');
    searchBox.classList.add('hidden');
    searchResultsInfo.classList.add('hidden');
    document.body.classList.remove('search-active');
    App.searchQuery = '';
    App.searchResults = [];
    App.currentSearchIndex = -1;
    App.renderChat();
  }

  function performSearch(query) {
    App.searchQuery = query.trim().toLowerCase();
    App.searchResults = [];
    App.currentSearchIndex = -1;
    App.invalidateTabCache(); // 搜索会改变 DOM 高亮，清除所有缓存

    if (!App.searchQuery) {
      searchResultsInfo.classList.add('hidden');
      App.renderChat();
      return;
    }

    const currentMsgs = App.tabData.list[App.tabData.active].messages || [];

    currentMsgs.forEach((msg, msgIndex) => {
      const content = msg.content.toLowerCase();
      const reasoning = (msg.reasoningContent || '').toLowerCase();

      if (content.includes(App.searchQuery)) {
        App.searchResults.push({
          msgIndex,
          type: 'content',
          text: msg.content
        });
      }

      if (reasoning.includes(App.searchQuery)) {
        App.searchResults.push({
          msgIndex,
          type: 'reasoning',
          text: msg.reasoningContent
        });
      }
    });

    document.body.classList.add('search-active');
    if (App.searchResults.length > 0) {
      App.currentSearchIndex = 0;
      updateSearchResultsInfo();
      searchResultsInfo.classList.remove('hidden');
      App.renderChat();
      scrollToCurrentSearchResult();
    } else {
      searchResultsText.textContent = '未找到匹配结果';
      searchResultsInfo.classList.remove('hidden');
      App.renderChat();
    }
  }

  function updateSearchResultsInfo() {
    if (App.searchResults.length > 0) {
      searchResultsText.textContent = `${App.currentSearchIndex + 1} / ${App.searchResults.length} 个结果`;
    }
  }

  function scrollToCurrentSearchResult() {
    if (App.currentSearchIndex < 0 || App.currentSearchIndex >= App.searchResults.length) return;

    const result = App.searchResults[App.currentSearchIndex];
    const msgEl = document.getElementById(`msg-${result.msgIndex}`);

    if (msgEl) {
      msgEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  function prevSearchResultHandler() {
    if (App.searchResults.length === 0) return;

    App.currentSearchIndex--;
    if (App.currentSearchIndex < 0) {
      App.currentSearchIndex = App.searchResults.length - 1;
    }

    updateSearchResultsInfo();
    App.renderChat();
    scrollToCurrentSearchResult();
  }

  function nextSearchResultHandler() {
    if (App.searchResults.length === 0) return;

    App.currentSearchIndex++;
    if (App.currentSearchIndex >= App.searchResults.length) {
      App.currentSearchIndex = 0;
    }

    updateSearchResultsInfo();
    App.renderChat();
    scrollToCurrentSearchResult();
  }

  function highlightSearchText(text) {
    if (!App.searchQuery) return App.escapeHtml(text);

    const regex = new RegExp(`(${App.escapeRegExp(App.searchQuery)})`, 'gi');
    return App.escapeHtml(text).replace(regex, (match) => {
      return `<span class="search-highlight">${match}</span>`;
    });
  }

  function isCurrentSearchResult(msgIndex, type) {
    if (App.currentSearchIndex < 0 || App.currentSearchIndex >= App.searchResults.length) return false;
    const result = App.searchResults[App.currentSearchIndex];
    return result.msgIndex === msgIndex && result.type === type;
  }

  // ==================== 注册到 App ====================
  App.isCurrentSearchResult = isCurrentSearchResult;
  App.highlightSearchText = highlightSearchText;

  // ==================== 事件绑定 ====================

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
})();
