/**
 * agent.js — Agent 工具执行器
 *
 * 实现 toolExecutor 函数，将工具调用分派到对应的处理逻辑。
 * 通过 core.js 的 call 访问其他模块，避免循环依赖。
 */

import { state } from './state.js';
import { call as coreCall } from './core.js';

/**
 * 群聊 toolExecutor：处理 character_reply、narrate、search_conversation、get_all_characters。
 *
 * @param {string} name - 工具名称
 * @param {Object} args - 工具参数
 * @param {Object} context - 执行上下文
 * @param {Array} context.characters - 群聊角色列表
 * @param {Object} context.replyTracker - 回复追踪器 { [charId]: count }
 * @param {Array} [context.messages] - 当前对话消息列表（用于 search_conversation）
 * @param {string} [context.tabId] - 当前 tab ID（用于记忆工具查询档案/摘要）
 * @returns {string} 工具执行结果
 */
export function groupchatToolExecutor(name, args, context = {}) {
  const { characters = [], replyTracker = {}, messages = [], tabId } = context;

  switch (name) {
    case 'character_reply': {
      const charName = String(args.character_name || '').trim();
      const dialogue = String(args.dialogue || '').trim();

      if (!charName || !dialogue) {
        return JSON.stringify({ success: false, error: '缺少 character_name 或 dialogue' });
      }

      const character = characters.find(c => c.name === charName);
      if (!character) {
        return JSON.stringify({ success: false, error: `角色"${charName}"不在群聊中` });
      }

      // 检查发言次数限制（每角色在本次编排中最多 3 次）
      const speakCount = replyTracker[character.id] || 0;
      if (speakCount >= 3) {
        return JSON.stringify({ success: false, error: `${charName}本次编排已发言${speakCount}次，不能再发言` });
      }

      replyTracker[character.id] = speakCount + 1;

      return JSON.stringify({
        success: true,
        character_id: character.id,
        character_name: character.name,
        dialogue,
        action: String(args.action || '').trim(),
        emotion: String(args.emotion || '').trim()
      });
    }

    case 'narrate': {
      const content = String(args.content || '').trim();
      if (!content) {
        return JSON.stringify({ success: false, error: '缺少 content' });
      }

      return JSON.stringify({
        success: true,
        content
      });
    }

    case 'search_conversation': {
      const query = String(args.query || '').trim().toLowerCase();
      const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 10);

      if (!query) {
        return JSON.stringify({ success: false, error: '缺少 query' });
      }

      const results = [];
      for (const msg of messages) {
        const content = (msg.content || '').toLowerCase();
        const speaker = msg.characterName || (msg.role === 'user' ? '用户' : 'AI');

        if (content.includes(query)) {
          // 截取匹配位置前后各 50 字作为上下文
          const idx = content.indexOf(query);
          const start = Math.max(0, idx - 50);
          const end = Math.min(content.length, idx + query.length + 50);
          const snippet = (msg.content || '').substring(start, end).trim();

          results.push({
            speaker,
            role: msg.role,
            snippet: start > 0 ? '…' + snippet : snippet,
            snippet_end: end < content.length ? snippet + '…' : snippet
          });

          if (results.length >= limit) break;
        }
      }

      return JSON.stringify({
        success: true,
        count: results.length,
        results
      });
    }

    case 'get_all_characters': {
      const allChars = state.characterData || [];
      if (allChars.length === 0) {
        return JSON.stringify({ success: true, characters: [], message: '当前没有已创建的角色' });
      }

      const charList = allChars.map(c => ({
        name: c.name,
        summary: c.summary || c.personality || '无描述'
      }));

      return JSON.stringify({
        success: true,
        count: charList.length,
        characters: charList
      });
    }

    // ========== 记忆工具（与 memoryToolExecutor 逻辑一致） ==========

    case 'query_story_archive': {
      const tab = tabId ? state.tabData.list[tabId] : null;
      const archive = tab?.storyArchive;
      if (!archive) return JSON.stringify({ success: false, error: '当前没有剧情档案' });

      const section = String(args.section || 'overview');
      let data = archive[section];

      if (args.keyword && Array.isArray(data)) {
        const kw = String(args.keyword).toLowerCase();
        data = data.filter(item => JSON.stringify(item).toLowerCase().includes(kw));
      }

      return JSON.stringify({ success: true, section, data: data || [] });
    }

    case 'get_character_info': {
      const charName = String(args.name || '').trim();
      if (!charName) return JSON.stringify({ success: false, error: '缺少角色名称' });

      const char = (state.characterData || []).find(c => c.name === charName);
      if (!char) return JSON.stringify({ success: false, error: `未找到角色"${charName}"` });

      return JSON.stringify({
        success: true,
        name: char.name,
        personality: char.personality || '',
        background: char.background || '',
        appearance: char.appearance || '',
        speechStyle: char.speakingStyle || '',
        catchphrases: char.catchphrases || []
      });
    }

    case 'get_conversation_summary': {
      const tab = tabId ? state.tabData.list[tabId] : null;
      const summary = tab?.summary;
      if (!summary) return JSON.stringify({ success: false, error: '当前没有记忆摘要' });

      return JSON.stringify({ success: true, summary });
    }

    default:
      return JSON.stringify({ success: false, error: `未知工具: ${name}` });
  }
}

/**
 * 通用记忆 toolExecutor：处理档案查询、角色信息、对话摘要。
 * 用于未来普通对话/角色单聊的 Agent 模式。
 *
 * @param {string} name - 工具名称
 * @param {Object} args - 工具参数
 * @param {string} tabId - 目标 tab ID
 * @returns {string} 工具执行结果
 */
export function memoryToolExecutor(name, args, tabId) {
  const tab = state.tabData.list[tabId];

  switch (name) {
    case 'query_story_archive': {
      const archive = tab?.storyArchive;
      if (!archive) return '当前没有剧情档案';

      const section = String(args.section || 'overview');
      let data = archive[section];

      if (args.keyword && Array.isArray(data)) {
        const kw = String(args.keyword).toLowerCase();
        data = data.filter(item => JSON.stringify(item).toLowerCase().includes(kw));
      }

      return JSON.stringify(data || []);
    }

    case 'get_character_info': {
      const charName = String(args.name || '').trim();
      if (!charName) return '缺少角色名称';

      const char = state.characterData.find(c => c.name === charName);
      if (!char) return `未找到角色"${charName}"`;

      return JSON.stringify({
        name: char.name,
        personality: char.personality || '',
        background: char.background || '',
        appearance: char.appearance || '',
        speechStyle: char.speakingStyle || '',
        catchphrases: char.catchphrases || []
      });
    }

    case 'get_conversation_summary': {
      return tab?.summary || '当前没有记忆摘要';
    }

    default:
      return `未知工具: ${name}`;
  }
}
