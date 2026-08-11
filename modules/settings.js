/**
 * settings.js — 设置面板模块
 *
 * 管理设置面板、API Key 管理、下载导出、字体设置事件绑定等。
 */

import { state, MEMORY_STRATEGY_WINDOW, MEMORY_STRATEGY_FULL, canModifyPersistedData } from './state.js?v=5';
import { copyText, checkIconSvg, formatBytes } from './utils.js?v=5';
import {
  getTabDisplayName, updateStorageUsage, isTokenLimitReached,
  getRecoverableStorageInfo, discardRecoverySession, clearCorruptedBackups
} from './storage.js?v=5';
import {
  showToast, openSettingsPanel, closeSettingsPanel, applyFontSize,
  updateFontSizeButtons, closeRenameTabPanel, saveRenamedTab,
  closeConfirmModal, closeDownloadPanel, hideReplyBar,
  openSidebar, closeSidebar, closeCleanupChoicePanel, showConfirmModal
} from './panels.js?v=5';
import { renderChat } from './chat.js?v=5';
import { renderTabs } from './tabs.js?v=5';
import { call as coreCall } from './core.js?v=5';

export function applyDeepThinkState(nextChecked, source = 'manual') {
  const deepThinkToggle = document.getElementById('deepThinkToggle');
  if (!deepThinkToggle) return;
  if (!canModifyPersistedData()) {
    // 只读时把 UI 复位到内存中的当前值，避免浏览器已经把 checkbox 自动切换但状态未同步。
    deepThinkToggle.checked = !!state.deepThink;
    try { showToast('当前页面只读，请切换到正在操作的页面'); } catch (_) {}
    return;
  }

  // 互斥：HTML 模式开启时，拒绝"开启深度思考"的动作（关闭动作放行）
  // 使用同步 require 避免循环依赖时死锁：通过全局变量透传 htmlmode 的状态
  if (nextChecked && source !== 'html-mode-auto-off') {
    const htmlModeOn = !!window.__mydeepseek_htmlModeOn;
    if (htmlModeOn) {
      // 回滚 UI
      deepThinkToggle.checked = false;
      state.deepThink = false;
      try { showToast('预览网页模式下无法开启深度思考'); } catch (_) {}
      return;
    }
  }

  deepThinkToggle.checked = !!nextChecked;
  state.deepThink = !!nextChecked;
  localStorage.setItem('dsDeepThink', String(state.deepThink));
}

export function forceToggleDeepThinkFromUI(event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  const deepThinkToggle = document.getElementById('deepThinkToggle');
  if (!deepThinkToggle) return false;

  // 互斥拦截：HTML 模式开启时，忽略点击
  if (window.__mydeepseek_htmlModeOn && !deepThinkToggle.checked) {
    try { showToast('预览网页模式下无法开启深度思考'); } catch (_) {}
    return false;
  }

  applyDeepThinkState(!deepThinkToggle.checked, 'inline-ui');
  return false;
}

export function syncDeepThinkFromInput(checked) {
  applyDeepThinkState(!!checked, 'inline-input-change');
}

// ========== API Key 验证（内部函数） ==========

function validateApiKey(key) {
  if (!key || !key.startsWith("sk-")) {
    return alert("请输入有效的以sk-开头的API Key！");
  }
  if (key.length < 20) {
    alert("API Key长度过短，可能是无效的Key，请检查！");
    return false;
  }
  return true;
}

// ========== 导出功能 ==========

const EXPORT_TEXT_MIME = 'text/plain;charset=utf-8';
const UTF8_BOM = '\uFEFF';

function isQuarkLikeMobileBrowser() {
  const ua = navigator.userAgent || '';
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua) && /Quark|UCBrowser|UCWEB/i.test(ua);
}

