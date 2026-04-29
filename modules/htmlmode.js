/**
 * htmlmode.js — 「预览网页」HTML 生成模式
 *
 * 功能：
 * - 提供 HTML 生成模式开关（与深度思考按钮互斥）
 * - 首次点击按钮时展示引导弹框（带指令示例）
 * - 指令示例支持「刷新」「复制到输入框」两个操作
 * - 发送时走自动续写通道（callLLMWithAutoContinue），
 *   生成过程对用户透明：气泡只显示进度文案，完成后一次性展示完整代码 + 预览按钮
 */

import { state, setTabSending, clearTabSending, getEffectiveModel } from './state.js';
import { callLLMWithAutoContinue, CHUNK_INACTIVITY_TIMEOUT_MS, callLLM } from './llm.js';
import { saveTabs } from './storage.js';
import { generateMessageId, trackEvent, copyText, isHtmlRelatedMessage } from './utils.js';
import { applyDeepThinkState } from './settings.js';
import { showToast } from './panels.js';

// ========== 常量 ==========

// 指令示例池：写死 10 条，弹框每次只展示一条
const HTML_EXAMPLES = [
  '请根据 ** 的性格特点，创作 10 条生动、贴合其个性的朋友圈内容。每条需体现人物评论、回复、点赞、视频、配图、屏蔽、提醒、时间等朋友圈功能。',
  '请根据 ** 的性格特点，创作 10 条生动、贴合其个性的微博内容。每条需体现转发、评论、点赞、热搜、话题标签、配图 / 长图 / 视频、仅粉丝可见、分组屏蔽、特别关注提醒、发布时间、置顶、私信互动等微博平台功能。',
  '请根据 ** 的性格特点，创作 10 条生动、贴合其个性的贴吧发帖内容。每条需体现楼中楼评论、层主回复、点赞 / 踩、收藏、帖子配图 / 视频、仅吧友可见、拉黑屏蔽、吧内 @提醒、发帖时间、精品帖、置顶帖、楼主追更等贴吧平台功能。',
  '请根据 ** 的性格特点，创作 10 条生动、贴合其个性的小红书笔记内容。每条需体现评论区互动、作者回复、点赞收藏、话题标签、图文 / 短视频配图、好友可见、屏蔽用户、@好友提醒、发布时间、笔记置顶、合集收录、私信催更等小红书平台功能。',
  '请根据 ** 的性格特点，创作 10 条生动、贴合其个性的抖音作品文案内容。每条需体现评论区回复、置顶评论、点赞收藏、合拍 / 转发、短视频 / 图文配景、私密作品、拉黑屏蔽、@好友提醒、发布时间、同城定位、热门话题、作品置顶等抖音平台功能。',
  '做一张"***与***的电子结婚证"，红金配色，上方"婚姻登记证"五个大字，中间两位的名字和登记日期 2025.10.07，下方贴一段两人的恋爱寄语，整体要有 90 年代红本本的复古质感。',
  '设计一个暗黑系角色资料卡页面，主角是"**"，职业是刑侦队长，冷色调背景，顶部一张人物卡片带数据面板（战斗力 92、智谋 98、亲和 30），下方是三段角色小传，字体用衬线体，整体氛围冷峻克制。',
  '帮我做一个极简黑白风个人博客首页，顶部是我的名字「**」和一句话简介"****"，中间列出五篇文章标题和发布日期，hover 时标题有下划线动画，底部放三个社交图标。',
  '做一个情人节表白页，玫瑰色渐变背景，中间一行大字"***，嫁给我好不好"，下方两个按钮"好"和"再想想"，点"再想想"会让按钮跑开，点"好"出现漫天爱心动画。',
  '做一个 CP 纪念页，标题"我们的第 100 天"，顶部放三张占位图（用灰色方块代替），每张图下写一句短日记，整体用奶油色背景 + 米白卡片，手写体中文字体，有翻页按钮切换不同月份。',
  '做一个同人社团主页，社团名"***"，顶部是社团 logo 占位和一句宣言"写给所有热爱故事的人"，中间是四张成员卡片（昵称、擅长类型、代表作），底部是招新按钮，整体用水墨中国风。',
  '做一个角色扮演打卡页，主角是"你今天扮演的自己"，顶部一个大标题"Day 42"，中间三个打卡区块：今日心情、今日台词、今日小剧场，每个区块配一个表情 emoji 和一句引导语，背景用浅粉渐变。'
];

