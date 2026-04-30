/**
 * groupchat.js — 群聊模块
 *
 * 负责群聊的路由判断、角色回复生成、追问判断、编排主函数、
 * 群聊消息发送、以及群聊创建面板的管理。
 */

import { state, MEMORY_STRATEGY_FULL, setTabSending, clearTabSending, getEffectiveModel } from './state.js';
import { escapeHtml, limitSentences, deleteIconSvg, copyIconSvg, trackEvent, generateMessageId, formatRoleplayReply } from './utils.js';
import { callLLM, callLLMJSON, callLLMAgent, CHUNK_INACTIVITY_TIMEOUT_MS } from './llm.js';
import { saveTabs, generateNewTabId, tabHasUsableSummary } from './storage.js';
import { showToast, closeSidebar, hideReplyBar } from './panels.js';
import { renderMarkdown } from './markdown.js';
import { call as coreCall } from './core.js';
import { GROUPCHAT_TOOLS_STABLE } from './tools.js';
import { groupchatToolExecutor } from './agent.js';

import { isHtmlRelatedMessage } from './utils.js';

const GROUPCHAT_MAX_SPEAKS_PER_CHARACTER = 3;
const GROUPCHAT_MAX_ROUNDS = 30;
const GROUPCHAT_MAX_SENTENCES = 6;
const GROUPCHAT_AGENT_MAX_TOKENS = 3072;

