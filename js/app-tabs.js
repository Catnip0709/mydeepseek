// app-tabs.js - Tab 标签页管理
(function() {
  'use strict';
  const App = window.App;

  // ==================== DOM 元素 ====================
  const tabsEl = document.getElementById('tabs');
  const addTab = document.getElementById('addTab');
  const addTabDropdown = document.getElementById('addTabDropdown');
  const addTabSingle = document.getElementById('addTabSingle');
  const addTabGroup = document.getElementById('addTabGroup');
  const renameTabPanel = document.getElementById('renameTabPanel');
  const renameTabInput = document.getElementById('renameTabInput');
  const renameTabCancelBtn = document.getElementById('renameTabCancelBtn');
  const renameTabSaveBtn = document.getElementById('renameTabSaveBtn');
  const chat = document.getElementById('chat');
  const input = document.getElementById('input');

  // ==================== 内部变量 ====================
  let renamingTabId = null;

  // ==================== SVG 图标 ====================
  const renameIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"></path></svg>`;
  const downloadIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`;

  // ==================== 渲染 Tab 列表 ====================
  App.renderTabs = function() {
    tabsEl.innerHTML = "";
    const tabIds = Object.keys(App.tabData.list);
    if (tabIds.length === 0) {
      App.tabData.list = { tab1: { messages: [], title: "" } };
      App.tabData.active = "tab1";
      App.saveTabs();
    }

    Object.keys(App.tabData.list).forEach(id => {
      const tab = App.tabData.list[id];
      const isGroup = tab.type === 'group';
      const tabDiv = document.createElement("div");
      tabDiv.className = `tab ${id === App.tabData.active ? "active" : ""} ${isGroup ? "group-tab" : ""}`;
      tabDiv.innerHTML = `
        <span class="tab-title" title="${App.escapeHtml(App.getTabDisplayName(id))}">${App.escapeHtml(App.getTabDisplayName(id))}</span>
        <div class="tab-actions">
          <span class="tab-btn tab-rename" data-id="${id}" title="修改会话名称">${renameIconSvg}</span>
          <span class="tab-btn tab-export" data-id="${id}" title="导出对话">${downloadIconSvg}</span>
          <span class="tab-btn tab-del" data-id="${id}" title="删除对话">×</span>
        </div>
      `;
      tabDiv.addEventListener("click", (e) => {
        if (e.target.closest('.tab-del') || e.target.closest('.tab-export') || e.target.closest('.tab-rename')) return;
        // 缓存当前 tab 的 DOM
        App.setCachedTabHtml(App.tabData.active, chat.innerHTML);
        App.tabData.active = id;
        App.saveTabs();
        // 尝试使用缓存
        const cached = App.getCachedTabHtml(id);
        if (cached) {
          chat.innerHTML = cached;
          App.rebindChatButtons();
        } else {
          App.renderChat();
        }
        // 根据目标 tab 的消息状态正确控制空对话提示
        const targetMsgs = App.tabData.list[id].messages || [];
        if (targetMsgs.length === 0) {
          App.showEmptyChatHint();
        } else {
          App.hideEmptyChatHint();
        }
        App.renderTabs();
        App.updateInputCounter();
        if(window.innerWidth < 768) App.closeSidebar();
      });
      tabsEl.appendChild(tabDiv);
    });

    document.querySelectorAll(".tab-rename").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const tabId = btn.dataset.id;
        openRenameTabPanel(tabId);
      });
    });

    document.querySelectorAll(".tab-export").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const exportId = btn.dataset.id;
        App.openDownloadPanel(exportId);
      });
    });

    document.querySelectorAll(".tab-del").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const delId = btn.dataset.id;
        if (confirm(`确定删除「${App.getTabDisplayName(delId)}」吗？删除后记录将永久消失！`)) {
          delete App.tabData.list[delId];

          const remainingTabIds = Object.keys(App.tabData.list);
          if (remainingTabIds.length === 0) {
            const newId = App.createNewTab();
            App.tabData.active = newId;
            return;
          }

          if (delId === App.tabData.active) {
            App.tabData.active = remainingTabIds[0];
          }
          App.saveTabs();
          App.renderChat();
          App.renderTabs();
          App.updateInputCounter();
        }
      });
    });
  };

  // ==================== 重命名 Tab ====================
  function openRenameTabPanel(tabId) {
    renamingTabId = tabId;
    renameTabInput.value = App.tabData.list[tabId]?.title || '';
    renameTabPanel.classList.remove('hidden');
    setTimeout(() => {
      renameTabInput.focus();
      renameTabInput.select();
    }, 30);
  }

  function closeRenameTabPanel() {
    renamingTabId = null;
    renameTabPanel.classList.add('hidden');
    renameTabInput.value = '';
  }

  function saveRenamedTab() {
    if (!renamingTabId || !App.tabData.list[renamingTabId]) return;
    const finalName = renameTabInput.value.trim();
    App.tabData.list[renamingTabId].title = finalName;
    App.saveTabs();
    App.renderTabs();
    closeRenameTabPanel();
    App.showToast(finalName ? '会话名称已更新' : '已恢复默认会话名称');
  }

  // ==================== 新建 Tab 下拉菜单 ====================
  addTab.onclick = (e) => {
    e.stopPropagation();
    addTabDropdown.classList.toggle("hidden");
  };

  addTabSingle.onclick = () => {
    addTabDropdown.classList.add("hidden");
    App.createNewTab();
    App.closeSidebar();
    input.focus();
  };

  addTabGroup.onclick = () => {
    addTabDropdown.classList.add("hidden");
    App.openCreateGroupPanel();
  };

  // 点击页面其他区域关闭下拉菜单
  document.addEventListener("click", () => {
    addTabDropdown.classList.add("hidden");
  });

  // ==================== 重命名面板事件绑定 ====================
  renameTabCancelBtn.addEventListener('click', closeRenameTabPanel);
  renameTabSaveBtn.addEventListener('click', saveRenamedTab);
  renameTabPanel.addEventListener('click', (e) => {
    if (e.target === renameTabPanel) closeRenameTabPanel();
  });
  renameTabInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveRenamedTab();
  });

})();
