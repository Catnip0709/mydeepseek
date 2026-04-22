/**
 * llm.js — LLM API 调用模块
 *
 * 封装 DeepSeek API 的通用调用、流式调用和 JSON 调用。
 */

import { state } from './state.js';

export const CHUNK_INACTIVITY_TIMEOUT_MS = 120000;

// ========== 中止流式请求 ==========

/**
 * 中止当前 active tab 的流式请求。
 * 注意：本函数通过 state.abortController 访问器操作 active tab 的 entry，
 * 不适用于中止非 active tab 的流。若需中止指定 tab，请调用 state.js 的 `abortTabSending(tabId, reason)`。
 */
export function abortStreaming(reason) {
  state.abortReason = reason;
  if (state.abortController) {
    try { state.abortController.abort(); } catch (_) {}
  }
}

// ========== LLM 通用调用封装 ==========

export function createChunkInactivityGuard({
  timeoutMs = CHUNK_INACTIVITY_TIMEOUT_MS,
  signal = null,
  onTimeout = null
} = {}) {
  const controller = new AbortController();
  let timeoutId = null;
  let cleanedUp = false;

  function clearTimer() {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  }

  function abortInternal(reason) {
    if (!controller.signal.aborted) {
      controller.abort(reason);
    }
  }

  function schedule() {
    if (!timeoutMs || cleanedUp) return;
    clearTimer();
    timeoutId = setTimeout(() => {
      if (cleanedUp) return;
      if (onTimeout) onTimeout();
      abortInternal(new DOMException('Chunk inactivity timeout', 'AbortError'));
    }, timeoutMs);
  }

  function handleExternalAbort() {
    clearTimer();
    abortInternal(signal?.reason);
  }

  if (signal) {
    if (signal.aborted) {
      handleExternalAbort();
    } else {
      signal.addEventListener('abort', handleExternalAbort, { once: true });
    }
  }

  schedule();

  return {
    signal: controller.signal,
    touch() { schedule(); },
    cleanup() {
      cleanedUp = true;
      clearTimer();
      if (signal) signal.removeEventListener('abort', handleExternalAbort);
    }
  };
}

