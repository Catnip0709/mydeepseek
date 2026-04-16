/**
 * markdown.js — Markdown 渲染模块
 *
 * 使用 marked + DOMPurify 渲染 Markdown，支持搜索高亮和缓存。
 */

import { state } from './state.js';
import { escapeRegExp } from './utils.js';

// ========== Markdown 渲染缓存（本模块专用） ==========

const _mdCache = new Map();
const _MD_CACHE_MAX = 500;

// ========== Markdown 渲染 ==========

export function renderMarkdown(el, text, msgIndex, type) {
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
  if (state.searchQuery) {
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

// ========== 搜索高亮 ==========

export function addSearchHighlightToHtml(html, msgIndex, type) {
  if (!state.searchQuery) return html;

  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = html;

  function highlightTextNodes(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent;
      const regex = new RegExp(`(${escapeRegExp(state.searchQuery)})`, 'gi');
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

// ========== 判断是否为当前搜索结果（仅本文件内部使用） ==========

function isCurrentSearchResult(msgIndex, type) {
  if (state.currentSearchIndex < 0 || state.currentSearchIndex >= state.searchResults.length) return false;
  const result = state.searchResults[state.currentSearchIndex];
  return result.msgIndex === msgIndex && result.type === type;
}