const HTML_MODE_SYSTEM_PROMPT = `你是一位严谨的网页生成器。你的唯一职责就是输出一份完整、可独立运行、可直接放进浏览器打开的 HTML 文档。

【极其重要 · 输出格式】
- 你的回答必须以 <!DOCTYPE html> 开头，以 </html> 结尾。
- 在 <!DOCTYPE html> 之前，禁止输出任何字符（没有空格、没有换行、没有问候、没有"好的/这是/下面是"这类引导语）。
- 在 </html> 之后，禁止输出任何字符（没有总结、没有"希望你喜欢"、没有"需要修改请告诉我"、没有说明页面用到了哪些技术、没有任何解释）。
- 禁止输出 markdown 代码块围栏（不要 \`\`\`html，也不要 \`\`\`）。
- 禁止在 HTML 文档外出现任何人类自然语言文字。
- 任何说明、描述、注释如果必要，请用 HTML 注释 <!-- --> 写在 HTML 内部。

【反面教材，绝对不要这样做】
错误示例 A：
好的，这是为您生成的页面：
<!DOCTYPE html> ... </html>
希望您喜欢！

错误示例 B：
<!DOCTYPE html> ... </html>

个人主页与微博动态
这个页面为您搭建了一个完整的个人主页框架...

【正确示例】
<!DOCTYPE html>
<html lang="zh-CN">
<head>...</head>
<body>...</body>
</html>
（到此结束，后面一个字符都不要写）

【关于"用户创作背景"分区（如果 user 消息里包含该分区）】
- 该分区仅作为**网页内文字素材库**使用（比如人物名字、某条微博的内容、某段角色自我介绍的用词）。
- **不要让这份资料改变页面的整体结构、布局、主色调、排版方式**——用户在本条指令里描述的视觉要求才是唯一的结构依据。
- 不要在 HTML 外引用或复述这份资料。
- 不要把这份资料里的悲伤/冷峻/热烈等情绪氛围当作"整站设计准则"去铺满页面，除非用户本次指令里明确要求。
- 如果资料里的某些内容与本次指令无关，直接忽略。
- 优先满足本次指令的视觉描述，资料只服务于"填空"这一件事。

【技术约束】
- 所有 CSS 写在 <style> 里，所有 JS 写在 <script> 里。
- 不要依赖任何外部 CDN/字体/图片 URL；使用纯 CSS 渐变、SVG 或占位色块代替图片。
- 页面要有完整的 <head>（含 <meta charset="utf-8"> 和 <title>）与 <body>。
- 使用语义化标签，代码清晰、可读性好，视觉效果贴近用户描述的氛围。
- 如果内容较长、接近长度上限，请在安全位置（例如某个 </div> 之后）停下，不要自作主张提前闭合 </html>；系统会自动让你继续。
- 如果用户请求的不是网页生成，也请以合法 HTML 形式返回一个极简说明页，用网页告诉他"本次请求未涉及网页需求"。

再次强调：除了 <!DOCTYPE html> 到 </html> 之间的内容，其他任何字符都不要输出。`;

// ========== 状态 ==========

let _htmlModeEnabled = false;
let _guideEl = null;
let _currentExampleIndex = -1;
let _toggleEl = null; // input checkbox
let _chipEl = null;   // label

// ========== 工具 ==========

/**
 * 对模型输出做"保险丝"式清理：
 * 1. 去掉 markdown 代码块围栏
 * 2. 截取 <!DOCTYPE html> 到 </html> 之间的主体，剥离前后任何闲话
 * 3. 若找不到 <!DOCTYPE html>，退化为 <html> 起点
 * 4. 两端都找不到，返回空串
 */