function escapeRegex(str = '') {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getMentionedCharacters(text, characters = []) {
  const source = String(text || '');
  if (!source.trim()) return [];
  return characters.filter(char => {
    const name = String(char?.name || '').trim();
    if (!name) return false;
    return new RegExp(escapeRegex(name), 'i').test(source);
  });
}

function inferAgentParticipantPlan(userMessage, characters) {
  const text = String(userMessage || '');
  const mentionedCharacters = getMentionedCharacters(text, characters);
  const mentionedCount = mentionedCharacters.length;
  const singleScenePattern = /(只有我和|只有咱们|只剩下我和|私下对话|私底下单独|单独聊聊|独处|房间里只剩|回到房间后只剩|悄悄说|悄悄告诉|单线交流|只有我们两个人)/i;
  const publicScenePattern = /(大家|你们|所有人|众人|全员|一起|都在场|围观|起哄|争执|吵|对峙|会议|讨论|商量|任务|审判|七嘴八舌|同时看向|纷纷)/i;
  const clearlySingle = singleScenePattern.test(text);
  const allowExpansion = !clearlySingle && (publicScenePattern.test(text) || mentionedCount >= 3 || characters.length >= 4);
  const minParticipants = clearlySingle ? 1 : Math.min(2, characters.length);
  const softTargetParticipants = clearlySingle
    ? 1
    : allowExpansion
      ? Math.min(Math.max(3, mentionedCount || 3), Math.min(4, characters.length))
      : Math.min(2, characters.length);

  return {
    minParticipants,
    softTargetParticipants,
    allowExpansion,
    clearlySingle,
    mentionedCharacterIds: mentionedCharacters.map(char => char.id)
  };
}

// ========== Step 1: 路由判断 ==========

async function routeMessage(userMessage, characters, history, signal = null, replyInfo = null, llmTimeoutOptions = {}) {
  if (replyInfo && replyInfo.characterId) {
    const targetIdx = characters.findIndex(c => c.id === replyInfo.characterId);
    if (targetIdx >= 0) {
      const otherIndices = await routeMessageByLLM(userMessage, characters, history, signal, replyInfo, llmTimeoutOptions);
      const combined = [targetIdx, ...otherIndices.filter(i => i !== targetIdx)];
      return combined;
    }
  }
  return await routeMessageByLLM(userMessage, characters, history, signal, null, llmTimeoutOptions);
}

async function routeMessageByLLM(userMessage, characters, history, signal, replyInfo, llmTimeoutOptions = {}) {
  const charSummaries = characters.map((c, i) => `${i + 1}. ${c.name}：${c.summary || c.personality || '无描述'}`).join('\n');

  let extraRule = '';
  if (replyInfo) {
    extraRule = `\n8. 用户正在回复${replyInfo.characterName}，${replyInfo.characterName}已经在回答中，不需要再选它`;
  }

  const messages = [
    {
      role: "system",
      content: `你是一个群聊路由器。根据用户消息和群聊中的角色，判断哪些角色应该回答。
规则：
1. 仔细分析用户消息的语境和场景设定
2. 如果用户消息暗示了只有某些角色在场（如"只有我和XX"、"私下对话"、"回到房间"等），只选在场角色回答
3. 如果用户消息明确排除了某个角色（如"XX不在"、"没有XX"、"XX还没来"、"XX在外面"等），该角色绝对不能回答
4. 如果消息只和某个角色相关，只选那个
5. 如果消息是泛泛的（如打招呼），可以选所有角色
6. 至少选一个角色回答
7. 场景设定优先：如果用户说某个角色"不在"、"还没来"、"在外面"，即使话题与该角色相关，也不要选该角色${extraRule}
只输出 JSON 数组，包含角色编号，例如 [1] 或 [1,2]，不要输出其他内容。`
    },
    {
      role: "user",
      content: `群聊角色：\n${charSummaries}\n\n用户说：${userMessage}`
    }
  ];

  const result = await callLLMJSON({ model: state.selectedModel, messages, temperature: 0.3, maxTokens: 50, signal, ...llmTimeoutOptions });
  if (!result || !Array.isArray(result)) return [0];

  const indices = result.map(n => parseInt(n) - 1).filter(n => n >= 0 && n < characters.length);
  return indices.length > 0 ? indices : [0];
}

// ========== Step 2: 角色回答生成 ==========

export async function generateCharacterReply(character, userMessage, history, allCharacters, options = {}) {
  const otherChars = allCharacters.filter(c => c.id !== character.id);
  const otherCharsInfo = otherChars.length > 0
    ? '\n群聊中还有其他角色：' + otherChars.map(c => c.name).join('、')
    : '';

  // 群聊背景信息注入
  const groupContext = options.groupContext || {};
  const userRoleInfo = groupContext.userRoleName
    ? `\n用户在群聊中的角色是「${groupContext.userRoleName}」，请以此称呼用户。`
    : '';
  const storyBgInfo = groupContext.storyBackground
    ? `\n当前故事背景：${groupContext.storyBackground}\n请在回复中自然地融入当前的场景和背景设定。`
    : '';
  const summaryInfo = groupContext.summary
    ? `\n\n【对话记忆摘要】\n${groupContext.summary}`
    : '';
  const bannedWords = String(groupContext.bannedWords || '')
    .split(/[\n,，、;；]+/)
    .map(w => w.trim())
    .filter(Boolean);
  const bannedWordsInfo = bannedWords.length
    ? `\n\n【写作偏好硬规则】\n1. 全文禁止出现以下词语：${bannedWords.join('、')}\n2. 若自然想写到这些词，必须换一种表达\n3. 输出前自检一遍，若出现禁用词原文，先改写后再输出`
    : '';

  const recentHistory = history.filter(m => !isHtmlRelatedMessage(m)).slice(-20).map(m => {
    if (m.role === 'user') return `用户：${m.content}`;
    if (m.role === 'character') return `${m.characterName || '角色'}：${m.content}`;
    if (m.role === 'assistant') return `AI：${m.content}`;
    return '';
  }).filter(Boolean).join('\n');

  const roundReplies = options.currentRoundReplies || [];
  const llmTimeoutOptions = options.llmTimeoutOptions || {};
  const roundContext = roundReplies.length > 0
    ? '\n本轮对话：\n' + roundReplies.map(r => `${r.characterName}：${r.content}`).join('\n')
    : '';

  const messages = [
    {
      role: "system",
      content: `你是${character.name}。
性格：${character.personality || '无特殊设定'}
背景：${character.background || '无'}
外貌：${character.appearance || '无'}
说话风格：${character.speakingStyle || '自然'}
口头禅参考（仅供参考语气，不要刻意堆砌）：${(character.catchphrases || []).join('、') || '无'}${otherCharsInfo}${userRoleInfo}${storyBgInfo}${summaryInfo}${bannedWordsInfo}

规则：
1. 严格以${character.name}的身份和性格回复
2. 保持角色一致性，不要出戏
3. 回复自然口语化，像真人聊天，不要像背台词
4. 最多说6句话，宁可多给一点有信息量的回应，也不要只敷衍一句
5. 如果有动作、神态、视线、停顿等描写，请单独放在前一行，并使用全角括号包裹，例如：` + '\n（抬眸看了她一眼）' + `\n下一行再写真正说出口的台词
6. 不要重复其他角色已经说过的话，要给出新的回应
7. 口头禅偶尔使用即可，不要每句话都带，更不要生硬插入
8. 注意场景设定：如果用户描述了某些角色不在场，你不在场时不要发言`
    },
    {
      role: "user",
      content: (recentHistory ? `最近对话：\n${recentHistory}\n\n` : '') +
               (roundContext ? `${roundContext}\n\n` : '') +
               `用户说：${userMessage}`
    }
  ];

  const charTemp = character.talkativeness ?? 0.8;

  if (options.stream && options.onChunk) {
    const result = await callLLM({
      model: options.model || state.selectedModel,
      messages,
      stream: true,
      temperature: charTemp,
      maxTokens: 1024,
      signal: options.signal,
      onChunk: options.onChunk,
      ...llmTimeoutOptions
    });
    if (typeof result === 'string') return limitSentences(formatRoleplayReply(result), GROUPCHAT_MAX_SENTENCES);
    return { ...result, content: formatRoleplayReply(result?.content || '') };
  }

  const reply = await callLLM({
    model: options.model || state.selectedModel,
    messages,
    stream: false,
    temperature: charTemp,
    maxTokens: 1024,
    signal: options.signal,
    ...llmTimeoutOptions
  });

  if (typeof reply === 'string') return limitSentences(formatRoleplayReply(reply), GROUPCHAT_MAX_SENTENCES);
  return { ...reply, content: formatRoleplayReply(reply?.content || '') };
}

// ========== Step 3: 追问判断 ==========

export async function shouldFollowUp(lastReplies, otherCharacter, userMessage, speakCount = 0, signal = null, llmTimeoutOptions = {}) {
  const lastReplyText = lastReplies.map(r => `${r.characterName}：${r.content}`).join('\n');

  const messages = [
    {
      role: "system",
      content: `你判断群聊中一个角色是否需要对其他角色的发言做出回应。
只回答"是"或"否"，不要输出其他内容。
判断标准：
- 默认先看“你是否会自然接话”，不要过度保守
- 如果用户消息暗示了某些角色不在场（如"只有我和XX"、"私下对话"、"回到房间"等），不在场的角色必须回答"否"
- 如果对方的话直接点名你、质疑你、提到你、或者与你产生明显互动，优先回答"是"
- 如果当前话题与你强相关、你会自然插嘴、补充信息能推进气氛或剧情，也可以回答"是"
- 如果对方的话只是普通闲聊、你已经表达过类似观点、或者话题与你关系很弱，回答"否"
- 如果场景是私密的或你不在场，即使话题与你相关也回答"否"
- 避免无意义附和，但允许自然的短接话、吐槽、追问、补充`
    },
    {
      role: "user",
      content: `你是${otherCharacter.name}（${otherCharacter.summary || otherCharacter.personality || ''}）。
你本轮已经说过${speakCount}次话了。
其他角色刚说了：\n${lastReplyText}\n
用户说：${userMessage}\n
你需要回应吗？`
    }
  ];

  const result = await callLLM({ model: state.selectedModel, messages, temperature: 0.3, maxTokens: 10, signal, ...llmTimeoutOptions });
  const resultText = typeof result === 'string' ? result : (result?.content || '');
  return resultText.trim().includes('是');
}

// ========== 编排主函数（流式） ==========

export async function orchestrateGroupChat(userMessage, characters, history, options = {}) {
  const { onCharacterStart, onCharacterChunk, onCharacterEnd, signal, model, replyInfo, groupContext } = options;
  const allReplies = [];
  const llmTimeoutOptions = options.llmTimeoutOptions || {};

  // 构建角色回复的公共 options
  const charOptions = { signal, model, groupContext, llmTimeoutOptions };

  // Step 1: 路由判断
  let speakerIndices;
  try {
    speakerIndices = await routeMessage(userMessage, characters, history, signal, replyInfo, llmTimeoutOptions);
  } catch (e) {
    if (e.name === 'AbortError') return allReplies;
    throw e;
  }

  // Step 2: 逐个角色生成回答
  for (const idx of speakerIndices) {
    if (signal && signal.aborted) break;
    const character = characters[idx];

    if (onCharacterStart) onCharacterStart(character, idx);

    let reply;
    try {
      reply = await generateCharacterReply(character, userMessage, history, characters, {
        ...charOptions,
        stream: !!onCharacterChunk,
        onChunk: onCharacterChunk ? (chunk) => onCharacterChunk(character, idx, chunk) : null,
          currentRoundReplies: allReplies
      });
    } catch (e) {
      if (e.name === 'AbortError') break;
      throw e;
    }

    const content = typeof reply === 'string' ? reply : reply.content;
    allReplies.push({ characterId: character.id, characterName: character.name, content: limitSentences(content || '', GROUPCHAT_MAX_SENTENCES) });

    if (onCharacterEnd) onCharacterEnd(character, idx, content);
  }

  // Step 3: 多轮互动循环
  if (allReplies.length > 0 && characters.length > 1) {
    for (let round = 0; round < GROUPCHAT_MAX_ROUNDS; round++) {
      if (signal && signal.aborted) break;

      const lastReply = allReplies[allReplies.length - 1];
      const lastSpeakerId = lastReply.characterId;
      const otherChars = characters.filter(c => c.id !== lastSpeakerId);

      let anyoneSpoke = false;

      for (const otherChar of otherChars) {
        if (signal && signal.aborted) break;

        const speakCount = allReplies.filter(r => r.characterId === otherChar.id).length;
        if (speakCount >= GROUPCHAT_MAX_SPEAKS_PER_CHARACTER) continue;

        let needFollow;
        try {
          needFollow = await shouldFollowUp([lastReply], otherChar, userMessage, speakCount, signal, llmTimeoutOptions);
        } catch (e) {
          if (e.name === 'AbortError') break;
          throw e;
        }
        if (needFollow) {
          if (onCharacterStart) onCharacterStart(otherChar, characters.indexOf(otherChar));

          let reply;
          try {
            reply = await generateCharacterReply(otherChar, userMessage, history, characters, {
              ...charOptions,
              stream: !!onCharacterChunk,
              onChunk: onCharacterChunk ? (chunk) => onCharacterChunk(otherChar, characters.indexOf(otherChar), chunk) : null,
              currentRoundReplies: allReplies
            });
          } catch (e) {
            if (e.name === 'AbortError') break;
            throw e;
          }

          const content = typeof reply === 'string' ? reply : reply.content;
          allReplies.push({ characterId: otherChar.id, characterName: otherChar.name, content: limitSentences(content || '', GROUPCHAT_MAX_SENTENCES) });

          if (onCharacterEnd) onCharacterEnd(otherChar, characters.indexOf(otherChar), content);
          anyoneSpoke = true;
          break;
        }
      }

      if (!anyoneSpoke) break;
    }
  }

  return allReplies;
}

// ========== Agent 编排（Tool Calling 模式） ==========

/**
 * Agent 模式群聊编排：模型通过 character_reply / narrate 工具自主决定谁说话、说什么。
 * 替代硬编码的"路由→回复→追问"三步流程。
 */
export async function orchestrateGroupChatAgent(userMessage, characters, history, options = {}) {
  const { onCharacterStart, onCharacterChunk, onCharacterEnd, onFallbackReset, signal, model, reasoningEffort, thinkingType, groupContext, tabId, replyInfo } = options;
  const llmTimeoutOptions = options.llmTimeoutOptions || {};
  const allReplies = [];
  const participantPlan = inferAgentParticipantPlan(userMessage, characters);
  const replyTargetCharacter = replyInfo?.characterId
    ? characters.find(c => c.id === replyInfo.characterId) || null
    : null;
  const replyTargetId = replyTargetCharacter?.id || '';
  const replyTargetName = replyTargetCharacter?.name || '';
  let replyTargetSatisfied = !replyTargetId;
  const bufferedRepliesBeforeTarget = [];

  function formatAction(action) {
    const text = String(action || '').trim();
    if (!text) return '';
    if ((text.startsWith('（') && text.endsWith('）')) || (text.startsWith('(') && text.endsWith(')'))) {
      return text;
    }
    return `（${text}）`;
  }

  // 回复追踪器：记录每个角色本轮发言次数
  const replyTracker = {};

  // 构建角色信息摘要（注入 system prompt）
  const charInfos = characters.map(c => {
    const parts = [`【${c.name}】`];
    if (c.personality) parts.push(`性格：${c.personality}`);
    if (c.background) parts.push(`背景：${c.background}`);
    if (c.speakingStyle) parts.push(`说话风格：${c.speakingStyle}`);
    if (c.catchphrases?.length) parts.push(`口头禅：${c.catchphrases.join('、')}`);
    return parts.join('\n');
  }).join('\n\n');

  // 群聊背景信息
  const userRoleInfo = groupContext?.userRoleName
    ? `\n用户在群聊中的角色是「${groupContext.userRoleName}」，请以此称呼用户。`
    : '';
  const storyBgInfo = groupContext?.storyBackground
    ? `\n当前故事背景：${groupContext.storyBackground}`
    : '';
  const summaryInfo = groupContext?.summary
    ? `\n\n【对话记忆摘要】\n${groupContext.summary}`
    : '';
  const bannedWords = String(groupContext?.bannedWords || '')
    .split(/[\n,，、;；]+/)
    .map(w => w.trim())
    .filter(Boolean);
  const bannedWordsInfo = bannedWords.length
    ? `\n\n【写作偏好硬规则】\n- 全文禁止出现以下词语：${bannedWords.join('、')}\n- character_reply / narrate 的所有输出都不得出现这些词\n- 若自然想写到这些词，必须换一种表达\n- 输出前自检禁用词，发现后先改写再提交工具调用`
    : '';
  const replyTargetInfo = replyTargetId
    ? `\n\n【本次引用回复】\n- 用户这次是在明确回复「${replyTargetName}」\n- 你必须让「${replyTargetName}」先发言\n- 第一条 character_reply 必须是「${replyTargetName}」\n- 在「${replyTargetName}」说完之前，不要让其他角色发言，也不要先 narrate`
    : '';

  // 最近对话历史
  const recentHistory = history.filter(m => !isHtmlRelatedMessage(m)).slice(-20).map(m => {
    if (m.role === 'user') return `用户：${m.content}`;
    if (m.role === 'character') return `${m.characterName || '角色'}：${m.content}`;
    return '';
  }).filter(Boolean).join('\n');

  const systemPrompt = `你是一个群聊导演。你控制群聊中所有角色的发言。
${charInfos}
${userRoleInfo}${storyBgInfo}${summaryInfo}${bannedWordsInfo}${replyTargetInfo}

规则：
1. 所有可见输出都必须通过 character_reply 或 narrate 工具产生，不要在 assistant content 里直接输出角色台词、旁白、解释或总结
2. 每个角色在本次用户输入触发的整次编排中最多发言 3 次
3. 回复自然口语化，像真人聊天，不要像背台词；dialogue 里不要加引号，动作由 action 字段提供，最终会渲染成全角括号格式
4. 口头禅偶尔使用即可，不要刻意堆砌
5. 如果用户消息暗示了某些角色不在场，不在场的角色不能发言
6. 如果用户正在回复某个特定角色，该角色必须发言；若你已知被回复角色是谁，则第一条 character_reply 必须来自该角色。注意：这只决定谁先说，不等于整轮只能由一个角色完成回应
7. 本轮最低参与人数是 ${participantPlan.minParticipants} 个不同角色；在达到这个人数之前，不要过早结束
8. 本轮理想参与人数是 ${participantPlan.softTargetParticipants} 个不同角色；若场景存在围观、争执、多人共同任务、多人都与话题强相关等情况，可自然扩张到这个范围
9. 只有在明确私聊/独处/其他角色明显不在场时，才允许只由 1 个角色完成回应；只是点名或引用某个角色，不自动视为单人场景
10. 达到最低人数后，也不要机械收尾；如果仍有明显自然接话者，就继续让相关角色回应、追问、吐槽或补充
11. 不要为了凑人数让无关角色硬插话；但也不要让第一个角色说完就停
12. 当场景切换、人物动作衔接、多人沉默/对视、气氛变化明显时，可以穿插 0-1 条简短 narrate 串联气氛
13. 不要连续使用 narrate，也不要写成长篇旁白
14. search_conversation 和 query_story_archive 仅在当前注入上下文不足、确实需要补查旧信息时才调用，不要先手滥用检索工具抢占轮次
15. 不要重复其他角色已经说过的话
16. character_reply 的字段职责必须严格分离：
   - dialogue：只写角色真正说出口的台词
   - action：只写动作、神态、视线变化、停顿等舞台说明
   - 不要把动作、神态、心理描写混进 dialogue
17. 错误示例：
   - dialogue: "慕容紫英眸光微凝，指尖收紧了几分。这封印确实古怪。"
   - action: ""
18. 正确示例：
   - dialogue: "这封印确实古怪。"
   - action: "眸光微凝，指尖收紧了几分"
19. 如果没有动作，就让 action 为空；不要为了省事把动作写进 dialogue。
20. 最终显示格式应尽量接近：
   - （眸光微凝，指尖收紧了几分）
   - 这封印确实古怪。`;

  const messages = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: (recentHistory ? `最近对话：\n${recentHistory}\n\n` : '')
        + (replyTargetId ? `本次引用回复：用户正在回复「${replyTargetName}」${replyInfo?.snippet ? `，被引用内容是：${replyInfo.snippet}` : ''}\n\n` : '')
        + `用户说：${userMessage}`
    }
  ];

  // 执行上下文：传给 toolExecutor
  const executorContext = { characters, replyTracker, messages: history, tabId, replyInfo };

  function emitToolReply(name, parsed) {
    let character;
    let idx;
    let fullContent = '';

    if (name === 'character_reply') {
      character = characters.find(c => c.id === parsed.character_id);
      if (!character) return false;
      idx = characters.indexOf(character);
      const content = parsed.dialogue || '';
      const action = formatAction(parsed.action);
      fullContent = formatRoleplayReply([action, content].filter(Boolean).join('\n'));
    } else {
      // narrate 不再吞掉：落成一条“旁白”消息，便于用户感知 Agent 正在做事。
      // 使用伪角色对象复用现有渲染/存储链路，但打上 isNarration 标记，避免显示“回复”按钮。
      character = { id: '__narrator__', name: '旁白', isNarration: true };
      idx = -1;
      fullContent = formatRoleplayReply(String(parsed.content || '').trim());
    }

    if (!fullContent) return false;

    if (onCharacterStart) onCharacterStart(character, idx);

    // Agent 模式下工具调用是同步返回的（非流式），直接渲染完整内容
    if (onCharacterChunk) {
      onCharacterChunk(character, idx, { content: fullContent, fullContent });
    }

    allReplies.push({
      characterId: character.id,
      characterName: character.name,
      content: limitSentences(fullContent, GROUPCHAT_MAX_SENTENCES),
      isNarration: !!character.isNarration
    });

    if (onCharacterEnd) onCharacterEnd(character, idx, fullContent);
    return true;
  }

  async function emitSupplementReply(character) {
    if (!character || signal?.aborted) return false;
    const idx = characters.indexOf(character);
    if (idx < 0) return false;

    if (onCharacterStart) onCharacterStart(character, idx);

    let reply;
    try {
      reply = await generateCharacterReply(character, userMessage, history, characters, {
        signal,
        model: model || state.selectedModel,
        groupContext,
        llmTimeoutOptions,
        stream: !!onCharacterChunk,
        onChunk: onCharacterChunk ? (chunk) => onCharacterChunk(character, idx, chunk) : null,
        currentRoundReplies: allReplies
      });
    } catch (e) {
      if (e.name === 'AbortError') return false;
      throw e;
    }

    const content = typeof reply === 'string' ? reply : reply.content;
    const finalContent = limitSentences(formatRoleplayReply(content || ''), GROUPCHAT_MAX_SENTENCES);
    if (!finalContent) return false;

    allReplies.push({
      characterId: character.id,
      characterName: character.name,
      content: finalContent
    });

    if (onCharacterEnd) onCharacterEnd(character, idx, finalContent);
    return true;
  }

  async function ensureMinimumParticipants() {
    if (signal?.aborted || participantPlan.minParticipants <= 1) return;
    const spokenIds = new Set(allReplies.filter(reply => !reply.isNarration).map(reply => reply.characterId));
    if (spokenIds.size >= participantPlan.minParticipants) return;

    let candidateIndices = [];
    try {
      candidateIndices = await routeMessageByLLM(userMessage, characters, history, signal, null, llmTimeoutOptions);
    } catch (e) {
      if (e.name === 'AbortError') return;
      throw e;
    }

    const orderedCandidates = candidateIndices
      .map(idx => characters[idx])
      .filter(Boolean);
    const mentionedCandidates = characters.filter(char => participantPlan.mentionedCharacterIds.includes(char.id));
    const followUpCandidates = [];
    const fallbackCandidates = characters.filter(char => char && !spokenIds.has(char.id));
    const latestReplies = allReplies.filter(reply => !reply.isNarration).slice(-2);

    for (const character of characters) {
      if (!character || spokenIds.has(character.id)) continue;
      const speakCount = allReplies.filter(reply => reply.characterId === character.id).length;
      if (speakCount >= GROUPCHAT_MAX_SPEAKS_PER_CHARACTER) continue;
      try {
        const needFollow = latestReplies.length > 0
          ? await shouldFollowUp(latestReplies, character, userMessage, speakCount, signal, llmTimeoutOptions)
          : false;
        if (needFollow) followUpCandidates.push(character);
      } catch (e) {
        if (e.name === 'AbortError') return;
        throw e;
      }
    }

    const candidatePools = [orderedCandidates, mentionedCandidates, followUpCandidates, fallbackCandidates];
    const attemptedIds = new Set();

    for (const pool of candidatePools) {
      for (const candidate of pool) {
        if (spokenIds.size >= participantPlan.minParticipants) break;
        if (!candidate || spokenIds.has(candidate.id) || attemptedIds.has(candidate.id)) continue;
        attemptedIds.add(candidate.id);
        const speakCount = allReplies.filter(reply => reply.characterId === candidate.id).length;
        if (speakCount >= GROUPCHAT_MAX_SPEAKS_PER_CHARACTER) continue;

        const appended = await emitSupplementReply(candidate);
        if (appended) spokenIds.add(candidate.id);
      }
      if (spokenIds.size >= participantPlan.minParticipants) break;
    }
  }

  try {
    const result = await callLLMAgent({
      messages,
      tools: GROUPCHAT_TOOLS_STABLE,
      toolExecutor: (name, args) => groupchatToolExecutor(name, args, executorContext),
      maxRounds: GROUPCHAT_MAX_ROUNDS,
      toolChoice: 'required',
      model: model || state.selectedModel,
      reasoningEffort,
      thinkingType,
      temperature: 0.8,
      // 导演只需要产出 tool_calls（而不是长篇文字），maxTokens 太大会让模型“想很久/写很长”才出手。
      // 下调上限可以明显降低首条输出延迟与 token 消耗。
      maxTokens: GROUPCHAT_AGENT_MAX_TOKENS,
      stream: true,
      signal,
      chunkTimeoutMs: llmTimeoutOptions.chunkTimeoutMs || 0,
      onTimeout: llmTimeoutOptions.onTimeout || null,
      onToolCall(name, args, resultStr) {
        // 工具调用回调：处理 character_reply / narrate，创建 DOM 并渲染
        if (name !== 'character_reply' && name !== 'narrate') return;

        let parsed;
        try { parsed = JSON.parse(resultStr); } catch (_) { return; }
        if (!parsed.success) return;

        if (!replyTargetSatisfied) {
          const isTargetReply = name === 'character_reply' && parsed.character_id === replyTargetId;
          if (!isTargetReply) {
            bufferedRepliesBeforeTarget.push({ name, parsed });
            return;
          }
          replyTargetSatisfied = true;
          emitToolReply(name, parsed);
          while (bufferedRepliesBeforeTarget.length > 0) {
            const buffered = bufferedRepliesBeforeTarget.shift();
            emitToolReply(buffered.name, buffered.parsed);
          }
          return;
        }

        emitToolReply(name, parsed);
      }
    });

    if (!replyTargetSatisfied) {
      if (allReplies.length > 0) {
        return allReplies;
      }
      if (onFallbackReset) onFallbackReset();
      allReplies.length = 0;
      return await orchestrateGroupChat(userMessage, characters, history, options);
    }

    // 如果模型直接输出了文字（没用工具），作为旁白处理
    if (result.content && allReplies.length === 0) {
      // 模型没有调用任何工具，fallback 到传统编排
      if (onFallbackReset) onFallbackReset();
      allReplies.length = 0;
      return await orchestrateGroupChat(userMessage, characters, history, options);
    }

    await ensureMinimumParticipants();

  } catch (e) {
    if (e.name === 'AbortError') return allReplies;
    // 已经有角色/旁白出声后，不再回退传统编排，避免已渲染内容被 reset 后产生“撤回感”。
    if (allReplies.length > 0) {
      console.warn('[Agent] 群聊 Agent 模式中途失败，保留已生成回复，不回退传统编排:', e.message);
      return allReplies;
    }
    // Agent 模式失败且尚未产出任何回复，fallback 到传统编排
    console.warn('[Agent] 群聊 Agent 模式失败，回退到传统编排:', e.message);
    if (onFallbackReset) onFallbackReset();
    allReplies.length = 0;
    return await orchestrateGroupChat(userMessage, characters, history, options);
  }

  return allReplies;
}

