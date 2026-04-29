/**
 * utils.js — 纯工具函数模块
 *
 * 不依赖 DOM 或共享状态（除 trackEvent 需要 dsUserId 参数）。
 * 所有模块都可以安全导入本文件。
 */

import { state } from './state.js';

// ========== HTML 转义 ==========

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ========== 正则转义 ==========

export function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ========== 字节格式化 ==========

export function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

// ========== 字符/token 估算 ==========

export function countChars(text) {
  return String(text || '').replace(/\s/g, '').length;
}

export function estimateTokensByChars(charCount) {
  return Math.ceil(charCount / 1.5);
}

export function estimateTokensByText(text) {
  return estimateTokensByChars(countChars(text));
}

// ========== ID 生成 ==========

function generateId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function generateMessageId() {
  return generateId('msg');
}

export function generateFavoriteId() {
  return generateId('fav');
}

// ========== 剪贴板 ==========

export function copyText(text) {
  if (!text) return alert("暂无内容可复制");

  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text).then(() => {
      console.log("复制成功");
    }).catch(err => {
      fallbackCopyText(text);
    });
  } else {
    fallbackCopyText(text);
  }
}

export function fallbackCopyText(text) {
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

// ========== 句子限制（群聊用） ==========

export function limitSentences(text, maxSentences = 5) {
  if (!text) return text;
  const sentences = text.split(/(?<=[。！？.!?])/);
  if (sentences.length <= maxSentences) return text;
  return sentences.slice(0, maxSentences).join('');
}

// ========== 角色扮演动作格式化 ==========

function isWrappedActionLine(line) {
  return /^（[\s\S]*）$/.test(line) || /^\([\s\S]*\)$/.test(line);
}

function normalizeActionLine(line) {
  const text = String(line || '').trim();
  if (!text) return '';
  if (/^\([\s\S]*\)$/.test(text)) {
    return `（${text.slice(1, -1).trim()}）`;
  }
  return text;
}

function looksLikeActionLine(line) {
  const text = String(line || '').trim();
  if (!text) return false;
  if (isWrappedActionLine(text)) return false;
  if (/[“”"'「」『』]/.test(text)) return false;
  if (/^(嗯|啊|哦|哼|诶|喂|你|我|这|那|怎么|为何|别|好|行|可以|不行|不是|当然)/.test(text)) return false;
  return /(抬|垂|抿|勾|扬|挑|蹙|皱|眯|阖|睨|瞥|扫|望|看|盯|瞧|笑|冷笑|轻笑|低笑|嗤笑|偏头|侧身|侧过|转身|俯身|靠|倚|上前|后退|逼近|点头|摇头|耸肩|叹|顿了顿|停顿|沉默|把玩|摩挲|敲|轻敲|抬手|抬眸|垂眸|目光|眸光|眉梢|唇角|指尖|酒杯|袖口|衣摆)/.test(text);
}

export function formatRoleplayReply(text) {
  if (!text) return text;
  const rawLines = String(text).split(/\n+/).map(line => line.trim()).filter(Boolean);
  if (rawLines.length === 0) return '';

  const lines = rawLines.map(normalizeActionLine);
  if (lines.length >= 2 && !isWrappedActionLine(lines[0]) && looksLikeActionLine(lines[0])) {
    lines[0] = `（${lines[0]}）`;
  }

  return lines.join('\n');
}

// ========== 事件埋点 ==========

export function trackEvent(eventType) {
  const webhookUrl = 'https://bytedance.sg.larkoffice.com/base/automation/webhook/event/GnMPaByLZwehPShLu46lsgQQghd';
  fetch(webhookUrl, {
    method: 'POST',
    mode: 'no-cors',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event_type: eventType, user_id: state.dsUserId })
  }).catch(err => { console.log('Tracking info:', err); });
}

// ========== SVG 图标常量 ==========

export const copyIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;

export const deleteIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`;

export const editIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"></path></svg>`;

export const checkIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;

export const downloadIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`;

export const replyIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"></polyline><path d="M20 18v-2a4 4 0 0 0-4-4H4"></path></svg>`;

export const favoriteIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.75l2.86 5.79 6.39.93-4.62 4.5 1.09 6.36L12 17.32 6.28 20.33l1.09-6.36-4.62-4.5 6.39-.93L12 2.75z"></path></svg>`;

export function isHtmlRelatedMessage(m) {
  if (!m) return false;
  if (m.role === 'user' && m.htmlModeRequest === true) return true;
  if (m.role === 'assistant' && m.htmlGeneration) return true;
  if (m.role === 'assistant' && typeof m.content === 'string') {
    const trimmed = m.content.trim();
    if (/^```html[\s\S]*```$/i.test(trimmed)) return true;
  }
  return false;
}