function sanitizeHtmlOutput(raw) {
  if (!raw) return '';
  let text = String(raw);

  // 1) 去围栏（头尾都可能有）
  text = text.replace(/^\s*```html\s*/i, '').replace(/^\s*```\s*/i, '');
  text = text.replace(/```\s*$/i, '');
  text = text.trim();

  // 2) 定位主体起点：优先 <!DOCTYPE html>，其次 <html
  const doctypeMatch = text.match(/<!DOCTYPE\s+html[^>]*>/i);
  let startIdx = -1;
  if (doctypeMatch) {
    startIdx = doctypeMatch.index;
  } else {
    const htmlTagMatch = text.match(/<html[\s>]/i);
    if (htmlTagMatch) startIdx = htmlTagMatch.index;
  }

  // 3) 定位主体终点：最后一次出现的 </html>
  const lastCloseIdx = text.toLowerCase().lastIndexOf('</html>');

  if (startIdx >= 0 && lastCloseIdx > startIdx) {
    return text.slice(startIdx, lastCloseIdx + '</html>'.length).trim();
  }

  // 4) 只找到开头没找到结尾（续写被打断的场景）：保留从开头到末尾
  if (startIdx >= 0) {
    return text.slice(startIdx).trim();
  }

  // 5) 都没找到：说明模型彻底跑偏了，返回空字符串，走"生成失败"兜底
  return '';
}

// ========== 剧情上下文注入 ==========

const RECENT_MSG_COUNT = 30;           // 最近保留的原文消息条数（全量模式下调高到 30 条）
const RECENT_MSG_MAX_CHARS = 8000;     // 最近消息拼接上限（调高到 8000 字，基本上不截断）
const SUMMARY_MAX_CHARS_FOR_HTML = 8000; // 摘要注入上限（调高到 8000 字，基本上不截断）
const CONTEXT_BLOCK_MAX_CHARS = 16000; // 整个参考资料分区硬上限（调高到 16000 字）


function truncateAtBoundary(text, maxChars) {
  if (!text) return '';
  if (text.length <= maxChars) return text;
  // 改为截头不截尾，优先保留最新的剧情信息
  return text.slice(-maxChars);
}

function formatRecentMessagesForContext(messages) {
  const filtered = messages.filter(m => !isHtmlRelatedMessage(m));
  const tail = filtered.slice(-RECENT_MSG_COUNT);

  const lines = tail.map(m => {
    const role = m.role === 'user' ? '用户' : (m.role === 'assistant' ? 'AI' : (m.characterName || '角色'));
    const content = typeof m.content === 'string' ? m.content.trim() : '';
    if (!content) return '';
    return `${role}：${content}`;
  }).filter(Boolean);

  const joined = lines.join('\n');
  return truncateAtBoundary(joined, RECENT_MSG_MAX_CHARS);
}

const htmlSummaryCache = new Map(); // Map<tabId, { summary: string, ts: number }>
const HTML_SUMMARY_TTL = 2 * 60 * 1000; // 缓存有效期 2 分钟

/**
 * 确保 HTML 模式有剧情摘要（针对全量模式用户，临时生成一次性摘要，不写回 localStorage）
 */
async function ensureHtmlContextSummary(tab, onStatus, signal) {
  if (!tab) return '';
  if (typeof tab.summary === 'string' && tab.summary.trim()) {
    return tab.summary.trim(); // 已有摘要直接返回
  }
  
  const messages = Array.isArray(tab.messages) ? tab.messages : [];
  // 消息太少不需要摘要
  if (messages.length < 20) return '';
  
  const now = Date.now();
  const cached = htmlSummaryCache.get(tab.id);
  if (cached && now - cached.ts < HTML_SUMMARY_TTL) {
    return cached.summary;
  }
  
  // 过滤出供摘要的消息
  const msgsForSummary = messages.filter(m => !isHtmlRelatedMessage(m));
  if (msgsForSummary.length < 20) return '';
  
  if (onStatus) {
    onStatus('正在梳理剧情背景...');
  }
  
  // 构建供摘要的文本
  const textLines = msgsForSummary.map(m => {
    const role = m.role === 'user' ? '用户' : (m.role === 'assistant' ? 'AI' : (m.characterName || '角色'));
    const content = typeof m.content === 'string' ? m.content.trim() : '';
    if (!content) return '';
    return `${role}：${content}`;
  });
  
  // R2 修复：控制输入到摘要大模型的 token 数量，防止超出限制或消耗过大
  // 截取最近的 ~32000 个字符用于生成摘要
  let fullText = textLines.join('\n');
  const MAX_CHARS_FOR_SUMMARY_GEN = 32000;
  if (fullText.length > MAX_CHARS_FOR_SUMMARY_GEN) {
    fullText = fullText.slice(-MAX_CHARS_FOR_SUMMARY_GEN);
    // 保证不截断半句话
    const firstNewline = fullText.indexOf('\n');
    if (firstNewline !== -1) {
      fullText = fullText.slice(firstNewline + 1);
    }
    fullText = '...（更早的内容已省略）\n' + fullText;
  }
  
  const summaryPrompt = `请用客观的语言，总结以下剧情或对话背景（只提取核心设定、关键人物、已发生的重要剧情和最新进展）。不要输出除了总结以外的任何多余文字，也不要对剧情做评价。\n\n【内容】\n${fullText}`;
  
  try {
    const { model } = getEffectiveModel();
    const result = await callLLM({
      model: model,
      messages: [{ role: 'user', content: summaryPrompt }],
      stream: false,
      temperature: 0.3,
      signal // R1 修复：传入 AbortSignal，支持中断
    });
    
    const summary = typeof result === 'string' ? result : (result?.content || '');
    if (summary) {
      htmlSummaryCache.set(tab.id, { summary, ts: Date.now() });
      return summary;
    }
  } catch (err) {
    // R3 修复：处理中断和异常
    if (err.name === 'AbortError') {
      throw err; // 如果是用户主动停止，直接向上抛出，中断整个 HTML 生成流程
    }
    console.warn('HTML 临时摘要生成失败:', err);
    // 发生网络错误时，给出弱提示，并静默降级为无摘要（仅靠最近 30 条原文）
    window.dispatchEvent(new CustomEvent('show-toast', { detail: { message: '剧情梳理失败，仅带入最近 30 条上下文', type: 'warning' } }));
  }
  
  return '';
}

/**
 * 从 tab.summary + tab.messages 构造"用户创作背景"分区文本。
 * 规模控制在 CONTEXT_BLOCK_MAX_CHARS 以内。
 * 如果 tab 完全没有可引用的上下文（例如是新对话），返回空串 → 调用方不注入分区。
 */
async function buildStoryContextBlock(tab, onStatus, signal) {
  if (!tab) return '';

  const parts = [];

  const summary = await ensureHtmlContextSummary(tab, onStatus, signal);
  if (summary) {
    parts.push('【既往剧情摘要】\n' + truncateAtBoundary(summary, SUMMARY_MAX_CHARS_FOR_HTML));
  }

  const messages = Array.isArray(tab.messages) ? tab.messages : [];
  const recent = formatRecentMessagesForContext(messages);
  if (recent) {
    parts.push('【最近对话片段】\n' + recent);
  }

  if (parts.length === 0) return '';

  let block = parts.join('\n\n');
  if (block.length > CONTEXT_BLOCK_MAX_CHARS) {
    block = block.slice(-CONTEXT_BLOCK_MAX_CHARS);
  }
  return block;
}

function pickRandomExample(excludeIndex = -1) {
  if (HTML_EXAMPLES.length === 0) return { index: -1, text: '' };
  if (HTML_EXAMPLES.length === 1) return { index: 0, text: HTML_EXAMPLES[0] };
  let idx = Math.floor(Math.random() * HTML_EXAMPLES.length);
  // 避免和上次相同
  if (idx === excludeIndex) {
    idx = (idx + 1) % HTML_EXAMPLES.length;
  }
  return { index: idx, text: HTML_EXAMPLES[idx] };
}

export function isHtmlModeEnabled() {
  return _htmlModeEnabled;
}

// ========== 模式开关 ==========

function applyHtmlModeState(enabled, { silent = false } = {}) {
  _htmlModeEnabled = !!enabled;
  // 同步全局标志，供 settings.js 的互斥拦截读取（避免循环 import）
  try { window.__mydeepseek_htmlModeOn = _htmlModeEnabled; } catch (_) {}
  if (_toggleEl) _toggleEl.checked = _htmlModeEnabled;

  // HTML 模式与深度思考互斥
  const deepThinkToggle = document.getElementById('deepThinkToggle');
  const deepThinkChip = deepThinkToggle ? deepThinkToggle.closest('.deepthink-chip') : null;
  if (_htmlModeEnabled) {
    // 关闭深度思考
    if (state.deepThink) {
      applyDeepThinkState(false, 'html-mode-auto-off');
    }
    if (deepThinkChip) deepThinkChip.classList.add('disabled');
  } else {
    if (deepThinkChip) deepThinkChip.classList.remove('disabled');
  }

  if (!silent) {
    showToast(_htmlModeEnabled ? '已开启预览网页模式' : '已关闭预览网页模式');
  }
}

function handleChipClick(event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  if (state.isSending || state.isPreparingTextAttachment) return;

  // 已处于开启状态：直接关闭（不弹引导）
  if (_htmlModeEnabled) {
    applyHtmlModeState(false);
    return;
  }
  // 从关闭 → 开启：每次都弹出引导
  openGuidePanel();
}

// ========== 引导弹框 ==========

function refreshExampleInGuide() {
  const textEl = document.getElementById('htmlModeGuideExample');
  if (!textEl) return;
  const picked = pickRandomExample(_currentExampleIndex);
  _currentExampleIndex = picked.index;
  textEl.textContent = picked.text;
}

function openGuidePanel() {
  if (!_guideEl) _guideEl = document.getElementById('htmlModeGuidePanel');
  if (!_guideEl) return;
  refreshExampleInGuide();
  _guideEl.classList.remove('hidden');
  _guideEl.style.display = 'flex';
}

function closeGuidePanel() {
  if (!_guideEl) _guideEl = document.getElementById('htmlModeGuidePanel');
  if (!_guideEl) return;
  _guideEl.classList.add('hidden');
  _guideEl.style.display = 'none';
}

function handleGuideConfirm() {
  closeGuidePanel();
  applyHtmlModeState(true);
}

function handleGuideCopyExample() {
  const textEl = document.getElementById('htmlModeGuideExample');
  const btn = document.getElementById('htmlModeGuideCopyBtn');
  if (!textEl) return;
  const example = textEl.textContent || '';
  if (!example) return;

  // 直接填入输入框
  const input = document.getElementById('input');
  if (input) {
    input.value = example;
    input.dispatchEvent(new Event('input'));
  }
  // 也顺手放一份到剪贴板
  copyText(example);
  if (btn) {
    btn.classList.add('copied');
    setTimeout(() => btn.classList.remove('copied'), 1200);
  }
  showToast('已填入输入框');
}

// ========== 生成气泡 UI ==========

function getGeneratingBubbleId(tabId) {
  return `htmlGenBubble-${tabId}`;
}

/**
 * 创建或复用 loading 气泡。
 * 用固定 id（tab 维度）而不是消息 index，避免被别处的 renderChat() 擦掉时无法自愈。
 */
function ensureGeneratingBubble(tabId) {
  const chat = document.getElementById('chat');
  if (!chat) return null;

  const bubbleId = getGeneratingBubbleId(tabId);
  let box = document.getElementById(bubbleId);
  if (box && box.parentElement === chat) return box;
  // 若节点不在（被 renderChat 清空）或没创建过，重建
  if (box) box.remove();

  box = document.createElement('div');
  box.id = bubbleId;
  box.className = 'message-box p-3 rounded-xl bg-gray-800 mr-auto max-w-[85%] text-white html-gen-bubble';
  box.dataset.ephemeral = 'html-gen';

  const status = document.createElement('div');
  status.className = 'html-gen-status';

  const spinner = document.createElement('span');
  spinner.className = 'html-gen-status-spinner';
  status.appendChild(spinner);

  const text = document.createElement('span');
  text.className = 'html-gen-status-text';
  text.textContent = '正在生成网页代码...';
  status.appendChild(text);

  box.appendChild(status);

  const meta = document.createElement('div');
  meta.className = 'html-gen-meta';
  meta.textContent = '已生成 0 字';
  box.appendChild(meta);

  chat.appendChild(box);
  chat.scrollTop = chat.scrollHeight;
  return box;
}

function updateGeneratingBubble(tabId, { round, totalChars, statusText }) {
  // 若被擦掉则自愈重建
  const box = ensureGeneratingBubble(tabId);
  if (!box) return;
  const textEl = box.querySelector('.html-gen-status-text');
  const metaEl = box.querySelector('.html-gen-meta');
  if (textEl) {
    if (statusText) {
      textEl.textContent = statusText;
    } else if (round <= 1) {
      textEl.textContent = '正在生成网页代码...';
    } else {
      textEl.textContent = `正在续写第 ${round} 段...`;
    }
  }
  if (metaEl && totalChars !== undefined) {
    metaEl.textContent = `已生成 ${totalChars} 字`;
  }
}

function removeGeneratingBubble(tabId) {
  const box = document.getElementById(getGeneratingBubbleId(tabId));
  if (box) box.remove();
}

// ========== 发送入口 ==========

/**
 * 在 HTML 模式下发送消息。
 * 由 chat.js 的 sendMessage 在发现 isHtmlModeEnabled() 时调用。
 *
 * @param {Object} opts
 * @param {string} opts.tabId            - 锁定的目标 tab id
 * @param {string} opts.userText         - 用户原始输入
 */
export async function sendHtmlGenerationMessage({ tabId, userText, regenerateIndex, fromEdit }) {
  const tab = state.tabData.list[tabId];
  if (!tab) return;

  const currentMsgs = tab.messages || [];
  let assistantId = generateMessageId();
  let actualUserText = userText;

  if (regenerateIndex !== undefined) {
    // 重新生成：保留之前的消息（除了当前的 assistantMsg）
    // 但我们需要拿到对应的 userText
    const targetMsg = currentMsgs[regenerateIndex];
    if (targetMsg && targetMsg.role === 'assistant') {
      assistantId = targetMsg.id || assistantId;
      // 往前找最近的 user 消息
      for (let i = regenerateIndex - 1; i >= 0; i--) {
        if (currentMsgs[i].role === 'user') {
          actualUserText = currentMsgs[i].content;
          break;
        }
      }
      
      // 在 history 中增加 generating 状态
      if (!targetMsg.history) {
        targetMsg.history = [{ content: targetMsg.content, reasoningContent: targetMsg.reasoningContent || "", state: targetMsg.generationState || 'complete' }];
        targetMsg.historyIndex = 0;
      }
      targetMsg.history.push({ content: "", reasoningContent: "", state: "generating" });
      targetMsg.historyIndex = targetMsg.history.length - 1;
      targetMsg.content = "";
      targetMsg.generationState = "generating";
    }
  } else if (!fromEdit) {
    // 正常发送：push user 消息
    currentMsgs.push({
      id: generateMessageId(),
      role: 'user',
      content: userText,
      htmlModeRequest: true
    });
  }
  
  tab.messages = currentMsgs;
  saveTabs();

  // 在 DOM 里渲染 user 消息 + 生成中气泡（loading 气泡用 tab 维度固定 id，自愈重建）
  if (state.tabData.active === tabId) {
    const { renderChat } = await import('./chat.js');
    renderChat();
    ensureGeneratingBubble(tabId);
  }

  // 建立发送状态（按 tab 隔离）
  const tabEntry = setTabSending(tabId, {
    isSending: true,
    abortReason: null,
    abortController: new AbortController()
  });

  const { model } = getEffectiveModel();
  trackEvent('发送消息-HTML');

  // 组装消息：HTML system + 剧情上下文 + 用户指令
  // 注意：我们不按"messages 数组里多条消息"的方式传上下文，而是把剧情塞进 user 消息里的一个分区，
  // 这样可以最大程度降低模型把"上下文对话"误当作"继续对话"的风险，同时让 system prompt 中的分区约束生效。
  let storyContext = '';
  try {
    storyContext = await buildStoryContextBlock(tab, (msg) => {
      if (state.tabData.active === tabId) {
        updateGeneratingBubble(tabId, { statusText: msg });
      }
    }, tabEntry.abortController.signal);
  } catch (err) {
    if (err.name === 'AbortError') {
      generationState = 'interrupted';
      removeGeneratingBubble(tabId);
      // 被中止时直接写入一个中断的占位气泡
      const interruptedMsg = {
        id: generateMessageId(),
        role: 'assistant',
        content: '<p class="text-gray-500 italic">（已取消）</p>',
        htmlGeneration: true
      };
      tab.messages.push(interruptedMsg);
      saveTabs();
      return;
    }
  }

  const userPayload = storyContext
    ? `【本次指令】\n${actualUserText}\n\n---\n【用户创作背景（仅供填充网页内文本，不要影响页面结构/配色/布局）】\n${storyContext}`
    : actualUserText;

  const payloadMsgs = [
    { role: 'system', content: HTML_MODE_SYSTEM_PROMPT }
  ];

  // 支持多轮网页修改：将最近一次 HTML 对话带入（不带入所有，避免 token 爆炸）
  // 在当前 user 消息之前的消息中，寻找最近的一对 htmlModeRequest -> htmlGeneration
  let lastHtmlUser = null;
  let lastHtmlAssistant = null;
  // regenerateIndex 存在时，当前消息索引是 regenerateIndex，我们要找它前面的。
  // 不存在时，当前 user 消息已经在数组最后了（或者 fromEdit 为 true 也是最后），往前找即可。
  const searchEndIndex = regenerateIndex !== undefined ? regenerateIndex - 1 : currentMsgs.length - 2;
  
  for (let i = searchEndIndex; i >= 0; i--) {
    const msg = currentMsgs[i];
    if (msg.role === 'assistant' && msg.htmlGeneration && msg.content) {
      lastHtmlAssistant = msg;
      // 接着往前找它的 user 消息
      for (let j = i - 1; j >= 0; j--) {
        if (currentMsgs[j].role === 'user' && currentMsgs[j].htmlModeRequest) {
          lastHtmlUser = currentMsgs[j];
          break;
        }
      }
      break;
    }
  }

  if (lastHtmlUser && lastHtmlAssistant) {
    payloadMsgs.push({ role: 'user', content: lastHtmlUser.content });
    // 传递上一次的 HTML，为了防止代码带前缀后缀，我们最好清理一下
    const cleanOldHtml = sanitizeHtmlOutput(lastHtmlAssistant.content);
    payloadMsgs.push({ role: 'assistant', content: cleanOldHtml ? `\`\`\`html\n${cleanOldHtml}\n\`\`\`` : lastHtmlAssistant.content });
  }

  payloadMsgs.push({ role: 'user', content: userPayload });

  let finalContent = '';
  let finishReason = null;
  let truncated = false;
  let rounds = 0;
  let generationState = 'complete';

  // 生成期间让用户能看到"停止"按钮，复用现有 state.isSending 语义
  try {
    const { updateComposerPrimaryButtonState } = await import('./chat.js');
    updateComposerPrimaryButtonState();
  } catch (_) {}

  try {
    const result = await callLLMWithAutoContinue({
      model,
      messages: payloadMsgs,
      maxRounds: 6,
      maxTokensPerRound: 8192,
      temperature: 0.3,
      signal: tabEntry.abortController.signal,
      chunkTimeoutMs: CHUNK_INACTIVITY_TIMEOUT_MS,
      onStatus({ round, totalChars }) {
        if (state.tabData.active === tabId) {
          updateGeneratingBubble(tabId, { round, totalChars });
        }
      },
      onChunk({ totalChars, round }) {
        if (state.tabData.active === tabId) {
          updateGeneratingBubble(tabId, { round, totalChars });
        }
      }
    });
    finalContent = result.content || '';
    finishReason = result.finishReason;
    truncated = !!result.truncated;
    rounds = result.rounds || 0;
  } catch (e) {
    if (e.name === 'AbortError') {
      if (tabEntry.abortReason === 'manual') {
        generationState = 'interrupted';
      } else if (tabEntry.abortReason === 'background') {
        generationState = 'interrupted';
      } else if (tabEntry.abortReason === 'timeout') {
        generationState = 'timeout';
      } else {
        generationState = 'interrupted';
      }
    } else {
      generationState = 'interrupted';
      console.error('HTML 模式生成失败:', e);
    }
  } finally {
    clearTabSending(tabId);
    removeGeneratingBubble(tabId);
    try {
      const { updateComposerPrimaryButtonState } = await import('./chat.js');
      updateComposerPrimaryButtonState();
    } catch (_) {}
  }

  // 落盘：把完整 HTML 包装成一个 ```html 代码块，让 html-preview.js 自动注入预览按钮
  const lockedTab = state.tabData.list[tabId];
  if (!lockedTab) return;

  // 清理模型可能残留的代码围栏 & 任何 HTML 外的前后闲话
  let htmlBody = sanitizeHtmlOutput(finalContent);

  const wrapped = htmlBody
    ? `\`\`\`html\n${htmlBody}\n\`\`\``
    : (generationState === 'interrupted' ? '（生成已中断）' : '（生成失败，请重试）');

  const assistantMsg = {
    id: assistantId,
    role: 'assistant',
    content: wrapped,
    reasoningContent: '',
    generationState,
    htmlGeneration: {
      rounds,
      finishReason,
      truncated,
      charCount: htmlBody.length
    },
    history: [{ content: wrapped, reasoningContent: '', state: generationState }],
    historyIndex: 0
  };

  // 插入或更新 messages 里
  const msgs = lockedTab.messages || [];
  if (regenerateIndex !== undefined) {
    const targetMsg = msgs[regenerateIndex];
    if (targetMsg) {
      targetMsg.content = assistantMsg.content;
      targetMsg.reasoningContent = assistantMsg.reasoningContent;
      targetMsg.generationState = assistantMsg.generationState;
      targetMsg.htmlGeneration = assistantMsg.htmlGeneration;
      
      // 更新 history 中最后一个记录
      if (targetMsg.history && targetMsg.history.length > 0) {
        const lastHist = targetMsg.history[targetMsg.history.length - 1];
        lastHist.content = assistantMsg.content;
        lastHist.reasoningContent = assistantMsg.reasoningContent;
        lastHist.state = assistantMsg.generationState;
      }
    }
  } else {
    msgs.push(assistantMsg);
  }
  lockedTab.messages = msgs;
  saveTabs();

  if (state.tabData.active === tabId) {
    const { renderChat } = await import('./chat.js');
    renderChat();
  }

  if (truncated && generationState === 'complete') {
    showToast('已达到续写上限，生成内容可能不完整');
  }
}

