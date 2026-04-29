/**
 * html-preview.js — HTML 代码块预览模块
 *
 * 检测聊天中的 HTML 代码块，自动收起代码并注入"点击预览效果"链接。
 * 点击后在模态弹窗中以 iframe 沙箱渲染 HTML 页面。
 */

// ========== HTML 代码块检测 ==========

/**
 * 判断一段代码文本是否像完整的 HTML 页面。
 * 匹配条件：包含 <html 或 <!DOCTYPE，且包含 <body。
 */
function looksLikeFullHtml(code) {
  const lower = code.trim().toLowerCase();
  const hasDocDecl = lower.startsWith('<!doctype') || lower.startsWith('<html');
  const hasBodyOrContent = lower.includes('<body') || lower.includes('<head') || lower.includes('<div');
  return hasDocDecl && hasBodyOrContent;
}

/**
 * 扫描 #chat 中所有 HTML 代码块，将代码收起并注入"点击预览效果"链接。
 * 重复调用幂等（已注入过的不重复添加）。
 */
export function enhanceHtmlCodeBlocks() {
  const chat = document.getElementById('chat');
  if (!chat) return;

  // 匹配 marked 渲染出的代码块：<pre><code class="language-xxx">
  const codeBlocks = chat.querySelectorAll('pre > code');
  codeBlocks.forEach((codeEl) => {
    // 已注入过则跳过
    if (codeEl.dataset.htmlPreviewInjected) return;

    const langClass = codeEl.className || '';
    const isHtmlLang = /language-html/i.test(langClass);
    const codeText = codeEl.textContent || '';

    // 仅对标记为 html 的代码块，或内容看起来像完整 HTML 的代码块生效
    if (!isHtmlLang && !looksLikeFullHtml(codeText)) return;

    codeEl.dataset.htmlPreviewInjected = 'true';

    const preEl = codeEl.parentElement;
    if (!preEl) return;

    // 用 <details> 包裹 <pre>，默认收起
    const wrapper = document.createElement('details');
    wrapper.className = 'html-preview-wrapper';

    const summary = document.createElement('summary');
    summary.className = 'html-preview-summary';
    summary.textContent = 'HTML 代码';

    // 把 <pre> 放进 <details> 里
    preEl.insertAdjacentElement('beforebegin', wrapper);
    wrapper.appendChild(summary);
    wrapper.appendChild(preEl);

    // 在 <details> 下方插入操作栏（预览链接）
    const actionBar = document.createElement('div');
    actionBar.className = 'html-preview-trigger';

    const previewLink = document.createElement('span');
    previewLink.className = 'html-preview-link';
    previewLink.textContent = '点击预览效果';
    previewLink.addEventListener('click', () => {
      openHtmlPreviewModal(codeText);
    });

    actionBar.appendChild(previewLink);
    wrapper.insertAdjacentElement('afterend', actionBar);
  });
}

// ========== 预览弹窗 ==========

let _previewModal = null;

function openHtmlPreviewModal(htmlCode) {
  // 如果已有弹窗，先关闭
  closeHtmlPreviewModal();

  const overlay = document.createElement('div');
  overlay.className = 'html-preview-overlay';
  overlay.id = 'htmlPreviewOverlay';

  const modal = document.createElement('div');
  modal.className = 'html-preview-modal';

  const header = document.createElement('div');
  header.className = 'html-preview-header';

  const title = document.createElement('span');
  title.className = 'html-preview-title';
  title.textContent = 'HTML 预览';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'html-preview-close';
  closeBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
  closeBtn.title = '关闭预览';
  closeBtn.addEventListener('click', closeHtmlPreviewModal);

  header.appendChild(title);
  header.appendChild(closeBtn);

  const iframe = document.createElement('iframe');
  iframe.className = 'html-preview-iframe';
  iframe.setAttribute('sandbox', 'allow-scripts allow-popups');
  iframe.setAttribute('referrerpolicy', 'no-referrer');

  modal.appendChild(header);
  modal.appendChild(iframe);
  overlay.appendChild(modal);

  document.body.appendChild(overlay);
  _previewModal = overlay;

  // 点击遮罩层关闭
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeHtmlPreviewModal();
  });

  // ESC 关闭
  document.addEventListener('keydown', _onPreviewEsc);

  // 写入 HTML 内容（剥离 <base> 标签防止资源劫持）
  const safeHtml = htmlCode.replace(/<base[^>]*>/gi, '');
  iframe.srcdoc = safeHtml;
}

function closeHtmlPreviewModal() {
  if (_previewModal) {
    _previewModal.remove();
    _previewModal = null;
  }
  document.removeEventListener('keydown', _onPreviewEsc);
}

function _onPreviewEsc(e) {
  if (e.key === 'Escape') closeHtmlPreviewModal();
}
