// app-utils.js - 通用工具函数
(function() {
  'use strict';
  const App = window.App;

  // ========== trackEvent ==========
  App.trackEvent = function(eventType) {
    const webhookUrl = 'https://bytedance.sg.larkoffice.com/base/automation/webhook/event/GnMPaByLZwehPShLu46lsgQQghd';
    fetch(webhookUrl, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event_type: eventType, user_id: App.dsUserId })
    });
  };

  // ========== escapeHtml ==========
  App.escapeHtml = function(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  };

  // ========== escapeRegExp ==========
  App.escapeRegExp = function(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  };

  // ========== formatBytes ==========
  App.formatBytes = function(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  };

  // ========== countChars ==========
  App.countChars = function(text) {
    return String(text || '').replace(/\s/g, '').length;
  };

  // ========== estimateTokensByChars ==========
  App.estimateTokensByChars = function(charCount) {
    return Math.ceil(charCount / 1.5);
  };

  // ========== estimateTokensByText ==========
  App.estimateTokensByText = function(text) {
    return App.estimateTokensByChars(App.countChars(text));
  };

  // ========== limitSentences ==========
  App.limitSentences = function(text, maxSentences) {
    if (!text) return text;
    maxSentences = maxSentences || 5;
    const sentences = text.split(/(?<=[。！？.!?])/);
    if (sentences.length <= maxSentences) return text;
    return sentences.slice(0, maxSentences).join('');
  };

  // ========== copyText ==========
  App.copyText = function(text) {
    if (!text) return alert("暂无内容可复制");

    // 优先使用现代剪贴板API
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function() {
        console.log("复制成功");
      }).catch(function(err) {
        // 如果现代API失败，尝试兼容性方法
        App.fallbackCopyText(text);
      });
    } else {
      // 使用兼容性方法
      App.fallbackCopyText(text);
    }
  };

  // ========== fallbackCopyText ==========
  App.fallbackCopyText = function(text) {
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
  };

  // ========== showToast ==========
  App.showToast = function(text) {
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
    requestAnimationFrame(function() {
      toast.style.opacity = '1';
      toast.style.bottom = '120px';
    });
    setTimeout(function() {
      toast.style.opacity = '0';
      toast.style.bottom = '110px';
      setTimeout(function() { toast.remove(); }, 250);
    }, 1800);
  };

  // ========== SVG 图标常量 ==========
  App.icons.copyIconSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
  App.icons.deleteIconSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';
  App.icons.renameIconSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"></path></svg>';
  App.icons.downloadIconSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>';
  App.icons.checkIconSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
  App.icons.editIconSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"></path></svg>';
  App.icons.regenerateIconSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>';
})();
