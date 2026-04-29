/**
 * archive.js — 剧情档案馆模块
 *
 * 负责剧情档案馆的生成、渲染与面板交互。
 */

import { state } from './state.js';
import { callLLM, extractJsonFromText } from './llm.js';
import { saveTabs, getTabDisplayName } from './storage.js';
import { isHtmlRelatedMessage } from './utils.js';
import { showToast, closeSidebar } from './panels.js';
import { call as coreCall } from './core.js';

const STORY_ARCHIVE_VERSION = 'v1';
const STORY_ARCHIVE_MIN_MESSAGES = 4;
const STORY_ARCHIVE_MAX_TIMELINE = 8;
const STORY_ARCHIVE_MAX_RELATIONSHIPS = 8;
const STORY_ARCHIVE_MAX_FORESHADOWS = 8;
const ARCHIVE_PHASE_IDLE = 'idle';
const ARCHIVE_PHASE_LOADING = 'loading';
const ARCHIVE_PHASE_ERROR = 'error';
const ARCHIVE_PHASE_CANCELLED = 'cancelled';
const ARCHIVE_TOTAL_TIMEOUT_MS = 300000; // 总超时 5 分钟

const archiveRuntimeMap = new Map();
const archiveRuntimeTimerMap = new Map();

function createEmptyStoryArchive() {
  return {
    version: STORY_ARCHIVE_VERSION,
    generatedAt: 0,
    sourceMessageCount: 0,
    sourceSignature: '',
    overview: {
      premise: '',
      currentArc: '',
      toneSummary: ''
    },
    relationships: [],
    timeline: [],
    foreshadows: []
  };
}

function createArchiveRuntimeState() {
  return {
    phase: ARCHIVE_PHASE_IDLE,
    detail: '',
    hint: '',
    errorMessage: '',
    errorSignature: '',
    startedAt: 0,
    lastSuccessAt: 0,
    backgroundNotified: false
  };
}

function getCurrentTab() {
  return state.tabData.list[state.tabData.active] || null;
}

function getArchiveRuntime(tabId = state.tabData.active) {
  return archiveRuntimeMap.get(tabId) || createArchiveRuntimeState();
}

function setArchiveRuntime(tabId, patch = {}) {
  const next = { ...getArchiveRuntime(tabId), ...patch };
  archiveRuntimeMap.set(tabId, next);
  if (tabId === state.tabData.active) {
    renderStoryArchive();
  }
  return next;
}

function clearArchiveRuntimeTimers(tabId) {
  const timers = archiveRuntimeTimerMap.get(tabId);
  if (Array.isArray(timers)) {
    timers.forEach(timerId => clearTimeout(timerId));
  }
  archiveRuntimeTimerMap.delete(tabId);
}