// ========== 绑定事件 ==========

export function bindHtmlModeEvents() {
  _toggleEl = document.getElementById('htmlModeToggle');
  _chipEl = document.getElementById('htmlModeChip');
  _guideEl = document.getElementById('htmlModeGuidePanel');

  if (_chipEl) {
    _chipEl.addEventListener('click', handleChipClick);
  }

  const closeBtn = document.getElementById('htmlModeGuideCloseBtn');
  const confirmBtn = document.getElementById('htmlModeGuideConfirmBtn');
  const refreshBtn = document.getElementById('htmlModeGuideRefreshBtn');
  const copyBtn = document.getElementById('htmlModeGuideCopyBtn');

  if (closeBtn) closeBtn.addEventListener('click', closeGuidePanel);
  if (confirmBtn) confirmBtn.addEventListener('click', handleGuideConfirm);
  if (refreshBtn) refreshBtn.addEventListener('click', refreshExampleInGuide);
  if (copyBtn) copyBtn.addEventListener('click', handleGuideCopyExample);

  if (_guideEl) {
    _guideEl.addEventListener('click', (e) => {
      if (e.target === _guideEl) closeGuidePanel();
    });
  }

  // ESC 关闭弹框
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _guideEl && !_guideEl.classList.contains('hidden')) {
      closeGuidePanel();
    }
  });

  // 初始化：若已看过引导但之前没开启模式，保持关闭
  applyHtmlModeState(false, { silent: true });
}
