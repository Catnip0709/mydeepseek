/**
 * llm.js — LLM API 调用模块
 *
 * 封装 DeepSeek API 的通用调用、流式调用和 JSON 调用。
 */

import { state } from './state.js';

// ========== 中止流式请求 ==========

export function abortStreaming(reason) {
  state.abortReason = reason;
  if (state.abortController) {
    try { state.abortController.abort(); } catch (_) {}
  }
}

// ========== LLM 通用调用封装 ==========

export async function callLLM({ model = 'deepseek-chat', messages = [], stream = false, temperature = 0.7, maxTokens = 4096, signal = null, onChunk = null } = {}) {
  const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
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
    signal
  });

  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}));
    throw new Error(errorData.error?.message || '请求失败，请检查 API Key 或稍后重试');
  }

  if (!stream) {
    const data = await res.json();
    return data?.choices?.[0]?.message?.content || '';
  }

  // 流式处理
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullContent = "";
  let fullReasoningContent = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

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
}

// ========== LLM JSON 调用封装 ==========

export async function callLLMJSON({ model = 'deepseek-chat', messages = [], temperature = 0.5, maxTokens = 1024, signal = null } = {}) {
  const text = await callLLM({ model, messages, stream: false, temperature, maxTokens, signal });
  try {
    return JSON.parse(text.replace(/^```json?\n?/i, '').replace(/\n?```$/, '').trim());
  } catch (e) {
    console.warn('callLLMJSON 解析失败:', text);
    return null;
  }
}
