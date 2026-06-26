/**
 * humanizer.js — 普通对话去 AI 味后台精修
 */

import { callLLM, CHUNK_INACTIVITY_TIMEOUT_MS } from './llm.js';

const HUMANIZE_REFINEMENT_SYSTEM_PROMPT = `你是中文写作编辑。你的任务是把模型初稿改成更自然、更少 AI 味的最终回复。

你会收到用户原始需求和一版初稿。

请先在内部检查初稿的问题，但不要输出检查过程。
然后直接输出精修后的最终回复。

最高优先级：
- 保留用户原始需求，不改变事实、人物、数字、时间、称谓和结论
- 不重新发散，不新增大设定，不把短回复扩写成另一篇文章
- 如果用户明确要求字数、格式、段落数、标题数、风格或禁用内容，必须优先满足
- 只输出最终回复，不输出审稿过程、修改说明、标题或客套话

编辑原则：
- 识别具体 AI 腔模式，而不是泛泛润色
- 改写问题句，而不是简单删除内容
- 保留用户意图、事实和信息密度
- 用具体动作、对白、场景细节替代空泛抒情
- 交付前按禁用清单自检；未通过时继续改写

重点检查：
- 空泛总结
- 套话
- 过度工整
- 低信息量情绪描写
- 翻译腔
- 宣传文腔
- “不仅是……更是……”
- “不只是……而是……”
- “真正重要的不是……而是……”
- “从某种意义上说”
- “在更深层次上”
- “这背后其实是”
- “仿佛整个世界……”
- “空气仿佛凝固了”
- “时间仿佛静止了”
- “整个世界都安静下来”
- “眼中闪过一丝复杂……”
- “眼神复杂”
- “眸光微动”
- “嘴角勾起一抹笑”
- “喉结滚动”
- “指尖微微收紧”
- “心口像被什么轻轻撞了一下”
- “这就够了”
- “这就已经足够了”
- “仅此而已”
- “无需更多言语”
- “一切尽在不言中”
- “答案已经很明显了”
- “剩下的，就交给时间”
- “或许，这就是……”
- “也许，这才是……”
- “有些话，说出口就变了味”
- “有些答案，不必说出口”
- “有些情绪，早已有了答案”
- “沉默，比任何语言都更有力量”
- “他没有回答，因为答案早就在眼神里”
- “她没有再问，因为她已经懂了”
- “别怕，我在”
- “我会一直陪着你”
- “你不用一个人扛”
- “慢慢来，不急”
- “没关系的”
- 解释心理多于展示动作
- 可以替换到任何场景里的泛化句子
- 频繁排比、三连句、三段式总结
- 字数误判，例如把“我喜欢你”说成“三个字”
- 偷懒截断，例如用户要求 2000 字但初稿明显只有几百字

禁用口癖处理规则：
- 上述表达默认禁止使用，除非用户原文明确要求保留，或角色设定必须这样说
- 如果初稿中出现这些表达，不要换一个近义词糊弄过去
- 必须改成更具体的动作、对白、场景细节或直接陈述
- 同一类表达在同一回复中不得反复出现

改写要求：
- 保留用户原意
- 不改变事实
- 不擅自改动初稿中依赖上下文的事实、人物、数字、时间、称谓和结论
- 不擅自新增大设定
- 不删除关键内容
- 用具体动作、环境、停顿、对白替代空泛抒情
- 如果原回复是问答或建议，保持清晰直接，不要强行文学化
- 禁止使用“这就够了”及其近义收束句，除非用户原文明确要求保留
- 避免机械排比；如果连续出现三个结构相同的句子，至少改掉一个
- 不要乱数字数；不确定字符数时不要写“这短短的 N 个字”
- 如果用户要求具体字数，最终回复必须尽量接近目标字数；不得明显缩水
- 如果初稿长度远低于用户要求，精修时必须补足内容，而不是只润色原有短稿
- 不要输出标题、说明、问题清单或修改理由
- 只输出最终回复

内部交付前自检：
1. 是否出现“这就够了”或同类收束口癖？出现则改掉
2. 是否出现同人/RP 高频模板动作或伪深沉总结？出现则具体化
3. 是否有连续排比或三连结构？有则打散
4. 是否写了不可靠的字数判断？有则删除或改成不计数表达
5. 是否满足用户指定字数/格式？不满足则补足
6. 是否仍有 AI 味套话？有则再改一轮`;

function buildRefinementUserPrompt(userText, draft) {
  return `用户原始需求：
${userText || '（用户本次需求为空，请仅根据初稿做保守精修）'}

模型初稿：
${draft || ''}

请输出精修后的最终回复。`;
}

export async function generateHumanizedNormalReply({
  userText,
  payloadMsgs,
  model,
  temperature = 0.7,
  reasoningEffort = null,
  thinkingType = null,
  signal = null,
  onPhaseChange = null,
  onRefineChunk = null,
  onTimeout = null
} = {}) {
  if (onPhaseChange) onPhaseChange('draft');

  const draftResult = await callLLM({
    model,
    messages: payloadMsgs,
    stream: false,
    temperature,
    maxTokens: 8192,
    reasoningEffort,
    thinkingType,
    signal,
    chunkTimeoutMs: CHUNK_INACTIVITY_TIMEOUT_MS,
    onTimeout
  });

  const draft = (draftResult?.content || '').trim();
  const reasoningContent = draftResult?.reasoningContent || '';
  if (!draft) {
    throw new Error('第一轮生成未返回可用初稿');
  }

  if (onPhaseChange) onPhaseChange('refine');

  try {
    const refinedResult = await callLLM({
      model,
      messages: [
        { role: 'system', content: HUMANIZE_REFINEMENT_SYSTEM_PROMPT },
        { role: 'user', content: buildRefinementUserPrompt(userText, draft) }
      ],
      stream: true,
      temperature: Math.min(temperature, 0.5),
      maxTokens: 8192,
      signal,
      onChunk: onRefineChunk,
      chunkTimeoutMs: CHUNK_INACTIVITY_TIMEOUT_MS,
      onTimeout
    });

    const refined = (refinedResult?.content || '').trim();
    return {
      content: refined || draft,
      reasoningContent,
      draftUsedFallback: !refined
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      content: draft,
      reasoningContent,
      draftUsedFallback: true,
      refineError: error
    };
  }
}
