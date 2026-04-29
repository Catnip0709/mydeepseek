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
  tools = null,
  toolChoice = 'auto',
  reasoningEffort = null,
  thinkingType = null,
  signal = null,
  onChunk = null,
  onToolCallReady = null,
  chunkTimeoutMs = 0,
  onTimeout = null
} = {}) {
  const guard = createChunkInactivityGuard({ timeoutMs: chunkTimeoutMs, signal, onTimeout });
  let res;
  const allowReasoning = thinkingType === 'enabled';

  try {
    const bodyPayload = {
      model,
      messages,
      stream,
      temperature,
      max_tokens: maxTokens,
      ...(tools ? { tools, tool_choice: toolChoice } : {}),
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      ...(thinkingType ? { thinking: { type: thinkingType } } : {})
    };
    res = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${state.apiKey}`,
        "Cache-Control": "no-cache",
        "Pragma": "no-cache"
      },
      body: JSON.stringify(bodyPayload),
      signal: guard.signal
    });
    guard.touch();

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}));
      throw new Error(errorData.error?.message || '请求失败，请检查 API Key 或稍后重试');
    }

    if (!stream) {
      let data;
      if (!res.body) {
        data = await res.json();
      } else {
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
        data = JSON.parse(text);
      }

      const message = data?.choices?.[0]?.message || {};
      const toolCalls = message.tool_calls || null;

      // 如果有 tool_calls，标准化为与流式一致的格式
      const normalizedToolCalls = toolCalls ? toolCalls.map(tc => ({
        id: tc.id,
        type: tc.type || 'function',
        function: { name: tc.function.name, arguments: tc.function.arguments }
      })) : null;

      return {
        content: message.content || '',
        reasoningContent: allowReasoning ? (message.reasoning_content || '') : '',
        toolCalls: normalizedToolCalls,
        finishReason: data?.choices?.[0]?.finish_reason || null
      };
    }

    // 流式处理：连续 timeoutMs 没有新 chunk 才超时，而不是总时长超时
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullContent = "";
    let fullReasoningContent = "";
    let fullToolCalls = []; // 收集流式 tool_calls
    let lastCompletedToolIdx = -1; // 上一个已通过回调推送的 tool_call index
    let finishReason = null;

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
          // 捕获本 chunk 的 finish_reason；OpenAI/DeepSeek 在最后一个 data: 块上给 finish_reason
          const fr = data.choices[0].finish_reason;
          if (fr) finishReason = fr;
          if (allowReasoning && delta.reasoning_content) fullReasoningContent += delta.reasoning_content;
          if (delta.content) fullContent += delta.content;

          // 流式 tool_calls 收集：按 index 拼接 function name 和 arguments
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!fullToolCalls[idx]) {
                fullToolCalls[idx] = { id: tc.id || '', type: tc.type || 'function', function: { name: '', arguments: '' } };
              }
              if (tc.id) fullToolCalls[idx].id = tc.id;
              if (tc.type) fullToolCalls[idx].type = tc.type;
              if (tc.function?.name) fullToolCalls[idx].function.name += tc.function.name;
              if (tc.function?.arguments) fullToolCalls[idx].function.arguments += tc.function.arguments;
            }

            // 即时推送已完成的 tool_call：当出现更高 index 时，之前的都已完成
            if (onToolCallReady) {
              const maxIdx = Math.max(...delta.tool_calls.map(tc => tc.index ?? 0));
              for (let i = lastCompletedToolIdx + 1; i < maxIdx; i++) {
                const completed = fullToolCalls[i];
                if (completed && completed.function && completed.function.name) {
                  onToolCallReady(completed);
                  lastCompletedToolIdx = i;
                }
              }
            }
          }

          if (onChunk) onChunk({
            content: delta.content || '',
            reasoningContent: allowReasoning ? (delta.reasoning_content || '') : '',
            fullContent,
            fullReasoningContent,
            toolCalls: delta.tool_calls || null
          });
        } catch (e) { continue; }
      }
    }

    // 流结束后，推送最后一个 tool_call（如果有）
    if (onToolCallReady && fullToolCalls.length > 0) {
      for (let i = lastCompletedToolIdx + 1; i < fullToolCalls.length; i++) {
        const completed = fullToolCalls[i];
        if (completed && completed.function && completed.function.name) {
          onToolCallReady(completed);
          lastCompletedToolIdx = i;
        }
      }
    }

    // 过滤掉空 tool_calls（可能因流式拼接产生空条目）
    fullToolCalls = fullToolCalls.filter(tc => tc && tc.function && tc.function.name);

    return { content: fullContent, reasoningContent: fullReasoningContent, toolCalls: fullToolCalls.length > 0 ? fullToolCalls : null, finishReason };
  } finally {
    guard.cleanup();
  }
}

// ========== LLM JSON 调用封装 ==========

export async function callLLMJSON({ model = 'deepseek-chat', messages = [], temperature = 0.5, maxTokens = 1024, signal = null, chunkTimeoutMs = 0, onTimeout = null } = {}) {
  const result = await callLLM({ model, messages, stream: false, temperature, maxTokens, signal, chunkTimeoutMs, onTimeout });
  const text = typeof result === 'string' ? result : (result?.content || '');
  const cleanedText = text.replace(/^```json?\n?/i, '').replace(/\n?```$/, '').trim();
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

// ========== Agent 循环（Tool Calling） ==========

/**
 * Agent 模式调用：模型可以自主调用工具，执行后把结果喂回模型继续生成。
 * 循环直到模型返回纯文字内容（不再请求工具调用）或达到最大轮数。
 *
 * @param {Object} options
 * @param {Array} options.messages - 初始消息列表（会被修改）
 * @param {Array} options.tools - 工具定义列表（OpenAI function calling 格式）
 * @param {Function} options.toolExecutor - (name, args) => string|object|Promise<string|object> 工具执行函数
 * @param {number} [options.maxRounds=5] - 最大工具调用轮数
 * @param {Function} [options.onToolCall] - (name, args, result) 每次工具调用后的回调
 * @param {Object} [options.callLLMOptions] - 透传给 callLLM 的其他参数
 * @returns {Promise<{content: string, reasoningContent: string, toolCallLog: Array}>}
 */
export async function callLLMAgent({
  messages,
  tools = [],
  toolExecutor,
  maxRounds = 5,
  onToolCall = null,
  toolChoice = 'auto',
  ...callLLMOptions
} = {}) {
  if (!tools || tools.length === 0 || !toolExecutor) {
    // 没有 tools，退化为普通调用
    const result = await callLLM(callLLMOptions);
    return {
      content: typeof result === 'string' ? result : (result?.content || ''),
      reasoningContent: result?.reasoningContent || '',
      toolCallLog: []
    };
  }

  // 复制 messages，避免修改原始数组
  let msgs = messages.map(m => ({ ...m }));
  const toolCallLog = [];
  let rounds = 0;

  function parseToolArgs(tc) {
    try {
      return JSON.parse(tc.function.arguments);
    } catch (_) {
      return {};
    }
  }

  function normalizeToolResult(toolResult) {
    return typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);
  }

  while (rounds < maxRounds) {
    // 本轮已执行的 tool_call，按 tool_call_id 去重，避免“同名同参但不同 id”的合法重复调用被误合并
    const executedToolCalls = new Map();

    function getToolExecutionKey(tc) {
      // OpenAI/DeepSeek 正常情况下会给每个 tool_call 一个唯一 id。
      // 若流式早期/异常情况下 id 缺失，则退化为“当前 tc 对象引用”做轮内去重，
      // 至少保证同一个 tool_call 在 onToolCallReady + 后续补 messages 阶段不会被双执行。
      return tc?.id ? `id:${tc.id}` : tc;
    }

    const executeToolCall = (tc) => {
      const toolCallId = tc?.id || '';
      const executionKey = getToolExecutionKey(tc);
      if (executedToolCalls.has(executionKey)) {
        return executedToolCalls.get(executionKey);
      }

      const funcName = tc?.function?.name || '';
      const funcArgs = parseToolArgs(tc);
      const executionPromise = (async () => {
        let toolResult;
        try {
          toolResult = await toolExecutor(funcName, funcArgs);
        } catch (e) {
          toolResult = `工具执行错误: ${e.message}`;
        }

        const resultStr = normalizeToolResult(toolResult);
        toolCallLog.push({ toolCallId, name: funcName, args: funcArgs, result: resultStr });
        if (onToolCall) {
          try {
            onToolCall(funcName, funcArgs, resultStr);
          } catch (e) {
            console.warn('[Agent] onToolCall 回调执行失败:', e);
          }
        }
        return { toolCallId, funcName, funcArgs, resultStr };
      })();

      executedToolCalls.set(executionKey, executionPromise);
      return executionPromise;
    };

    const result = await callLLM({
      ...callLLMOptions,
      messages: msgs,
      tools,
      toolChoice,
      stream: true, // 强制流式，实现即时 tool 执行
      onToolCallReady(completedToolCall) {
        // tool_call 完成时立即执行，不等流结束
        // 这里不能再假设 toolExecutor 一定同步；统一走 executeToolCall，
        // 同时按 tool_call_id 去重，避免“同名同参但不同 id”的重复调用被误合并。
        void executeToolCall(completedToolCall);
      }
    });

    const content = typeof result === 'string' ? result : (result?.content || '');
    const reasoningContent = result?.reasoningContent || '';
    const toolCalls = result?.toolCalls || null;

    // 模型没有请求工具调用 → 返回最终文字
    if (!toolCalls || toolCalls.length === 0) {
      return { content, reasoningContent, toolCallLog };
    }

    // 模型请求了工具调用 → 构建 messages（tool 结果已在 onToolCallReady 中异步追加到 toolCallLog）
    // 但 messages 需要同步追加，所以这里同步执行 tool 并追加
    msgs.push({
      role: 'assistant',
      content: content || null,
      tool_calls: toolCalls.map(tc => ({
        id: tc.id,
        type: tc.type || 'function',
        function: { name: tc.function.name, arguments: tc.function.arguments }
      }))
    });

    for (const tc of toolCalls) {
      const { resultStr } = await executeToolCall(tc);
      msgs.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: resultStr
      });
    }

    rounds++;
  }

  // 超过最大轮数，最后调一次让模型总结（不传 tools，强制文字输出）
  const final = await callLLM({
    ...callLLMOptions,
    messages: msgs,
    tools: null
  });

  return {
    content: typeof final === 'string' ? final : (final?.content || ''),
    reasoningContent: final?.reasoningContent || '',
    toolCallLog
  };
}

// ========== HTML 自动续写 ==========

/**
 * 判断一段文本是否已经形成"闭合"的 HTML（以 </html> 结尾，允许尾部空白/换行）。
 */
function isHtmlClosed(text) {
  if (!text) return false;
  return /<\/html\s*>\s*$/i.test(text.trim());
}

/**
 * 剥离 assistant 已生成文本末尾可能的 markdown 围栏（续写上下文用）。
 */
function stripTrailingFence(text) {
  if (!text) return '';
  return text.replace(/```\s*$/i, '').trimEnd();
}