function formatArchiveTime(timestamp) {
  if (!timestamp) return '';
  const diff = Date.now() - timestamp;
  if (diff < 60 * 1000) return '刚刚更新';
  if (diff < 60 * 60 * 1000) return `${Math.max(1, Math.floor(diff / (60 * 1000)))} 分钟前更新`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.max(1, Math.floor(diff / (60 * 60 * 1000)))} 小时前更新`;
  return `${Math.max(1, Math.floor(diff / (24 * 60 * 60 * 1000)))} 天前更新`;
}

function getSingleCharacterName(tab) {
  if (!tab || tab.type !== 'single-character' || !tab.characterId) return '角色';
  const char = coreCall('getCharacterById', tab.characterId);
  return char?.name || '角色';
}

function getMessageSpeakerLabel(message, tab) {
  if (!message) return '未知';
  if (message.role === 'user') return '我';
  if (message.role === 'character') return message.characterName || '角色';
  if (tab?.type === 'single-character') return getSingleCharacterName(tab);
  return 'DeepSeek';
}

function buildConversationForArchive(tab) {
  const messages = Array.isArray(tab?.messages) ? tab.messages.filter(m => !isHtmlRelatedMessage(m)) : [];
  return messages.map((message, index) => {
    const speaker = getMessageSpeakerLabel(message, tab);
    const content = String(message.content || '').trim();
    return `${index + 1}. ${speaker}：${content}`;
  }).filter(Boolean).join('\n');
}

function buildConversationForArchiveWithLimit(tab, options = {}) {
  const { headCount = 12, tailCount = 48 } = options;
  const messages = Array.isArray(tab?.messages) ? tab.messages.filter(m => !isHtmlRelatedMessage(m)) : [];
  const total = messages.length;
  if (!total) return '';
  if (total <= headCount + tailCount + 8) {
    return buildConversationForArchive(tab);
  }

  const head = messages.slice(0, headCount);
  const tail = messages.slice(Math.max(headCount, total - tailCount));

  const format = (arr, baseIndex) => arr.map((message, idx) => {
    const speaker = getMessageSpeakerLabel(message, tab);
    const content = String(message.content || '').trim();
    return `${baseIndex + idx + 1}. ${speaker}：${content}`;
  }).filter(Boolean).join('\n');

  return [
    '【说明】聊天记录较长，已自动截取“开头 + 结尾”用于生成档案；中间部分请依赖“已有记忆摘要/背景信息”理解，避免上下文过长导致模型失败。',
    '',
    '【开头片段】',
    format(head, 0),
    '',
    `【中间省略】（共省略 ${Math.max(0, total - head.length - tail.length)} 条）`,
    '',
    '【结尾片段】',
    format(tail, total - tail.length)
  ].join('\n');
}

function getArchiveStabilityProfile(tab) {
  // 成功率优先：长会话自动精简输出 + 输入截断 + 两阶段生成（拆分输出，降低截断/解析失败率）
  const messages = Array.isArray(tab?.messages) ? tab.messages.filter(m => !isHtmlRelatedMessage(m)) : [];
  const messageCount = messages.length;
  const totalChars = messages.reduce((sum, m) => sum + String(m?.content || '').length, 0);

  // 三档：full / compact / minimal
  let mode = 'full';
  if (messageCount >= 160 || totalChars >= 90000) mode = 'minimal';
  else if (messageCount >= 90 || totalChars >= 45000) mode = 'compact';

  if (mode === 'minimal') {
    return {
      mode,
      twoStage: true,
      convo: { headCount: 10, tailCount: 40 },
      limits: {
        relationships: Math.min(5, STORY_ARCHIVE_MAX_RELATIONSHIPS),
        timeline: Math.min(5, STORY_ARCHIVE_MAX_TIMELINE),
        foreshadows: Math.min(6, STORY_ARCHIVE_MAX_FORESHADOWS),
        totalChars: 900
      }
    };
  }

  if (mode === 'compact') {
    return {
      mode,
      twoStage: true,
      convo: { headCount: 12, tailCount: 50 },
      limits: {
        relationships: Math.min(6, STORY_ARCHIVE_MAX_RELATIONSHIPS),
        timeline: Math.min(6, STORY_ARCHIVE_MAX_TIMELINE),
        foreshadows: Math.min(8, STORY_ARCHIVE_MAX_FORESHADOWS),
        totalChars: 1200
      }
    };
  }

  return {
    mode,
    twoStage: false,
    convo: null, // 不截断
    limits: {
      relationships: STORY_ARCHIVE_MAX_RELATIONSHIPS,
      timeline: STORY_ARCHIVE_MAX_TIMELINE,
      foreshadows: STORY_ARCHIVE_MAX_FORESHADOWS,
      totalChars: 1500
    }
  };
}

function buildCoreArchiveHint(coreArchive) {
  // 用于 extras 阶段对齐人名/主线，避免直接塞入被截断的 JSON 字符串（容易引发模型误读）
  const overview = coreArchive?.overview && typeof coreArchive.overview === 'object' ? coreArchive.overview : {};
  const relationships = Array.isArray(coreArchive?.relationships) ? coreArchive.relationships : [];
  const timeline = Array.isArray(coreArchive?.timeline) ? coreArchive.timeline : [];

  const relPairs = relationships
    .map(item => {
      const src = String(item?.source || '').trim();
      const tgt = String(item?.target || '').trim();
      return (src && tgt) ? `${src}×${tgt}` : '';
    })
    .filter(Boolean)
    .slice(0, 8);

  const events = timeline
    .map(item => String(item?.title || '').trim())
    .filter(Boolean)
    .slice(0, 8);

  return [
    `premise: ${String(overview.premise || '').trim()}`,
    `currentArc: ${String(overview.currentArc || '').trim()}`,
    `toneSummary: ${String(overview.toneSummary || '').trim()}`,
    relPairs.length ? `relationships: ${relPairs.join(' / ')}` : '',
    events.length ? `timeline: ${events.join(' / ')}` : ''
  ].filter(Boolean).join('\n');
}

function applyArchiveLimits(rawArchive, profile) {
  const limits = profile?.limits || {};
  const next = rawArchive && typeof rawArchive === 'object' ? rawArchive : {};

  const relLimit = Math.max(0, Number(limits.relationships ?? STORY_ARCHIVE_MAX_RELATIONSHIPS));
  const timelineLimit = Math.max(0, Number(limits.timeline ?? STORY_ARCHIVE_MAX_TIMELINE));
  const foreshadowLimit = Math.max(0, Number(limits.foreshadows ?? STORY_ARCHIVE_MAX_FORESHADOWS));
  const relationships = Array.isArray(next.relationships) ? next.relationships.slice(0, relLimit) : [];
  const timeline = Array.isArray(next.timeline) ? next.timeline.slice(0, timelineLimit) : [];
  const foreshadows = Array.isArray(next.foreshadows) ? next.foreshadows.slice(0, foreshadowLimit) : [];

  return {
    ...next,
    overview: next.overview && typeof next.overview === 'object' ? next.overview : {},
    relationships,
    timeline,
    foreshadows
  };
}

function normalizeTags(tags, fallback = []) {
  if (!Array.isArray(tags)) return fallback;
  return tags
    .map(tag => String(tag || '').trim())
    .filter(Boolean)
    .slice(0, 4);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderTextChip(text, className = '') {
  const safeClassName = className ? ` ${className}` : '';
  return `<span class="story-archive-chip${safeClassName}">${escapeHtml(text)}</span>`;
}

function hashString(text) {
  let hash = 2166136261;
  const input = String(text || '');
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function buildArchiveSourcePayload(tab) {
  const messages = Array.isArray(tab?.messages) ? tab.messages.filter(m => !isHtmlRelatedMessage(m)) : [];
  return {
    type: String(tab?.type || 'single'),
    title: String(tab?.title || ''),
    summary: String(tab?.summary || ''),
    summaryVersion: String(tab?.summaryVersion || ''),
    summaryCoversUpTo: Number(tab?.summaryCoversUpTo || 0),
    userRoleName: String(tab?.userRoleName || ''),
    storyBackground: String(tab?.storyBackground || ''),
    characterId: String(tab?.characterId || ''),
    characterIds: Array.isArray(tab?.characterIds) ? tab.characterIds.map(id => String(id || '')) : [],
    messages: messages.map(message => ({
      role: String(message?.role || ''),
      content: String(message?.content || ''),
      reasoningContent: String(message?.reasoningContent || ''),
      generationState: String(message?.generationState || ''),
      characterId: String(message?.characterId || ''),
      characterName: String(message?.characterName || ''),
      userQuestion: String(message?.userQuestion || ''),
      replyTo: message?.replyTo ? {
        characterId: String(message.replyTo.characterId || ''),
        characterName: String(message.replyTo.characterName || ''),
        snippet: String(message.replyTo.snippet || '')
      } : null,
      fileAttachment: message?.fileAttachment ? {
        fileName: String(message.fileAttachment.fileName || ''),
        mode: String(message.fileAttachment.mode || ''),
        originalCharCount: Number(message.fileAttachment.originalCharCount || 0),
        displayedCharCount: Number(message.fileAttachment.displayedCharCount || 0),
        displayText: String(message.fileAttachment.displayText || '')
      } : null
    }))
  };
}

function getStoryArchiveSourceSignature(tab) {
  return hashString(JSON.stringify(buildArchiveSourcePayload(tab)));
}

function isArchiveGeneratingForTab(tabId) {
  return state.archiveGenerationTabId === tabId;
}

function isStoryArchiveStale(tab) {
  if (!tab) return false;
  const archive = tab.storyArchive;
  if (!archive || !archive.generatedAt) return false;
  const currentSignature = getStoryArchiveSourceSignature(tab);
  return !archive.sourceSignature || archive.sourceSignature !== currentSignature;
}

function normalizeArchive(rawArchive, tab, sourceMessageCount, sourceSignature) {
  const archive = createEmptyStoryArchive();
  const raw = rawArchive && typeof rawArchive === 'object' ? rawArchive : {};
  const overview = raw.overview && typeof raw.overview === 'object' ? raw.overview : {};

  archive.generatedAt = Date.now();
  archive.sourceMessageCount = sourceMessageCount;
  archive.sourceSignature = sourceSignature || '';
  archive.overview = {
    premise: String(overview.premise || '').trim(),
    currentArc: String(overview.currentArc || '').trim(),
    toneSummary: String(overview.toneSummary || '').trim()
  };

  const toName = (value, fallback) => String(value || fallback || '').trim();

  archive.relationships = Array.isArray(raw.relationships)
    ? raw.relationships.slice(0, STORY_ARCHIVE_MAX_RELATIONSHIPS).map((item, index) => {
        const relation = item && typeof item === 'object' ? item : {};
        return {
          id: `rel_${Date.now()}_${index}`,
          source: toName(relation.source, '我'),
          target: toName(relation.target, getSingleCharacterName(tab)),
          stage: String(relation.stage || '待发展').trim(),
          trend: String(relation.trend || '稳定').trim(),
          reason: String(relation.reason || '').trim()
        };
      }).filter(item => item.source && item.target && item.reason)
    : [];

  archive.timeline = Array.isArray(raw.timeline)
    ? raw.timeline.slice(0, STORY_ARCHIVE_MAX_TIMELINE).map((item, index) => {
        const event = item && typeof item === 'object' ? item : {};
        return {
          id: `event_${Date.now()}_${index}`,
          title: String(event.title || '').trim(),
          summary: String(event.summary || '').trim(),
          impact: String(event.impact || '').trim(),
          participants: normalizeTags(event.participants, ['我'])
        };
      }).filter(item => item.title && item.summary)
    : [];

  archive.foreshadows = Array.isArray(raw.foreshadows)
    ? raw.foreshadows.slice(0, STORY_ARCHIVE_MAX_FORESHADOWS).map((item, index) => {
        const foreshadow = item && typeof item === 'object' ? item : {};
        const status = String(foreshadow.status || 'open').trim().toLowerCase();
        return {
          id: `flag_${Date.now()}_${index}`,
          content: String(foreshadow.content || '').trim(),
          status: status === 'resolved' ? 'resolved' : 'open',
          note: String(foreshadow.note || '').trim()
        };
      }).filter(item => item.content)
    : [];

  return archive;
}

function getArchiveViewState(tab, tabId = state.tabData.active) {
  if (!tab) {
    return {
      statusText: '暂无会话',
      statusClassName: 'muted',
      refreshLabel: '刷新整理',
      refreshDisabled: true,
      refreshLoading: false,
      feedbackType: 'info',
      feedbackTitle: '还没有可整理的会话',
      feedbackBody: '请先进入一个会话，再打开剧情档案馆。',
      feedbackHint: '',
      showRetry: false
    };
  }

  const archive = tab.storyArchive;
  const runtime = getArchiveRuntime(tabId);
  const currentSignature = getStoryArchiveSourceSignature(tab);

  if (runtime.phase === ARCHIVE_PHASE_LOADING) {
    const elapsed = runtime.startedAt ? Date.now() - runtime.startedAt : 0;
    const remaining = Math.max(0, Math.ceil((ARCHIVE_TOTAL_TIMEOUT_MS - elapsed) / 1000));
    const minutes = Math.floor(remaining / 60);
    const seconds = remaining % 60;
    const countdownText = remaining > 0 ? `${minutes}:${String(seconds).padStart(2, '0')}` : '0:00';
    return {
      statusText: '正在整理',
      statusClassName: 'loading',
      refreshLabel: '停止整理',
      refreshDisabled: false,
      refreshLoading: false,
      feedbackType: 'loading',
      feedbackTitle: '正在整理剧情档案',
      feedbackBody: `剩余时间 ${countdownText}`,
      feedbackHint: runtime.hint || '你可以先关闭面板，档案馆会继续在后台整理。',
      showRetry: false
    };
  }

  if (runtime.phase === ARCHIVE_PHASE_ERROR && runtime.errorSignature === currentSignature) {
    return {
      statusText: '整理失败',
      statusClassName: 'error',
      refreshLabel: '刷新整理',
      refreshDisabled: false,
      refreshLoading: false,
      feedbackType: 'error',
      feedbackTitle: '这次整理没有完成',
      feedbackBody: runtime.errorMessage || '模型暂时没有返回可用结果，请稍后重试。',
      feedbackHint: '你可以点击"重试整理"重新发起，关闭面板不会清掉这条失败记录。',
      showRetry: true,
      showCopyDebug: !!runtime.debugInfo
    };
  }

  if (runtime.phase === ARCHIVE_PHASE_CANCELLED && runtime.errorSignature === currentSignature && !isStoryArchiveStale(tab)) {
    return {
      statusText: '已停止',
      statusClassName: 'muted',
      refreshLabel: '重新整理',
      refreshDisabled: false,
      refreshLoading: false,
      feedbackType: 'info',
      feedbackTitle: '已停止这次整理',
      feedbackBody: '当前这次剧情档案整理已被手动终止，已有档案内容会保持不变。',
      feedbackHint: '如果你想继续更新，点击“重新整理”即可重新发起。',
      showRetry: false
    };
  }

  if (!archive || !archive.generatedAt) {
    const hasEnoughMessages = Array.isArray(tab.messages) && tab.messages.length >= STORY_ARCHIVE_MIN_MESSAGES;
    return {
      statusText: '未生成',
      statusClassName: 'warning',
      refreshLabel: hasEnoughMessages ? '开始整理' : '刷新整理',
      refreshDisabled: !hasEnoughMessages,
      refreshLoading: false,
      feedbackType: 'info',
      feedbackTitle: hasEnoughMessages ? '还没有剧情档案' : '消息还不够多',
      feedbackBody: hasEnoughMessages
        ? '点击“开始整理”后，会自动提取人物关系、关键事件和伏笔。'
        : `至少需要 ${STORY_ARCHIVE_MIN_MESSAGES} 条消息后，才能整理剧情档案。`,
      feedbackHint: hasEnoughMessages ? '第一次生成可能会花一点时间。' : '继续聊几句后，点击“开始整理”即可生成剧情档案。',
      showRetry: false
    };
  }

  if (isStoryArchiveStale(tab)) {
    return {
      statusText: '待更新',
      statusClassName: 'warning',
      refreshLabel: '刷新整理',
      refreshDisabled: false,
      refreshLoading: false,
      feedbackType: 'stale',
      feedbackTitle: '剧情有新进展',
      feedbackBody: '当前会话内容已经变化，建议刷新整理，更新最新的人物关系、时间线和伏笔状态。',
      feedbackHint: '点击“刷新整理”后，会重新生成最新的剧情档案。',
      showRetry: false
    };
  }

  const recentSuccess = runtime.lastSuccessAt && (Date.now() - runtime.lastSuccessAt < 90 * 1000);
  return {
    statusText: '已同步',
    statusClassName: 'fresh',
    refreshLabel: '刷新整理',
    refreshDisabled: false,
    refreshLoading: false,
    feedbackType: recentSuccess ? 'success' : '',
    feedbackTitle: recentSuccess ? '剧情档案已更新' : '',
    feedbackBody: recentSuccess ? '已同步最新的人物关系、事件时间线和伏笔。' : '',
    feedbackHint: recentSuccess ? formatArchiveTime(runtime.lastSuccessAt) : '',
    showRetry: false
  };
}

function renderArchiveSectionList(containerId, items, renderItem, emptyText) {
  const container = document.getElementById(containerId);
  if (!container) return;
  if (!items.length) {
    container.innerHTML = `<div class="story-archive-empty">${escapeHtml(emptyText)}</div>`;
    return;
  }
  container.innerHTML = items.map(renderItem).join('');
}

function renderArchiveFeedback(viewState) {
  const feedbackEl = document.getElementById('storyArchiveFeedback');
  const titleEl = document.getElementById('storyArchiveFeedbackTitle');
  const bodyEl = document.getElementById('storyArchiveFeedbackBody');
  const hintEl = document.getElementById('storyArchiveFeedbackHint');
  const retryBtn = document.getElementById('retryStoryArchiveBtn');
  const copyDebugBtn = document.getElementById('copyArchiveDebugBtn');
  if (!feedbackEl || !titleEl || !bodyEl || !hintEl || !retryBtn) return;

  if (!viewState.feedbackType) {
    feedbackEl.className = 'story-archive-feedback hidden';
    titleEl.textContent = '';
    bodyEl.textContent = '';
    hintEl.textContent = '';
    hintEl.classList.add('hidden');
    retryBtn.classList.add('hidden');
    if (copyDebugBtn) copyDebugBtn.classList.add('hidden');
    return;
  }

  feedbackEl.className = `story-archive-feedback ${viewState.feedbackType}`;
  titleEl.textContent = viewState.feedbackTitle || '';
  bodyEl.textContent = viewState.feedbackBody || '';
  hintEl.textContent = viewState.feedbackHint || '';
  hintEl.classList.toggle('hidden', !viewState.feedbackHint);
  retryBtn.classList.toggle('hidden', !viewState.showRetry);
  if (copyDebugBtn) copyDebugBtn.classList.toggle('hidden', !viewState.showCopyDebug);
}

function renderArchiveRefreshButton(viewState) {
  const refreshBtn = document.getElementById('refreshStoryArchiveBtn');
  const refreshText = document.getElementById('refreshStoryArchiveBtnText');
  if (!refreshBtn || !refreshText) return;
  refreshBtn.disabled = !!viewState.refreshDisabled;
  refreshBtn.classList.toggle('is-loading', !!viewState.refreshLoading);
  refreshBtn.classList.toggle('is-stop', viewState.refreshLabel === '停止整理');
  refreshText.textContent = viewState.refreshLabel || '刷新整理';
}

export function cancelStoryArchiveGeneration(options = {}) {
  const { silent = false } = options;
  const tabId = state.archiveGenerationTabId;
  if (!tabId || !state.archiveAbortController) return false;
  try {
    state.archiveAbortController.abort();
  } catch (_) {}
  clearArchiveRuntimeTimers(tabId);
  setArchiveRuntime(tabId, {
    phase: ARCHIVE_PHASE_CANCELLED,
    detail: '',
    hint: '',
    errorMessage: '',
    errorSignature: getStoryArchiveSourceSignature(state.tabData.list[tabId]),
    startedAt: 0,
    backgroundNotified: false
  });
  state.archiveAbortController = null;
  state.archiveGenerationTabId = null;
  if (!silent) showToast('已停止剧情档案整理');
  return true;
}

function renderStoryArchive() {
  const tab = getCurrentTab();
  if (!tab) return;
  const archive = tab.storyArchive || createEmptyStoryArchive();
  const viewState = getArchiveViewState(tab);
  const statusEl = document.getElementById('storyArchiveStatus');
  const premiseEl = document.getElementById('storyArchivePremise');
  const arcEl = document.getElementById('storyArchiveArc');
  const toneEl = document.getElementById('storyArchiveTone');
  const metaEl = document.getElementById('storyArchiveMeta');

  if (statusEl) {
    statusEl.textContent = viewState.statusText;
    statusEl.className = `story-archive-status ${viewState.statusClassName}`;
  }
  renderArchiveFeedback(viewState);
  renderArchiveRefreshButton(viewState);
  if (premiseEl) premiseEl.textContent = archive.overview.premise || '生成后会自动整理这段故事的核心设定与关系。';
  if (arcEl) arcEl.textContent = archive.overview.currentArc || '尚未识别当前主线阶段';
  if (toneEl) toneEl.textContent = archive.overview.toneSummary || '尚未识别整体氛围';
  if (metaEl) {
    const title = getTabDisplayName(state.tabData.active);
    const count = Array.isArray(tab.messages) ? tab.messages.length : 0;
    const runtime = getArchiveRuntime(state.tabData.active);
    const archiveTime = archive.generatedAt ? formatArchiveTime(archive.generatedAt) : '';
    const suffix = runtime.phase === ARCHIVE_PHASE_LOADING
      ? '正在整理中'
      : (archiveTime || '');
    metaEl.textContent = suffix ? `${title} · 共 ${count} 条消息 · ${suffix}` : `${title} · 共 ${count} 条消息`;
  }

  renderArchiveSectionList(
    'storyArchiveRelationships',
    archive.relationships || [],
    item => `
      <div class="story-archive-item">
        <div class="story-archive-item-head">
          <div class="story-archive-item-title">${escapeHtml(item.source)} × ${escapeHtml(item.target)}</div>
          <div class="story-archive-chip-row">
            ${renderTextChip(item.stage)}
            ${renderTextChip(item.trend, 'tone')}
          </div>
        </div>
        <div class="story-archive-item-desc">${escapeHtml(item.reason)}</div>
      </div>
    `,
    '还没有提炼出明确的关系变化。'
  );

  renderArchiveSectionList(
    'storyArchiveTimeline',
    archive.timeline || [],
    item => `
      <div class="story-archive-item">
        <div class="story-archive-item-head">
          <div class="story-archive-item-title">${escapeHtml(item.title)}</div>
          <div class="story-archive-item-meta">${escapeHtml(item.participants.join(' / '))}</div>
        </div>
        <div class="story-archive-item-desc">${escapeHtml(item.summary)}</div>
        ${item.impact ? `<div class="story-archive-item-impact">影响：${escapeHtml(item.impact)}</div>` : ''}
      </div>
    `,
    '还没有整理出关键剧情事件。'
  );

  renderArchiveSectionList(
    'storyArchiveForeshadows',
    archive.foreshadows || [],
    item => `
      <div class="story-archive-item">
        <div class="story-archive-item-head">
          <div class="story-archive-item-title">${escapeHtml(item.content)}</div>
          <div class="story-archive-chip-row">
            ${renderTextChip(item.status === 'resolved' ? '已回收' : '未回收', item.status === 'resolved' ? 'resolved' : 'warning')}
          </div>
        </div>
        ${item.note ? `<div class="story-archive-item-desc">${escapeHtml(item.note)}</div>` : ''}
      </div>
    `,
    '目前还没有明显的伏笔或未解信息。'
  );

}

function buildArchivePrompt(tab, title, options = {}) {
  const { profile = null, stage = 'full', coreArchiveJson = '' } = options;
  const effectiveProfile = profile || getArchiveStabilityProfile(tab);
  const summaryText = tab.summary ? `\n\n【已有记忆摘要】\n${tab.summary}` : '';
  const bgParts = [];
  if (tab.userRoleName) bgParts.push(`用户角色：${tab.userRoleName}`);
  if (tab.storyBackground) bgParts.push(`故事背景：${tab.storyBackground}`);
  const bgText = bgParts.length ? `\n\n【背景信息】\n${bgParts.join('\n')}` : '';
  const modeText = tab.type === 'group' ? '多人群聊' : (tab.type === 'single-character' ? '角色对话' : '普通对话');

  const maxRel = effectiveProfile?.limits?.relationships ?? STORY_ARCHIVE_MAX_RELATIONSHIPS;
  const maxTimeline = effectiveProfile?.limits?.timeline ?? STORY_ARCHIVE_MAX_TIMELINE;
  const maxForeshadows = effectiveProfile?.limits?.foreshadows ?? STORY_ARCHIVE_MAX_FORESHADOWS;
  const totalCharsLimit = effectiveProfile?.limits?.totalChars ?? 1500;

  const stageHint = stage === 'core'
    ? '【任务】只输出 overview / relationships / timeline 三个字段，其它字段一律不要输出。'
    : (stage === 'extras'
      ? '【任务】只输出 foreshadows 字段，其它字段一律不要输出。'
      : '【任务】输出完整的剧情档案（overview/relationships/timeline/foreshadows）。');

  const schema = stage === 'core'
    ? `{\n  "overview": {\n    "premise": "一句话概括当前故事核心关系或设定",\n    "currentArc": "当前主线阶段或冲突状态",\n    "toneSummary": "整体氛围，如暧昧拉扯/高糖日常/冷战修复"\n  },\n  "relationships": [\n    {\n      "source": "角色A",\n      "target": "角色B",\n      "stage": "关系阶段",\n      "trend": "升温/拉扯/冷战/修复/稳定",\n      "reason": "本轮关系变化原因"\n    }\n  ],\n  "timeline": [\n    {\n      "title": "事件标题",\n      "summary": "事件摘要",\n      "impact": "对后续剧情或关系的影响",\n      "participants": [\"参与者1\", \"参与者2\"]\n    }\n  ]\n}`
    : (stage === 'extras'
      ? `{\n  "foreshadows": [\n    {\n      "content": "尚未解释或尚未回收的信息",\n      "status": "open 或 resolved",\n      "note": "可选补充说明"\n    }\n  ]\n}`
      : `{\n  "overview": {\n    "premise": "一句话概括当前故事核心关系或设定",\n    "currentArc": "当前主线阶段或冲突状态",\n    "toneSummary": "整体氛围，如暧昧拉扯/高糖日常/冷战修复"\n  },\n  "relationships": [\n    {\n      "source": "角色A",\n      "target": "角色B",\n      "stage": "关系阶段",\n      "trend": "升温/拉扯/冷战/修复/稳定",\n      "reason": "本轮关系变化原因"\n    }\n  ],\n  "timeline": [\n    {\n      "title": "事件标题",\n      "summary": "事件摘要",\n      "impact": "对后续剧情或关系的影响",\n      "participants": [\"参与者1\", \"参与者2\"]\n    }\n  ],\n  "foreshadows": [\n    {\n      "content": "尚未解释或尚未回收的信息",\n      "status": "open 或 resolved",\n      "note": "可选补充说明"\n    }\n  ]\n}`);

  const coreContext = (stage === 'extras' && coreArchiveJson)
    ? `\n\n【已生成的核心档案（用于对齐人名/主线，不要重复输出这部分字段）】\n${coreArchiveJson}`
    : '';

  return [
    {
      role: 'system',
      content: `你是同人剧情整理助手。请把聊天记录整理为结构化剧情档案，用于后续续写与整理设定。
严格输出 JSON，不要输出任何额外说明。
${stageHint}
输出格式如下：
${schema}
要求：
1. 只根据提供内容整理，不要编造不存在的设定。
2. 优先提取关系推进、重要事件和未回收伏笔。
3. relationships 最多 ${maxRel} 条，timeline 最多 ${maxTimeline} 条，foreshadows 最多 ${maxForeshadows} 条。
4. 【字数硬限制——违反将导致输出截断和解析失败】
   - premise / currentArc / toneSummary：各不超过 30 字
   - reason / summary / impact：各不超过 20 字
   - note：不超过 15 字（或省略）
   - title：不超过 15 字
   - 总输出严格控制在 ${totalCharsLimit} 字以内（约 ${Math.ceil(totalCharsLimit * 1.8)} token）。宁可少写条目、省略 note 字段，也绝不超限。
5. 每写完一个字段，默数一下字数。如果发现快超限了，立即停止写新条目，直接闭合 JSON。`
    },
    {
      role: 'user',
      content: `【会话标题】\n${title}\n\n【会话类型】\n${modeText}${bgText}${summaryText}${coreContext}\n\n【聊天记录】\n${
        effectiveProfile.convo
          ? buildConversationForArchiveWithLimit(tab, effectiveProfile.convo)
          : buildConversationForArchive(tab)
      }`
    }
  ];
}

export function markStoryArchiveStale(tabId) {
  const tab = state.tabData.list[tabId];
  if (!tab || !tab.storyArchive || !tab.storyArchive.generatedAt) return;
  if (!isStoryArchiveStale(tab)) return;
  if (tabId === state.tabData.active) {
    const panel = document.getElementById('storyArchivePanel');
    if (panel && !panel.classList.contains('hidden')) {
      renderStoryArchive();
    }
  }
}

export async function generateStoryArchive(tabId = state.tabData.active, options = {}) {
  const { silent = false, silentSuccess = false } = options;
  const tab = state.tabData.list[tabId];
  const keyPanel = document.getElementById('keyPanel');
  if (!tab) return null;
  if (!state.apiKey) {
    if (keyPanel) keyPanel.classList.remove('hidden');
    return null;
  }
  if (state.archiveGenerationTabId) {
    if (!silent) {
      showToast(state.archiveGenerationTabId === tabId ? '当前会话的剧情档案正在整理中' : '另一个会话正在整理中，请稍后再试');
    }
    return null;
  }
  if (!Array.isArray(tab.messages) || tab.messages.length < STORY_ARCHIVE_MIN_MESSAGES) {
    if (!silent) showToast(`至少需要 ${STORY_ARCHIVE_MIN_MESSAGES} 条消息后再整理剧情档案`);
    return null;
  }

  const sourceMessageCount = tab.messages.length;
  const sourceSignature = getStoryArchiveSourceSignature(tab);
  const title = getTabDisplayName(tabId);
  const profile = getArchiveStabilityProfile(tab);
  const promptMessages = buildArchivePrompt(tab, title, { profile, stage: profile.twoStage ? 'core' : 'full' });
  const snapshotTab = tab; // 快照：基于点击生成时的 tab 状态
  const abortController = new AbortController();

  state.archiveGenerationTabId = tabId;
  state.archiveAbortController = abortController;
  setArchiveRuntime(tabId, {
    phase: ARCHIVE_PHASE_LOADING,
    detail: '',
    hint: '',
    errorMessage: '',
    errorSignature: '',
    startedAt: Date.now(),
    backgroundNotified: false
  });
  renderStoryArchive();

  // 每秒刷新倒计时
  const countdownTimer = setInterval(() => {
    if (tabId === state.tabData.active) renderStoryArchive();
  }, 1000);

  let isTotalTimeout = false;
  let totalTimer = null;
  let debugInfo = '';
  let coreArchiveForFallback = null;

  try {
    totalTimer = setTimeout(() => {
      isTotalTimeout = true;
      abortController.abort();
    }, ARCHIVE_TOTAL_TIMEOUT_MS);

    // 成功率优先：长会话采用“两阶段生成”拆分输出，降低截断/解析失败率
    const coreResult = await callLLM({
      model: state.selectedModel,
      messages: promptMessages,
      stream: true,
      temperature: 0.2,
      maxTokens: profile.twoStage ? 2048 : 4096,
      signal: abortController.signal,
      chunkTimeoutMs: 120000
    });
    const coreRawText = typeof coreResult === 'string' ? coreResult : (coreResult?.content || '');
    const coreCleanedText = coreRawText.replace(/^```json?\n?/i, '').replace(/\n?```$/, '').trim();

    let coreArchive;
    try { coreArchive = JSON.parse(coreCleanedText); } catch (_) { coreArchive = extractJsonFromText(coreCleanedText); }
    if (!coreArchive) {
      debugInfo = [
        `消息数量: ${sourceMessageCount}`,
        `模式: ${profile.mode}`,
        `模型原始返回 (前800字符): ${coreRawText.slice(0, 800)}`,
        `模型原始返回 (后800字符): ${coreRawText.slice(Math.max(0, coreRawText.length - 800))}`,
        `清洗后文本 (前800字符): ${coreCleanedText.slice(0, 800)}`,
        `清洗后文本 (后800字符): ${coreCleanedText.slice(Math.max(0, coreCleanedText.length - 800))}`
      ].join('\n\n');
      throw new Error('模型没有返回可解析的剧情档案');
    }

    // 只要 core 成功，就提前准备一个“可落盘的最小档案”。
    // 这样 extras 阶段若被用户手动停止，catch 可以直接保存 core，避免整次整理成果丢失。
    coreArchiveForFallback = applyArchiveLimits({
      overview: coreArchive.overview || {},
      relationships: coreArchive.relationships || [],
      timeline: coreArchive.timeline || [],
      foreshadows: []
    }, profile);

    let rawArchive;
    if (!profile.twoStage) {
      rawArchive = coreArchive;
    } else {
      // extras 失败不致命：核心档案能落盘优先
      let extrasArchive = { foreshadows: [] };
      if (profile.limits.foreshadows > 0) {
        const coreArchiveJson = buildCoreArchiveHint(coreArchive).slice(0, 1800);
        const extrasPrompt = buildArchivePrompt(tab, title, { profile, stage: 'extras', coreArchiveJson });
        const extrasResult = await callLLM({
          model: state.selectedModel,
          messages: extrasPrompt,
          stream: true,
          temperature: 0.2,
          maxTokens: 2048,
          signal: abortController.signal,
          chunkTimeoutMs: 120000
        });

        const extrasRawText = typeof extrasResult === 'string' ? extrasResult : (extrasResult?.content || '');
        const extrasCleanedText = extrasRawText.replace(/^```json?\n?/i, '').replace(/\n?```$/, '').trim();
        try { extrasArchive = JSON.parse(extrasCleanedText); } catch (_) { extrasArchive = extractJsonFromText(extrasCleanedText); }
        if (!extrasArchive) extrasArchive = { foreshadows: [] };
      }

      rawArchive = {
        overview: coreArchive.overview || {},
        relationships: coreArchive.relationships || [],
        timeline: coreArchive.timeline || [],
        foreshadows: Array.isArray(extrasArchive.foreshadows) ? extrasArchive.foreshadows : []
      };
    }

    // CR 修复：强制按 profile 限制条目数，避免模型写多导致输出膨胀/解析失败
    rawArchive = applyArchiveLimits(rawArchive, profile);

    // 两阶段生成下，总超时必须覆盖 extras；在成功落盘前再清理 timer
    if (totalTimer) {
      clearTimeout(totalTimer);
      totalTimer = null;
    }

    const currentTab = state.tabData.list[tabId];
    if (!currentTab) {
      throw new Error('会话已被删除');
    }

    currentTab.storyArchive = normalizeArchive(rawArchive, snapshotTab, sourceMessageCount, sourceSignature);
    saveTabs();
    clearArchiveRuntimeTimers(tabId);
    setArchiveRuntime(tabId, {
      phase: ARCHIVE_PHASE_IDLE,
      detail: '',
      hint: '',
      errorMessage: '',
      errorSignature: '',
      startedAt: 0,
      lastSuccessAt: Date.now(),
      backgroundNotified: false
    });
    state.archiveAbortController = null;

    if (tabId === state.tabData.active) {
      renderStoryArchive();
    }
    if (!silent && !silentSuccess) showToast('剧情档案已更新');
    return currentTab.storyArchive;
  } catch (e) {
    console.error('剧情档案生成失败:', e);
    if (totalTimer) clearTimeout(totalTimer);
    clearArchiveRuntimeTimers(tabId);
    if (abortController.signal.aborted && !isTotalTimeout) {
      // 手动停止时，如果 core 已经成功，优先落盘 core 档案，避免两阶段 extras 中断导致整次结果丢失
      if (profile.twoStage && coreArchiveForFallback) {
        const currentTab = state.tabData.list[tabId];
        if (currentTab) {
          currentTab.storyArchive = normalizeArchive(coreArchiveForFallback, snapshotTab, sourceMessageCount, sourceSignature);
          saveTabs();
        }
        setArchiveRuntime(tabId, {
          phase: ARCHIVE_PHASE_CANCELLED,
          detail: '',
          hint: '',
          errorMessage: '',
          errorSignature: sourceSignature,
          startedAt: 0,
          lastSuccessAt: currentTab ? Date.now() : getArchiveRuntime(tabId).lastSuccessAt,
          backgroundNotified: false
        });
        state.archiveAbortController = null;
        if (!silent) showToast('已停止扩展整理，核心档案已保存');
        return currentTab?.storyArchive || null;
      }
      // 用户手动停止且尚未拿到 core，静默返回
      state.archiveAbortController = null;
      return null;
    }
    setArchiveRuntime(tabId, {
      phase: ARCHIVE_PHASE_ERROR,
      detail: '',
      hint: '',
      errorMessage: isTotalTimeout ? '整理超时（5分钟），会话内容可能过多' : (e.message || '请稍后再试'),
      errorSignature: sourceSignature,
      startedAt: 0,
      backgroundNotified: false,
      debugInfo: isTotalTimeout
        ? `消息数量: ${sourceMessageCount}\n错误: 总超时（5分钟），模型未在规定时间内返回结果`
        : (debugInfo || `错误信息: ${e.message || '未知'}`)
    });
    showToast(`剧情档案整理失败：${isTotalTimeout ? '整理超时，会话内容可能过多' : (e.message || '请稍后再试')}`);
    return null;
  } finally {
    clearInterval(countdownTimer);
    if (state.archiveGenerationTabId === tabId) {
      state.archiveGenerationTabId = null;
    }
    if (state.archiveAbortController === abortController) {
      state.archiveAbortController = null;
    }
    clearArchiveRuntimeTimers(tabId);
  }
}

export function openStoryArchivePanel() {
  const panel = document.getElementById('storyArchivePanel');
  const tab = getCurrentTab();
  if (!panel || !tab) return;
  if (!tab.storyArchive) {
    tab.storyArchive = createEmptyStoryArchive();
  }
  panel.classList.remove('hidden');
  closeSidebar();
  renderStoryArchive();
}

export function closeStoryArchivePanel() {
  const panel = document.getElementById('storyArchivePanel');
  const runtime = getArchiveRuntime(state.tabData.active);
  if (runtime.phase === ARCHIVE_PHASE_LOADING && isArchiveGeneratingForTab(state.tabData.active) && !runtime.backgroundNotified) {
    setArchiveRuntime(state.tabData.active, { backgroundNotified: true });
    showToast('剧情档案馆会继续在后台整理');
  }
  if (panel) panel.classList.add('hidden');
}

export function bindStoryArchiveEvents() {
  const closeBtn = document.getElementById('closeStoryArchiveBtn');
  const panel = document.getElementById('storyArchivePanel');
  const refreshBtn = document.getElementById('refreshStoryArchiveBtn');
  const retryBtn = document.getElementById('retryStoryArchiveBtn');
  const openBtn = document.getElementById('openStoryArchiveBtn');

  if (closeBtn) closeBtn.addEventListener('click', closeStoryArchivePanel);
  if (panel) {
    panel.addEventListener('click', (e) => {
      if (e.target === panel) closeStoryArchivePanel();
    });
  }
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      if (isArchiveGeneratingForTab(state.tabData.active)) {
        cancelStoryArchiveGeneration();
        return;
      }
      if (state.archiveGenerationTabId) {
        showToast('另一个会话正在整理中，请稍后再试');
        return;
      }
      generateStoryArchive(state.tabData.active);
    });
  }
  if (retryBtn) {
    retryBtn.addEventListener('click', () => {
      generateStoryArchive(state.tabData.active);
    });
  }
  const copyDebugBtn = document.getElementById('copyArchiveDebugBtn');
  if (copyDebugBtn) {
    copyDebugBtn.addEventListener('click', () => {
      const runtime = getArchiveRuntime(state.tabData.active);
      if (runtime.debugInfo) {
        navigator.clipboard.writeText(runtime.debugInfo).then(() => {
          showToast('调试日志已复制');
        }).catch(() => {
          showToast('复制失败，请手动复制');
        });
      }
    });
  }
  if (openBtn) {
    openBtn.addEventListener('click', () => {
      coreCall('closeComposerActionMenu', { onAfterClose: openStoryArchivePanel });
    });
  }
}

window.addEventListener('beforeunload', () => {
  cancelStoryArchiveGeneration({ silent: true });
});