// ========== 群聊消息发送（由 chat 模块调用） ==========

export async function sendGroupMessage(tabId, userMessage, replyInfo) {
  const chat = document.getElementById("chat");
  const { model: selectedModel, reasoningEffort, thinkingType } = getEffectiveModel();

  const lockedTabId = tabId;

  // 按 tab 隔离的发送状态
  const tabEntry = setTabSending(lockedTabId, {
    isSending: true,
    abortReason: null,
    abortController: new AbortController()
  });
  coreCall('updateComposerPrimaryButtonState');

  trackEvent('发送消息');

  const signal = tabEntry.abortController.signal;
  const llmTimeoutOptions = {
    chunkTimeoutMs: CHUNK_INACTIVITY_TIMEOUT_MS,
    onTimeout() {
      tabEntry.abortReason = 'timeout';
    }
  };

  const currentTab = state.tabData.list[lockedTabId];
  const characters = (currentTab.characterIds || []).map(id => coreCall('getCharacterById', id)).filter(Boolean);
  if (characters.length === 0) {
    clearTabSending(lockedTabId);
    coreCall('updateComposerPrimaryButtonState');
    return;
  }

  // 获取群聊背景信息 + 摘要（全量模式不使用摘要）
  const useSummary = state.memoryStrategy !== MEMORY_STRATEGY_FULL && tabHasUsableSummary(currentTab);
  const groupContext = {
    userRoleName: currentTab.userRoleName || '',
    storyBackground: currentTab.storyBackground || '',
    bannedWords: currentTab.bannedWords || '',
    summary: useSummary ? currentTab.summary : ''
  };

  const currentMsgs = currentTab.messages || [];
  const history = currentMsgs;
  let shouldCheckSummary = false;
  let pendingReplies = [];
  let typingIndicatorEl = null;

  // 群聊流式 DOM 隔离（对齐单聊 CR-1 / CR2-B/C / CR3-E 的处理）：
  // 1) liveRenderBroken 粘性标志：一旦切走 tab 或目标节点游离，永久关闭 live render；
  // 2) currentCharacterMsgBox 闭包引用：onCharacterChunk 直接用该引用，不再 querySelectorAll 取
  //    "最后一个 .character-msg"（跨 tab 时会误中 tab B 的历史群聊消息，造成 DOM 污染）。
  let liveRenderBroken = false;
  let currentCharacterMsgBox = null;
  let currentCharacterMsgId = null;

  function resetPreviewReplies() {
    pendingReplies = [];
    currentCharacterMsgBox = null;
    if (typingIndicatorEl) {
      try { typingIndicatorEl.remove(); } catch (_) {}
      typingIndicatorEl = null;
    }
    if (state.tabData.active === lockedTabId) {
      coreCall('renderChat');
    } else {
      coreCall('invalidateTabCache', lockedTabId);
    }
  }

  function commitPendingReplies() {
    if (!pendingReplies.length) return;
    const targetTab = state.tabData.list[lockedTabId];
    if (!targetTab) return;
    const msgs = targetTab.messages || [];
    msgs.push(...pendingReplies);
    targetTab.messages = msgs;
    pendingReplies = [];
    saveTabs();
    coreCall('markStoryArchiveStale', lockedTabId);
  }

  function shouldAutoScroll() {
    // 用户在底部附近才跟随滚动，避免打断用户向上翻历史
    return chat.scrollTop + chat.clientHeight >= chat.scrollHeight - 80;
  }

  function ensureTypingIndicator() {
    if (liveRenderBroken || state.tabData.active !== lockedTabId) return;
    if (!typingIndicatorEl) {
      typingIndicatorEl = document.createElement('div');
      typingIndicatorEl.className = 'group-agent-typing my-2 px-6';
      typingIndicatorEl.innerHTML = `
        <div class="group-agent-typing-inner max-w-2xl mx-auto">
          <span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>
        </div>
      `;
    }
    // 确保始终在最底部
    if (typingIndicatorEl.parentNode !== chat || typingIndicatorEl !== chat.lastElementChild) {
      chat.appendChild(typingIndicatorEl);
    }
  }

  function removeTypingIndicator() {
    if (typingIndicatorEl) {
      try { typingIndicatorEl.remove(); } catch (_) {}
      typingIndicatorEl = null;
    }
  }

  try {
    // Agent 群聊：首次 tool_call 之前可能长时间没有可渲染输出。
    // 用底部 typing 三点作为“正在编排中”提示（不落盘，结束即清理）。
    ensureTypingIndicator();

    const replies = await orchestrateGroupChatAgent(userMessage, characters, history, {
      signal,
      replyInfo,
      tabId: lockedTabId,
      model: selectedModel,
      reasoningEffort,
      thinkingType,
      groupContext,
      llmTimeoutOptions,
      onFallbackReset: resetPreviewReplies,
      onCharacterStart(character, idx) {
        // 每次新 character 回复开始：先刷新粘性标志
        if (state.tabData.active !== lockedTabId) liveRenderBroken = true;

        if (liveRenderBroken) {
          // 已切走：不创建 DOM 节点，避免 chat.appendChild 把节点插入到非 lockedTabId 的 #chat 上
          // （原实现会把本属于 tab A 的群聊消息直接插进 tab B 的 DOM，造成用户可见的污染）。
          currentCharacterMsgBox = null;
          currentCharacterMsgId = null;
          removeTypingIndicator();
          return;
        }

        // 有输出开始了，typing 依然保留在底部，但要保证永远在最底部
        const autoScroll = shouldAutoScroll();

        const msgIndex = currentMsgs.length + pendingReplies.length;
        const msgId = generateMessageId();
        currentCharacterMsgId = msgId;
        const msgBox = document.createElement("div");
        msgBox.id = `msg-${msgIndex}`;
        msgBox.dataset.messageId = msgId;
        if (character.isNarration) {
          msgBox.className = 'group-narration my-3 px-6';
          msgBox.innerHTML = `<div class="msg-content group-narration-content max-w-2xl mx-auto"></div>`;
        } else {
          const color = coreCall('getCharacterColor', idx);
          msgBox.className = `message-box character-msg p-3 rounded-xl bg-gray-800 mr-auto max-w-[85%] text-white`;
          msgBox.style.setProperty('border-left-color', color, 'important');
          msgBox.innerHTML = `
            <div class="character-msg-label" style="background:${color}20;color:${color}">${escapeHtml(character.name)}</div>
            <button class="delete-btn" data-index="${msgIndex}" title="删除">${deleteIconSvg}</button>
            <button class="copy-btn" data-index="${msgIndex}" title="复制">${copyIconSvg}</button>
            <div class="msg-content prose prose-invert max-w-none"></div>
          `;
        }
        chat.appendChild(msgBox);
        currentCharacterMsgBox = msgBox;
        ensureTypingIndicator();
        if (autoScroll) chat.scrollTop = chat.scrollHeight;
      },
      onCharacterChunk(character, idx, chunk) {
        // 粘性检查：active 切走 / msgBox 游离（例如搜索触发 renderChat 清空 #chat）均永久关闭 live render
        if (state.tabData.active !== lockedTabId ||
            !currentCharacterMsgBox ||
            !currentCharacterMsgBox.isConnected) {
          liveRenderBroken = true;
          removeTypingIndicator();
          return;
        }
        const contentDiv = currentCharacterMsgBox.querySelector('.msg-content');
        if (contentDiv && chunk.fullContent) {
          const autoScroll = shouldAutoScroll();
          renderMarkdown(contentDiv, chunk.fullContent);
          ensureTypingIndicator();
          if (autoScroll) chat.scrollTop = chat.scrollHeight;
        }
      },
      onCharacterEnd(character, idx, content) {
        const msgId = currentCharacterMsgId || generateMessageId();
        currentCharacterMsgId = null;
        pendingReplies.push({
          id: msgId,
          role: "character",
          characterId: character.id,
          characterName: character.name,
          isNarration: !!character.isNarration,
          content: content || '',
          generationState: tabEntry.abortReason === 'timeout' ? 'timeout' : (tabEntry.abortReason ? 'interrupted' : 'complete'),
          history: [{ content: content || '', reasoningContent: '', state: tabEntry.abortReason === 'timeout' ? 'timeout' : (tabEntry.abortReason ? 'interrupted' : 'complete') }],
          historyIndex: 0
        });
        // 本角色回复已完成，下一个 character 会由 onCharacterStart 重新赋值或置空
        currentCharacterMsgBox = null;
        ensureTypingIndicator();
        if (shouldAutoScroll()) chat.scrollTop = chat.scrollHeight;
      }
    });
    commitPendingReplies();
    shouldCheckSummary = !tabEntry.abortReason && Array.isArray(replies) && replies.length > 0;
  } catch (e) {
    removeTypingIndicator();
    if (e.name === 'AbortError') {
      commitPendingReplies();
    }
    if (e.name !== 'AbortError') {
      if (pendingReplies.length > 0) {
        commitPendingReplies();
      }
      console.error('群聊发送错误:', e);
      showToast('群聊发送失败：' + e.message);
    }
  } finally {
    removeTypingIndicator();
    // 按 lockedTabId 清理发送状态（active tab 可能已切走）
    clearTabSending(lockedTabId);
    coreCall('updateComposerPrimaryButtonState');
    // 仅当 active tab 仍是 lockedTabId 时才重刷 DOM
    if (state.tabData.active === lockedTabId) {
      coreCall('renderChat');
    } else {
      coreCall('invalidateTabCache', lockedTabId);
    }

    // 异步检查是否需要生成/更新摘要
    if (shouldCheckSummary) {
      import('./summary.js').then(({ checkAndGenerateSummary }) => {
        checkAndGenerateSummary(tabId).catch(() => {});
      });
    }
  }
}