function triggerBlobDownload(blob, filename) {
  if (navigator.msSaveOrOpenBlob) {
    navigator.msSaveOrOpenBlob(blob, filename);
    return;
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  // 部分移动浏览器会异步交给下载器处理，立即 revoke 可能导致下载器拿不到内容。
  setTimeout(() => URL.revokeObjectURL(url), 60 * 1000);
}

function toSafeInlineJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003C')
    .replace(/>/g, '\\u003E')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function openCompatibleExportPage(txtContent, filename) {
  const page = window.open('', '_blank');
  if (!page) {
    copyText(txtContent);
    alert('当前浏览器限制直接下载，已尝试复制导出内容。请粘贴到备忘录或文本编辑器中保存。');
    return;
  }

  const inlineText = toSafeInlineJson(txtContent);
  const inlineFilename = toSafeInlineJson(filename);

  page.document.open();
  page.document.write(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>兼容导出 - ${filename}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 18px;
      color: #e5e7eb;
      background: #111827;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .wrap { max-width: 860px; margin: 0 auto; }
    h1 { margin: 0 0 10px; font-size: 20px; }
    p { margin: 0 0 14px; color: #9ca3af; line-height: 1.6; font-size: 14px; }
    .actions { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 14px; }
    button {
      border: 0;
      border-radius: 10px;
      padding: 10px 14px;
      color: #fff;
      background: #2563eb;
      font-size: 14px;
    }
    button.secondary { background: #374151; }
    textarea {
      width: 100%;
      min-height: 70vh;
      padding: 14px;
      border: 1px solid #374151;
      border-radius: 12px;
      color: #f9fafb;
      background: #030712;
      font: 14px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      white-space: pre-wrap;
    }
  </style>
</head>
<body>
  <main class="wrap">
    <h1>兼容导出</h1>
    <p>当前浏览器可能不支持直接保存网页生成的文件。内容已在下方生成，可复制保存；也可以尝试下载 TXT 或通过系统分享保存。</p>
    <div class="actions">
      <button id="copyBtn">复制全文</button>
      <button id="downloadBtn" class="secondary">尝试下载 TXT</button>
      <button id="shareBtn" class="secondary">系统分享/保存</button>
      <button id="selectBtn" class="secondary">全选文本</button>
    </div>
    <textarea id="exportText" readonly></textarea>
  </main>
  <script>
    const exportText = ${inlineText};
    const filename = ${inlineFilename};
    const textArea = document.getElementById('exportText');
    textArea.value = exportText;

    function fallbackCopy() {
      textArea.focus();
      textArea.select();
      document.execCommand('copy');
    }

    document.getElementById('copyBtn').addEventListener('click', async () => {
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(exportText);
        } else {
          fallbackCopy();
        }
        alert('导出内容已复制');
      } catch (err) {
        fallbackCopy();
        alert('已选中导出内容，请手动复制');
      }
    });

    document.getElementById('downloadBtn').addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = 'data:text/plain;charset=utf-8,' + encodeURIComponent('\\uFEFF' + exportText);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    });

    document.getElementById('shareBtn').addEventListener('click', async () => {
      try {
        if (!navigator.share) {
          alert('当前浏览器不支持系统分享，请使用复制全文。');
          return;
        }
        if (typeof File === 'function' && navigator.canShare) {
          const file = new File(['\\uFEFF' + exportText], filename, { type: 'text/plain' });
          if (navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file], title: filename });
            return;
          }
        }
        await navigator.share({ title: filename, text: exportText });
      } catch (err) {
        if (!err || err.name !== 'AbortError') {
          alert('分享失败，请使用复制全文。');
        }
      }
    });

    document.getElementById('selectBtn').addEventListener('click', () => {
      textArea.focus();
      textArea.select();
    });
  <\/script>
