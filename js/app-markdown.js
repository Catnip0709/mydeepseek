// app-markdown.js - Markdown 渲染与搜索高亮
(function() {
  'use strict';
  const App = window.App;

  // ========== renderMarkdown ==========
  App.renderMarkdown = function(el, text, msgIndex, type) {
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
    if (App.searchQuery) {
      const textWithLineBreaks = text.replace(/\n/g, '  \n');
      const rawHtml = marked.parse(textWithLineBreaks);
      safeHtml = DOMPurify.sanitize(rawHtml);
      safeHtml = App.addSearchHighlightToHtml(safeHtml, msgIndex, type);
    } else {
      let cached = App._mdCache.get(text);
      if (!cached) {
        const textWithLineBreaks = text.replace(/\n/g, '  \n');
        const rawHtml = marked.parse(textWithLineBreaks);
        cached = DOMPurify.sanitize(rawHtml);
        App._mdCache.set(text, cached);
        if (App._mdCache.size > App._MD_CACHE_MAX) {
          const firstKey = App._mdCache.keys().next().value;
          App._mdCache.delete(firstKey);
        }
      }
      safeHtml = cached;
    }

    el.innerHTML = safeHtml;
  };

  // ========== addSearchHighlightToHtml ==========
  App.addSearchHighlightToHtml = function(html, msgIndex, type) {
    if (!App.searchQuery) return html;

    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = html;

    function highlightTextNodes(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent;
        const regex = new RegExp(`(${App.escapeRegExp(App.searchQuery)})`, 'gi');
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
    if (App.isCurrentSearchResult(msgIndex, type)) {
      tempDiv.classList.add('search-result-active');
    }

    return tempDiv.innerHTML;
  };
})();