// ========== 群聊面板管理 ==========

export function openCreateGroupPanel() {
  if (state.characterData.length < 2) {
    showToast('至少需要创建 2 个角色才能创建群聊');
    return;
  }
  const createGroupPanel = document.getElementById('createGroupPanel');
  const createGroupNameInput = document.getElementById('createGroupNameInput');
  createGroupPanel.classList.remove('hidden');
  createGroupNameInput.value = '';
  renderCreateGroupCharacterList();
}

export function closeCreateGroupPanel() {
  const createGroupPanel = document.getElementById('createGroupPanel');
  createGroupPanel.classList.add('hidden');
}

// ========== 背景信息面板（通用） ==========

export function openBgInfoPanel() {
  const panel = document.getElementById('bgInfoPanel');
  const roleInput = document.getElementById('bgInfoRoleInput');
  const bgInput = document.getElementById('bgInfoStoryInput');
  const bannedWordsInput = document.getElementById('bgInfoBannedWordsInput');
  const currentTab = state.tabData.list[state.tabData.active];

  if (!currentTab) return;

  roleInput.value = currentTab.userRoleName || '';
  bgInput.value = currentTab.storyBackground || '';
  if (bannedWordsInput) bannedWordsInput.value = currentTab.bannedWords || '';
  panel.classList.remove('hidden');
  setTimeout(() => roleInput.focus(), 30);
}

