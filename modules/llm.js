/**
 * llm.js — LLM API 调用模块
 *
 * 封装 DeepSeek API 的通用调用、流式调用和 JSON 调用。
 */

import { state } from './state.js';

export const CHUNK_INACTIVITY_TIMEOUT_MS = 120000;

// ========== 中止流式请求 ==========

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

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (_) {}
  }
  return null;
}