/**
 * 自动续写调用：内部多轮调 callLLM，直到 HTML 闭合或达到最大轮数。
 *
 * @param {Object} opts
 * @param {string} opts.model
 * @param {Array}  opts.messages          - 初始 system + user（不含 assistant）
 * @param {number} [opts.maxRounds]       - 最大续写轮数，默认 6
 * @param {number} [opts.maxTokensPerRound] - 每轮 max_tokens，默认 8192
 * @param {number} [opts.temperature]
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.chunkTimeoutMs]
 * @param {Function} [opts.onStatus]  - ({ round, totalChars, lastPiece }) => void
 * @param {Function} [opts.onChunk]   - 每个 chunk 回调（通常外层不直接渲染）
 * @param {Function} [opts.isDoneFn]  - (fullText) => boolean 自定义完成判断
 * @returns {Promise<{content:string, finishReason:string|null, rounds:number, truncated:boolean}>}
 */
export async function callLLMWithAutoContinue({
  model = 'deepseek-chat',
  messages = [],
  maxRounds = 6,
  maxTokensPerRound = 8192,
  temperature = 0.3,
  signal = null,
  chunkTimeoutMs = CHUNK_INACTIVITY_TIMEOUT_MS,
  onStatus = null,
  onChunk = null,
  isDoneFn = null
} = {}) {
  const doneFn = typeof isDoneFn === 'function' ? isDoneFn : isHtmlClosed;
  let fullText = '';
  let lastFinishReason = null;
  let round = 0;

  while (round < maxRounds) {
    if (signal?.aborted) break;

    if (onStatus) {
      try {
        onStatus({ round: round + 1, totalChars: fullText.length, lastPiece: '' });
      } catch (_) {}
    }

    // 续写时使用裁剪过的已生成内容作为 assistant 上下文，避免带上 markdown 围栏
    const roundMessages = round === 0
      ? messages
      : [
          ...messages,
          { role: 'assistant', content: stripTrailingFence(fullText) },
          {
            role: 'user',
            content:
              '刚才的 HTML 输出被长度上限截断了。请严格从上次中断的那一个字符开始继续输出，' +
              '不要重复任何已有内容，不要道歉、不要解释、不要再次输出 ```html 代码块围栏，' +
              '直接接着写，直到以 </html> 结尾。'
          }
        ];

    const result = await callLLM({
      model,
      messages: roundMessages,
      stream: true,
      temperature,
      maxTokens: maxTokensPerRound,
      signal,
      chunkTimeoutMs,
      onChunk: onChunk
        ? (() => {
            let roundAccum = 0;
            return (payload) => {
              roundAccum += (payload?.content?.length || 0);
              try {
                onChunk({
                  ...payload,
                  totalChars: fullText.length + roundAccum,
                  round: round + 1
                });
              } catch (_) {}
            };
          })()
        : null
    });

    const piece = typeof result === 'string' ? result : (result?.content || '');
    fullText += piece;
    lastFinishReason = result?.finishReason || null;
    round++;

    if (onStatus) {
      try {
        onStatus({ round, totalChars: fullText.length, lastPiece: piece });
      } catch (_) {}
    }

    const closed = doneFn(fullText);
    if (closed && lastFinishReason !== 'length') break;

    // 死循环防御：本轮产出过少（<4 字符），说明模型已经无话可说或遇到异常，直接退出
    if (round > 0 && piece.length < 4) break;

    // 模型自己停早了（stop 但未闭合）→ 再续 1 轮
    if (lastFinishReason === 'stop' && !closed) continue;

    // length 截断 → 继续续写
    if (lastFinishReason === 'length') continue;

    // 未知情况：若内容已经闭合则结束
    if (closed) break;
  }

  return {
    content: fullText,
    finishReason: lastFinishReason,
    rounds: round,
    truncated: !doneFn(fullText)
  };
}
