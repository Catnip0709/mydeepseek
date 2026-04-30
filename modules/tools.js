/**
 * tools.js — Agent 工具定义
 *
 * 定义所有可供 LLM 通过 function calling 调用的工具 schema。
 * 工具的实际执行逻辑在 agent.js 的 toolExecutor 中。
 */

// ========== 群聊专用工具 ==========

/**
 * character_reply：角色以自身身份回复。
 * 模型调用此工具来"说话"，而不是直接在 content 中输出文字。
 */
export const TOOL_CHARACTER_REPLY = {
  type: 'function',
  function: {
    name: 'character_reply',
    description: '以某个角色的身份回复。每次调用代表一个角色说了一段话。每个角色在本次编排中最多回复 3 次。重要：dialogue 只写角色真正说出口的台词；动作、神态、视线变化、停顿、语气提示、心理描写必须写到 action，不要混入 dialogue。action 会最终渲染成单独一行的全角括号格式，例如：（抬眸看了你一眼）。',
    parameters: {
      type: 'object',
      properties: {
        character_name: {
          type: 'string',
          description: '发言的角色名称，必须是群聊中存在的角色'
        },
        dialogue: {
          type: 'string',
          description: '角色真正说出口的台词正文，只能写说出来的话。不要包含动作、神态、视线、心理描写，也不要写“某某皱眉道/低声说/看了你一眼”这类舞台说明。错误示例："紫英皱了皱眉，看着你说，这事不对"；正确示例："这事不对。"'
        },
        action: {
          type: 'string',
          description: '角色的动作或神态描写（可选），只写舞台说明，不要写台词正文。例如："微微皱眉"、"转身看向窗外"、"眸光微凝，指尖轻轻收紧"。如果没有动作就留空，不要把动作并入 dialogue。系统会将这里渲染为：（动作描写）。'
        },
        emotion: {
          type: 'string',
          description: '角色当前的情绪状态（可选），如"愤怒"、"温柔"、"无奈"'
        }
      },
      required: ['character_name', 'dialogue']
    }
  }
};

/**
 * narrate：旁白/叙述者描写场景。
 */
export const TOOL_NARRATE = {
  type: 'function',
  function: {
    name: 'narrate',
    description: '以旁白/叙述者身份描写场景、环境变化、动作细节。适合用于场景切换、人物动作衔接、多人沉默对视或气氛变化时串联剧情，保持简短，不要滥用。',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: '叙述内容，简洁生动，不要太长'
        }
      },
      required: ['content']
    }
  }
};

/**
 * 群聊可用的全部工具
 */
export const GROUPCHAT_TOOLS = [
  TOOL_CHARACTER_REPLY,
  TOOL_NARRATE
];

// ========== 通用记忆/档案工具（未来普通对话可用） ==========

export const TOOL_QUERY_ARCHIVE = {
  type: 'function',
  function: {
    name: 'query_story_archive',
    description: '查询当前对话的剧情档案，获取角色关系、事件时间线、伏笔等结构化信息。注意：highlights（名场面）板块已废弃，仅用于兼容旧数据，新生成的档案不再包含此板块。',
    parameters: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          enum: ['overview', 'relationships', 'timeline', 'foreshadows', 'highlights'],
          description: '要查询的档案板块。highlights（名场面）已废弃，仅用于兼容旧数据。'
        },
        keyword: {
          type: 'string',
          description: '可选，筛选关键词，如角色名或事件名'
        }
      },
      required: ['section']
    }
  }
};

export const TOOL_GET_CHARACTER_INFO = {
  type: 'function',
  function: {
    name: 'get_character_info',
    description: '获取角色卡的详细信息，包括性格、背景、说话风格等',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '角色名称' }
      },
      required: ['name']
    }
  }
};

export const TOOL_GET_SUMMARY = {
  type: 'function',
  function: {
    name: 'get_conversation_summary',
    description: '获取当前对话的记忆摘要，了解之前发生过什么',
    parameters: {
      type: 'object',
      properties: {},
      required: []
    }
  }
};

export const MEMORY_TOOLS = [
  TOOL_QUERY_ARCHIVE,
  TOOL_GET_CHARACTER_INFO,
  TOOL_GET_SUMMARY
];

// ========== 群聊增强工具 ==========

/**
 * search_conversation：搜索当前对话历史，找到包含关键词的消息。
 * 角色可以引用之前说过的话，避免编造。
 */
export const TOOL_SEARCH_CONVERSATION = {
  type: 'function',
  function: {
    name: 'search_conversation',
    description: '搜索当前对话的历史消息，找到包含关键词的内容。用于引用之前说过的话或查找特定事件。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索关键词'
        },
        limit: {
          type: 'number',
          description: '最多返回几条匹配结果，默认 5'
        }
      },
      required: ['query']
    }
  }
};

/**
 * get_all_characters：获取所有可用角色列表。
 * 模型可以了解有哪些角色，或建议新角色加入对话。
 */
export const TOOL_GET_ALL_CHARACTERS = {
  type: 'function',
  function: {
    name: 'get_all_characters',
    description: '获取所有已创建的角色列表（名称和简介），用于了解有哪些角色可用',
    parameters: {
      type: 'object',
      properties: {},
      required: []
    }
  }
};

/**
 * 群聊稳妥版工具集：
 * 保留发言能力和必要的长程检索，移除容易抢轮次的冗余查询工具。
 */
export const GROUPCHAT_TOOLS_STABLE = [
  TOOL_CHARACTER_REPLY,
  TOOL_NARRATE,
  TOOL_SEARCH_CONVERSATION,
  TOOL_QUERY_ARCHIVE
];