</body>
</html>`);
  page.document.close();
}

export function exportChatToTxt(tabId, mode = 'all', includeReasoning = true) {
  const currentTab = state.tabData.list[tabId];
  const msgs = currentTab?.messages || [];
  if (msgs.length === 0) {
    alert("当前对话为空，无法导出。");
    return;
  }

  let txtContent = `${getTabDisplayName(tabId)} - ${new Date().toLocaleString()}\n`;
  txtContent += `==================================================\n\n`;

  msgs.forEach(m => {
    if (mode === 'ai_only' && m.role === 'user') {
      return;
    }

    const isSingleChar = currentTab && currentTab.type === 'single-character';
    const charName = isSingleChar && currentTab.characterId ? (state.characterData.find(c => c.id === currentTab.characterId) || {}).name || 'DeepSeek' : 'DeepSeek';
    const roleName = m.role === 'user' ? '我' : (m.role === 'character' ? (m.characterName || '角色') : charName);
    txtContent += `【${roleName}】:\n`;

    if (includeReasoning && m.reasoningContent) {
      txtContent += `[思考过程]:\n${m.reasoningContent}\n\n`;
      txtContent += `[正文]:\n`;
    }

    txtContent += `${m.content}\n\n`;
    txtContent += `--------------------------------------------------\n\n`;
  });

  // 添加 UTF-8 BOM，避免在中文 Windows 记事本等以 GBK/ANSI 默认编码打开时出现"锟斤拷"乱码
  const blob = new Blob([UTF8_BOM + txtContent], { type: EXPORT_TEXT_MIME });
  const modeSuffix = mode === 'ai_only' ? '_AI回复' : '';
  const reasoningSuffix = includeReasoning ? '' : '_不含思考';
  const safeName = getTabDisplayName(tabId).replace(/[\\/:*?"<>|]/g, '_');
  const filename = `${safeName}${modeSuffix}${reasoningSuffix}.txt`;

  if (isQuarkLikeMobileBrowser()) {
    openCompatibleExportPage(txtContent, filename);
    showToast('已打开兼容导出页');
    return;
  }

  triggerBlobDownload(blob, filename);
  showToast('导出已开始');
}

// ========== 设置面板事件绑定 ==========

export function refreshRecoverableStorageInfo() {
  const infoEl = document.getElementById('recoverableStorageInfo');
  const discardBtn = document.getElementById('discardRecoveryStorageBtn');
  const clearBackupsBtn = document.getElementById('clearCorruptedBackupsBtn');
  const info = getRecoverableStorageInfo();
  const recoveryText = info.recoveryPresent
    ? `恢复数据 ${formatBytes(info.recoveryBytes)}`
    : '无恢复数据';
  const backupText = info.backupCount > 0
    ? `故障备份 ${info.backupCount} 份，共 ${formatBytes(info.backupBytes)}`
    : '无故障备份';
  if (infoEl) {
    infoEl.textContent = `${recoveryText}；${backupText}${info.cleanupBlocked ? '。当前状态下禁止清理' : ''}`;
  }
  if (discardBtn) discardBtn.disabled = !info.recoveryPresent || info.cleanupBlocked;
  if (clearBackupsBtn) clearBackupsBtn.disabled = info.backupCount === 0 || info.cleanupBlocked;
}

export function bindSettingsEvents() {
  const settingsBtn = document.getElementById('settingsBtn');
  const settingsCloseBtn = document.getElementById('settingsCloseBtn');
  const settingsPanel = document.getElementById('settingsPanel');
  const settingsCopyKeyBtn = document.getElementById('settingsCopyKeyBtn');
  const settingsSaveKeyBtn = document.getElementById('settingsSaveKeyBtn');
  const settingsApiKeyInput = document.getElementById('settingsApiKeyInput');
  const settingsDayModeToggle = document.getElementById('settingsDayModeToggle');
  const settingsTokenEstimateToggle = document.getElementById('settingsTokenEstimateToggle');
  const settingsHumanizeNormalChatToggle = document.getElementById('settingsHumanizeNormalChatToggle');
  const discardRecoveryStorageBtn = document.getElementById('discardRecoveryStorageBtn');
  const clearCorruptedBackupsBtn = document.getElementById('clearCorruptedBackupsBtn');
  const menuBtn = document.getElementById('menuBtn');
  const sidebarOverlay = document.getElementById('sidebarOverlay');
  const renameTabCancelBtn = document.getElementById('renameTabCancelBtn');
  const renameTabSaveBtn = document.getElementById('renameTabSaveBtn');
  const renameTabPanel = document.getElementById('renameTabPanel');
  const renameTabInput = document.getElementById('renameTabInput');
  const confirmCancelBtn = document.getElementById('confirmCancelBtn');
  const confirmSecondaryBtn = document.getElementById('confirmSecondaryBtn');
  const confirmOkBtn = document.getElementById('confirmOkBtn');
  const confirmPanel = document.getElementById('confirmPanel');
  const downloadCancelBtn = document.getElementById('downloadCancelBtn');
  const downloadPanel = document.getElementById('downloadPanel');
  const downloadAllBtn = document.getElementById('downloadAllBtn');
  const downloadAiOnlyBtn = document.getElementById('downloadAiOnlyBtn');
  const includeReasoningToggle = document.getElementById('includeReasoningToggle');
  const storageWarningIcon = document.getElementById('storageWarningIcon');
  const openDonateBtn = document.getElementById('openDonateBtn');
  const donatePanel = document.getElementById('donatePanel');
  const closeDonateBtn = document.getElementById('closeDonateBtn');
  const openInfoBtn = document.getElementById('openInfoBtn');
  const infoPanel = document.getElementById('infoPanel');
  const closeInfoBtn = document.getElementById('closeInfoBtn');
  const keyPanel = document.getElementById('keyPanel');
  const apiKeyInput = document.getElementById('apiKeyInput');
  const saveKey = document.getElementById('saveKey');
  const replyBarCancel = document.getElementById('replyBarCancel');
  const deepThinkToggle = document.getElementById('deepThinkToggle');
  const deepThinkChip = deepThinkToggle ? deepThinkToggle.closest('.deepthink-chip') : null;

  function triggerLegacySummaryMigrationAfterKeySaved() {
    coreCall('runLegacySummaryMigration');
  }

  // 侧边栏
  if (menuBtn) menuBtn.addEventListener("click", openSidebar);
  if (sidebarOverlay) sidebarOverlay.addEventListener("click", closeSidebar);

  // 设置面板
  if (settingsBtn) settingsBtn.addEventListener("click", () => {
    refreshRecoverableStorageInfo();
    openSettingsPanel();
  });
  if (settingsCloseBtn) settingsCloseBtn.addEventListener("click", closeSettingsPanel);
  if (settingsPanel) settingsPanel.addEventListener("click", (e) => {
    if (e.target === settingsPanel) closeSettingsPanel();
  });

  if (discardRecoveryStorageBtn) {
    discardRecoveryStorageBtn.addEventListener('click', async () => {
      const info = getRecoverableStorageInfo();
      const confirmed = await showConfirmModal({
        title: '确认删除恢复数据',
        desc: '恢复区中的聊天记录将永久删除，且无法撤销。当前正常会话不会受到影响。',
        okText: '确认删除',
        cancelText: '保留数据'
      });
      if (!confirmed) return;
      showToast(
        discardRecoverySession(info.recoveryFingerprint)
          ? '恢复数据已删除'
          : '恢复数据已变化或当前页面已失去操作权，请重新确认'
      );
      refreshRecoverableStorageInfo();
    });
  }

  if (clearCorruptedBackupsBtn) {
    clearCorruptedBackupsBtn.addEventListener('click', async () => {
      const info = getRecoverableStorageInfo();
      const confirmed = await showConfirmModal({
        title: '确认清理故障备份',
        desc: `将删除 ${info.backupCount} 份异常数据备份，共 ${formatBytes(info.backupBytes)}。当前正常会话不会受到影响。`,
        okText: '确认清理',
        cancelText: '取消'
      });
      if (!confirmed) return;
      const result = clearCorruptedBackups();
      showToast(result.blocked ? '当前状态下不能清理故障备份' : `已清理 ${result.cleared} 份故障备份`);
      refreshRecoverableStorageInfo();
    });
  }

  // 设置 - 复制 API Key
  if (settingsCopyKeyBtn) {
    settingsCopyKeyBtn.addEventListener("click", () => {
      if (!settingsApiKeyInput) return;
      const key = settingsApiKeyInput.value.trim();
      copyText(key)?.then(() => {
        if (key) {
          showToast("API Key 已复制");
          const originalHtml = settingsCopyKeyBtn.innerHTML;
          settingsCopyKeyBtn.innerHTML = checkIconSvg;
          setTimeout(() => { settingsCopyKeyBtn.innerHTML = originalHtml; }, 1500);
        }
      });
    });
  }

  // 设置 - 保存 API Key
  if (settingsSaveKeyBtn) {
    settingsSaveKeyBtn.addEventListener("click", () => {
        if (!canModifyPersistedData()) {
          showToast('当前页面只读，请切换到正在操作的页面');
          return;
        }
      if (!settingsApiKeyInput) return;
      const newKey = settingsApiKeyInput.value.trim();
      if (!validateApiKey(newKey)) return;
      state.apiKey = newKey;
      localStorage.setItem("dsApiKey", state.apiKey);
      updateStorageUsage();
      if (apiKeyInput) {
        apiKeyInput.value = state.apiKey;
      }
      triggerLegacySummaryMigrationAfterKeySaved();
      showToast("API Key 已保存");
      closeSettingsPanel();
    });
  }

  // 设置 - 日间模式
  if (settingsDayModeToggle) {
    settingsDayModeToggle.addEventListener("change", (e) => {
        if (!canModifyPersistedData()) {
          e.target.checked = !e.target.checked;
          showToast('当前页面只读，请切换到正在操作的页面');
          return;
        }
      const isDayMode = e.target.checked;
      if (isDayMode) {
        document.body.classList.add("day-mode");
      } else {
        document.body.classList.remove("day-mode");
      }
      localStorage.setItem("dsDayMode", isDayMode.toString());
    });
  }

  // 设置 - Token 预估显示
  if (settingsTokenEstimateToggle) {
    settingsTokenEstimateToggle.addEventListener("change", (e) => {
        if (!canModifyPersistedData()) {
          e.target.checked = !e.target.checked;
          showToast('当前页面只读，请切换到正在操作的页面');
          return;
        }
      const show = e.target.checked;
      if (show) {
        document.body.classList.remove("hide-token-estimate");
      } else {
        document.body.classList.add("hide-token-estimate");
      }
      localStorage.setItem("dsShowTokenEstimate", show.toString());
    });
  }

  // 设置 - 去 AI 味（普通对话）
  if (settingsHumanizeNormalChatToggle) {
    settingsHumanizeNormalChatToggle.checked = !!state.humanizeNormalChat;
    settingsHumanizeNormalChatToggle.addEventListener("change", async (e) => {
      const nextChecked = !!e.target.checked;
        if (!canModifyPersistedData()) {
          e.target.checked = !nextChecked;
          showToast('当前页面只读，请切换到正在操作的页面');
          return;
        }
      if (!nextChecked) {
        state.humanizeNormalChat = false;
        localStorage.setItem('dsHumanizeNormalChat', 'false');
        return;
      }

      e.target.checked = false;
      const confirmed = await showConfirmModal({
        title: '开启去 AI 味（普通对话）？',
        desc: '开启后，普通对话会额外进行自检和精修，因此会消耗更多 token，并可能增加等待时间。该功能不影响群聊和角色对话。',
        okText: '确认开启',
        cancelText: '取消'
      });
      state.humanizeNormalChat = !!confirmed;
      localStorage.setItem('dsHumanizeNormalChat', String(state.humanizeNormalChat));
      e.target.checked = state.humanizeNormalChat;
      if (state.humanizeNormalChat) {
        showToast('已开启去 AI 味（普通对话）');
      }
    });
  }

  // 设置 - 记忆策略
  const memoryStrategyWindow = document.getElementById('memoryStrategyWindow');
  const memoryStrategyFull = document.getElementById('memoryStrategyFull');
  
  // 初始化选中状态
  if (state.memoryStrategy === MEMORY_STRATEGY_FULL) {
    if (memoryStrategyFull) memoryStrategyFull.checked = true;
  } else {
    if (memoryStrategyWindow) memoryStrategyWindow.checked = true;
  }
  
  // 绑定事件
  if (memoryStrategyWindow) {
    memoryStrategyWindow.addEventListener("change", (e) => {
        if (!canModifyPersistedData()) {
          e.target.checked = false;
          showToast('当前页面只读，请切换到正在操作的页面');
          return;
        }
      if (e.target.checked) {
        state.memoryStrategy = MEMORY_STRATEGY_WINDOW;
        localStorage.setItem("dsMemoryStrategy", MEMORY_STRATEGY_WINDOW);
      }
    });
  }
  if (memoryStrategyFull) {
    memoryStrategyFull.addEventListener("change", (e) => {
        if (!canModifyPersistedData()) {
          e.target.checked = false;
          showToast('当前页面只读，请切换到正在操作的页面');
          return;
        }
      if (e.target.checked) {
        state.memoryStrategy = MEMORY_STRATEGY_FULL;
        localStorage.setItem("dsMemoryStrategy", MEMORY_STRATEGY_FULL);
      }
    });
  }

  // 字号选择
  document.querySelectorAll('.font-size-option').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!canModifyPersistedData()) {
        showToast('当前页面只读，请切换到正在操作的页面');
        return;
      }
      const size = btn.getAttribute('data-size');
      applyFontSize(size);
      updateFontSizeButtons(size);
      localStorage.setItem("dsFontSize", size);
    });
  });

  // 重命名面板
  if (renameTabCancelBtn) renameTabCancelBtn.addEventListener('click', closeRenameTabPanel);
  if (renameTabSaveBtn) renameTabSaveBtn.addEventListener('click', () => {
    saveRenamedTab();
    renderTabs();
  });
  if (renameTabPanel) renameTabPanel.addEventListener('click', (e) => {
    if (e.target === renameTabPanel) closeRenameTabPanel();
  });
  if (renameTabInput) renameTabInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      saveRenamedTab();
      renderTabs();
    }
  });

  // 确认弹窗
  if (confirmCancelBtn) confirmCancelBtn.addEventListener('click', () => closeConfirmModal(false));
  if (confirmSecondaryBtn) confirmSecondaryBtn.addEventListener('click', () => closeConfirmModal('secondary'));
  if (confirmOkBtn) confirmOkBtn.addEventListener('click', () => closeConfirmModal(true));
  if (confirmPanel) confirmPanel.addEventListener('click', (e) => {
    if (e.target === confirmPanel) closeConfirmModal(false);
  });

  // 释放空间类型选择弹窗
  const cleanupChoicePanel = document.getElementById('cleanupChoicePanel');
  const cleanupChoiceCancelBtn = document.getElementById('cleanupChoiceCancelBtn');
  if (cleanupChoiceCancelBtn) cleanupChoiceCancelBtn.addEventListener('click', closeCleanupChoicePanel);
  if (cleanupChoicePanel) cleanupChoicePanel.addEventListener('click', (e) => {
    if (e.target === cleanupChoicePanel) closeCleanupChoicePanel();
  });

  // 导出面板
  if (downloadCancelBtn) downloadCancelBtn.addEventListener('click', closeDownloadPanel);
  if (downloadPanel) downloadPanel.addEventListener('click', (e) => {
    if (e.target === downloadPanel) closeDownloadPanel();
  });
  if (downloadAllBtn) downloadAllBtn.addEventListener('click', () => {
    if (state.pendingDownloadTabId) {
      exportChatToTxt(state.pendingDownloadTabId, 'all', includeReasoningToggle?.checked);
      closeDownloadPanel();
    }
  });
  if (downloadAiOnlyBtn) downloadAiOnlyBtn.addEventListener('click', () => {
    if (state.pendingDownloadTabId) {
      exportChatToTxt(state.pendingDownloadTabId, 'ai_only', includeReasoningToggle?.checked);
      closeDownloadPanel();
    }
  });

  // 存储警告
  if (storageWarningIcon) {
    storageWarningIcon.addEventListener('click', function() {
      alert(
        '当前聊天内容接近本地存储上限（5MB）。可以尝试以下方式释放空间：\n\n' +
        '1. 在侧边栏点击会话右侧的「🧹」按钮，选择「释放历史版本」清除重新生成留下的旧回复，或「释放思考内容」清除当前回复的思考过程（均不影响当前正文，最轻量）；\n' +
        '2. 导出重要会话后，删除不再需要的过期会话；\n' +
        '3. 如果上传过较大的文本附件，可考虑删除带附件的旧消息。\n\n' +
        '建议优先尝试第 1 项，通常能释放较多空间。'
      );
    });
  }

  // 捐赠面板
  if (openDonateBtn) openDonateBtn.addEventListener("click", () => donatePanel.classList.remove("hidden"));
  if (closeDonateBtn) closeDonateBtn.addEventListener("click", () => donatePanel.classList.add("hidden"));
  if (donatePanel) donatePanel.addEventListener("click", (e) => {
    if (e.target === donatePanel) donatePanel.classList.add("hidden");
  });

  // 信息面板
  if (openInfoBtn) openInfoBtn.addEventListener("click", () => infoPanel.classList.remove("hidden"));
  if (closeInfoBtn) closeInfoBtn.addEventListener("click", () => infoPanel.classList.add("hidden"));
  if (infoPanel) infoPanel.addEventListener("click", (e) => {
    if (e.target === infoPanel) infoPanel.classList.add("hidden");
  });

  // API Key 面板
  if (saveKey) {
    saveKey.onclick = () => {
      if (!canModifyPersistedData()) {
        showToast('当前页面只读，请切换到正在操作的页面');
        return;
      }
      const newKey = apiKeyInput.value.trim();
      if (!validateApiKey(newKey)) return;
      state.apiKey = newKey;
      localStorage.setItem("dsApiKey", state.apiKey);
      updateStorageUsage();
      keyPanel.classList.add("hidden");
      triggerLegacySummaryMigrationAfterKeySaved();
      showToast("API Key 已保存");
    };
  }

  // 回复引用条取消
  if (replyBarCancel) replyBarCancel.addEventListener('click', hideReplyBar);

  // 模型选择
  const modelChoiceRadios = document.querySelectorAll('input[name="modelChoice"]');
  if (modelChoiceRadios.length) {
    // 初始化选中状态
    modelChoiceRadios.forEach(radio => {
      radio.checked = radio.value === state.selectedModel;
    });
    // 监听切换
    modelChoiceRadios.forEach(radio => {
      radio.addEventListener('change', (e) => {
        if (!canModifyPersistedData()) {
          modelChoiceRadios.forEach(choice => {
            choice.checked = choice.value === state.selectedModel;
          });
          showToast('当前页面只读，请切换到正在操作的页面');
          return;
        }
        state.selectedModel = e.target.value;
        localStorage.setItem('dsSelectedModel', state.selectedModel);
        // 切换模型后，若当前对话已超过新模型的上下文上限，立即刷新渲染以显示警告
        if (isTokenLimitReached()) {
          renderChat();
        }
      });
    });
  }

  // 深度思考开关
  if (deepThinkToggle) {
    let suppressNextNativeChange = false;

    applyDeepThinkState(state.deepThink, 'init');

    if (deepThinkChip) {
      const toggleFromChip = (source = 'chip-click') => {
        suppressNextNativeChange = true;
        applyDeepThinkState(!deepThinkToggle.checked, source);
      };

      deepThinkChip.addEventListener('click', (e) => {
        if (e.target === deepThinkToggle) return;
        e.preventDefault();
        e.stopPropagation();
        toggleFromChip('chip-click');
      });

      document.addEventListener('pointerdown', (e) => {
        const chip = e.target.closest('.deepthink-chip');
        if (!chip || chip !== deepThinkChip) return;
        if (e.target === deepThinkToggle) return;
        e.preventDefault();
        toggleFromChip('delegated-pointerdown');
      }, true);
    }
    deepThinkToggle.addEventListener("change", (e) => {
      if (suppressNextNativeChange) {
        suppressNextNativeChange = false;
        return;
      }
      applyDeepThinkState(e.target.checked, 'native-change');
    });
  }
}