export async function callLLM({
  model = 'deepseek-chat',
  messages = [],
  stream = false,
  temperature = 0.7,
  maxTokens = 4096,
  signal = null,
  onChunk = null,
  chunkTimeoutMs = 0,
  onTimeout = null
} = {}) {
  const guard = createChunkInactivityGuard({ timeoutMs: chunkTimeoutMs, signal, onTimeout });
  let res;

  try {
    res = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${state.apiKey}`,
        "Cache-Control": "no-cache",
        "Pragma": "no-cache"
      },
      body: JSON.stringify({
        model,
        messages,
        stream,
        temperature,
        max_tokens: maxTokens
      }),
      signal: guard.signal
    });
    guard.touch();

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData.error?.message || '请求失败，请检查 API Key 或稍后重试');
    }

    if (!stream) {
      if (!res.body) {
        const data = await res.json();
        return data?.choices?.[0]?.message?.content || '';
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let text = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        guard.touch();
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      const data = JSON.parse(text);
      return data?.choices?.[0]?.message?.content || '';
    }

    // 流式处理：连续 timeoutMs 没有新 chunk 才超时，而不是总时长超时
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullContent = "";
    let fullReasoningContent = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      guard.touch();

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (line.trim() === "" || !line.startsWith("data: ")) continue;
        const dataStr = line.slice(6);
        if (dataStr === "[DONE]") break;

        try {
          const data = JSON.parse(dataStr);
          const delta = data.choices[0].delta;
          if (delta.reasoning_content) fullReasoningContent += delta.reasoning_content;
          if (delta.content) fullContent += delta.content;
          if (onChunk) onChunk({ content: delta.content || '', reasoningContent: delta.reasoning_content || '', fullContent, fullReasoningContent });
        } catch (e) { continue; }
      }
    }

    return { content: fullContent, reasoningContent: fullReasoningContent };
  } finally {
    guard.cleanup();
  }
}

// ========== LLM JSON 调用封装 ==========

export async function callLLMJSON({ model = 'deepseek-chat', messages = [], temperature = 0.5, maxTokens = 1024, signal = null, chunkTimeoutMs = 0, onTimeout = null } = {}) {
  const text = await callLLM({ model, messages, stream: false, temperature, maxTokens, signal, chunkTimeoutMs, onTimeout });
  const cleanedText = String(text || '').replace(/^```json?\n?/i, '').replace(/\n?```$/, '').trim();
  try {
    return JSON.parse(cleanedText);
  } catch (e) {
    const extracted = extractJsonFromText(cleanedText);
    if (extracted !== null) return extracted;
    console.warn('callLLMJSON 解析失败:', text);
    return null;
  }
}

export function extractJsonFromText(text) {
  const candidates = [];

  // 策略 1：标准提取 — 找首尾 {} 或 []
  const objectStart = text.indexOf('{');
  const objectEnd = text.lastIndexOf('}');
  if (objectStart !== -1 && objectEnd !== -1 && objectEnd > objectStart) {
    candidates.push(text.slice(objectStart, objectEnd + 1));
  }

  const arrayStart = text.indexOf('[');
  const arrayEnd = text.lastIndexOf(']');
  if (arrayStart !== -1 && arrayEnd !== -1 && arrayEnd > arrayStart) {
    candidates.push(text.slice(arrayStart, arrayEnd + 1));
  }

  // 策略 2：截断修复 — LLM 输出被 maxTokens 截断时，JSON 末尾缺少 ] 和 }
  // 从末尾向前回退，找到最后一个完整的 JSON 值，截断到那里后补全闭合符号
  if (objectStart !== -1) {
    const rawJson = text.slice(objectStart);
    let repaired = _tryRepairTruncatedJson(rawJson);
    if (repaired) candidates.push(repaired);
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (_) {}
  }
  return null;
}

/**
 * 尝试修复被截断的 JSON 字符串。
 * 策略：从前往后扫描记录每个位置是否在字符串内部，
 * 然后从后往前找第一个在字符串外部的 } 或 ] 作为安全截断点，
 * 最后补全缺失的 ] 和 }。
 */
function _tryRepairTruncatedJson(raw) {
  // 快速检查：如果没有未闭合的符号，直接返回
  let openBraces = 0, openBrackets = 0;
  for (const ch of raw) {
    if (ch === '{') openBraces++;
    else if (ch === '}') openBraces--;
    else if (ch === '[') openBrackets++;
    else if (ch === ']') openBrackets--;
  }
  if (openBraces <= 0 && openBrackets <= 0) return null;

  // 从前往后扫描，记录每个位置是否在字符串外部
  const n = raw.length;
  const outsideString = new Uint8Array(n);
  let inStr = false;

  for (let i = 0; i < n; i++) {
    if (!inStr) {
      outsideString[i] = 1;
      if (raw[i] === '"') {
        inStr = true;
      }
    } else {
      if (raw[i] === '"') {
        let bc = 0;
        let j = i - 1;
        while (j >= 0 && raw[j] === '\\') { bc++; j--; }
        if (bc % 2 === 0) {
          inStr = false;
          outsideString[i] = 1;
        }
      }
    }
  }

  // 从后往前找第一个在字符串外部的 } 或 ]
  let i = n - 1;
  while (i >= 0) {
    if (outsideString[i] && (raw[i] === '}' || raw[i] === ']')) {
      break;
    }
    i--;
  }

  if (i < 0) {
    // fallback：找不到闭合的 }/]，尝试找字符串外部的 { 或 [ 来闭合为空容器
    i = n - 1;
    while (i >= 0) {
      if (outsideString[i] && (raw[i] === '{' || raw[i] === '[')) {
        break;
      }
      i--;
    }
    if (i < 0) return null;
    return raw.substring(0, i + 1) + (raw[i] === '{' ? '}' : ']');
  }

  let trimmed = raw.substring(0, i + 1);

  // 重新计算未闭合的符号数
  openBraces = 0;
  openBrackets = 0;
  for (const ch of trimmed) {
    if (ch === '{') openBraces++;
    else if (ch === '}') openBraces--;
    else if (ch === '[') openBrackets++;
    else if (ch === ']') openBrackets--;
  }

  trimmed += ']'.repeat(Math.max(0, openBrackets)) + '}'.repeat(Math.max(0, openBraces));
  return trimmed;
}