export function closeBgInfoPanel() {
  const panel = document.getElementById('bgInfoPanel');
  if (panel) panel.classList.add('hidden');
}

export function saveBgInfo() {
  const roleInput = document.getElementById('bgInfoRoleInput');
  const bgInput = document.getElementById('bgInfoStoryInput');
  const bannedWordsInput = document.getElementById('bgInfoBannedWordsInput');
  const currentTab = state.tabData.list[state.tabData.active];

  if (!currentTab) return;

  currentTab.userRoleName = roleInput.value.trim();
  currentTab.storyBackground = bgInput.value.trim();
  currentTab.bannedWords = bannedWordsInput ? bannedWordsInput.value.trim() : '';
  saveTabs();
  closeBgInfoPanel();
  updateBgInfoChip();
  showToast('背景信息已保存');
}

export function updateBgInfoChip() {
  // 按钮样式与深度思考一致，无需根据状态切换样式
}

export function renderCreateGroupCharacterList() {
  const createGroupCharacterList = document.getElementById('createGroupCharacterList');
  createGroupCharacterList.innerHTML = '';
  state.selectedGroupCharacterIds.clear();
  state.characterData.forEach(char => {
    const div = document.createElement('div');
    div.className = 'group-char-select-item';
    div.dataset.id = char.id;
    div.innerHTML = `
      <label class="flex items-center gap-3 cursor-pointer p-2 rounded-lg hover:bg-gray-800 transition-colors">
        <input type="checkbox" class="group-char-checkbox w-4 h-4" value="${char.id}">
        <div class="flex-1 min-w-0">
          <div class="text-sm text-white font-medium">${escapeHtml(char.name)}</div>
          <div class="text-xs text-gray-500">${escapeHtml(char.summary || '暂无描述')}</div>
        </div>
      </label>
    `;
    createGroupCharacterList.appendChild(div);
  });

  document.querySelectorAll('.group-char-checkbox').forEach(cb => {
    cb.addEventListener('change', function() {
      if (this.checked) state.selectedGroupCharacterIds.add(this.value);
      else state.selectedGroupCharacterIds.delete(this.value);
    });
  });
}

export function createGroupChat() {
  if (state.selectedGroupCharacterIds.size < 2) {
    showToast('请至少选择 2 个角色');
    return;
  }
  const createGroupNameInput = document.getElementById('createGroupNameInput');
  const groupTitle = createGroupNameInput.value.trim() || '群聊';
  const charIds = Array.from(state.selectedGroupCharacterIds);

  coreCall('clearPendingTextAttachment');
  const newId = generateNewTabId();

  state.tabData.list[newId] = {
    type: 'group',
    characterIds: charIds,
    messages: [],
    title: groupTitle,
    storyArchive: null
  };
  state.tabData.active = newId;
  saveTabs();
  coreCall('renderChat');
  coreCall('renderTabs');
  coreCall('updateInputCounter');
  closeCreateGroupPanel();
  closeSidebar();
  showToast('群聊已创建');
}

// ========== 群聊事件绑定 ==========

export function bindGroupChatEvents() {
  const closeCreateGroupBtn = document.getElementById('closeCreateGroupBtn');
  const createGroupPanel = document.getElementById('createGroupPanel');
  const createGroupConfirmBtn = document.getElementById('createGroupConfirmBtn');
  const openCharacterFromGroupBtn = document.getElementById('openCharacterFromGroupBtn');
  const characterSelectPanel = document.getElementById('characterSelectPanel');
  const closeCharacterSelectBtn = document.getElementById('closeCharacterSelectBtn');
  const cancelCreateGroupBtn = document.getElementById('cancelCreateGroupBtn');

  if (closeCreateGroupBtn) closeCreateGroupBtn.addEventListener('click', closeCreateGroupPanel);
  if (createGroupPanel) createGroupPanel.addEventListener('click', (e) => { if (e.target === createGroupPanel) closeCreateGroupPanel(); });
  if (createGroupConfirmBtn) createGroupConfirmBtn.addEventListener('click', createGroupChat);
  if (cancelCreateGroupBtn) cancelCreateGroupBtn.addEventListener('click', closeCreateGroupPanel);

  // 角色选择面板事件
  if (closeCharacterSelectBtn) closeCharacterSelectBtn.addEventListener('click', () => { if (characterSelectPanel) characterSelectPanel.classList.add('hidden'); });
  if (characterSelectPanel) characterSelectPanel.addEventListener('click', (e) => { if (e.target === characterSelectPanel) characterSelectPanel.classList.add('hidden'); });

  // 从群聊面板打开角色卡管理
  if (openCharacterFromGroupBtn) openCharacterFromGroupBtn.addEventListener('click', () => {
    closeCreateGroupPanel();
    coreCall('openCharacterPanel');
  });

  // 背景信息面板事件
  const bgInfoPanel = document.getElementById('bgInfoPanel');
  const closeBgInfoBtn = document.getElementById('closeBgInfoBtn');
  const cancelBgInfoBtn = document.getElementById('cancelBgInfoBtn');
  const saveBgInfoBtn = document.getElementById('saveBgInfoBtn');
  const openBgInfoBtn = document.getElementById('openBgInfoBtn');

  if (closeBgInfoBtn) closeBgInfoBtn.addEventListener('click', closeBgInfoPanel);
  if (cancelBgInfoBtn) cancelBgInfoBtn.addEventListener('click', closeBgInfoPanel);
  if (saveBgInfoBtn) saveBgInfoBtn.addEventListener('click', saveBgInfo);
  if (bgInfoPanel) bgInfoPanel.addEventListener('click', (e) => { if (e.target === bgInfoPanel) closeBgInfoPanel(); });
  if (openBgInfoBtn) openBgInfoBtn.addEventListener('click', openBgInfoPanel);
}
