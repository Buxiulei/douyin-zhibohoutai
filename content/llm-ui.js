/**
 * AI 分析面板 UI — 悬浮窗中的 LLM 交互界面
 *
 * 职责：
 * - 设置面板（API Key / 模型名称）
 * - 一键生成综合报告（选择基金/投顾 → 并行生成 4 板块 → 汇总优化建议）
 * - 四板块可展开查看详情 / 单独生成 + 汇总板块
 * - 汇总结果后下载 HTML / TXT 报告
 */

(function () {
  'use strict';

  const LLM = window.__douyinLLM;

  // ─── 简易 Markdown → HTML 转换 ───
  function markdownToHtml(md) {
    if (!md) return '';

    // ── 第一步：预处理 Markdown 表格块 ──
    let html = md.replace(
      /(^\|.+\|$\n?(?:\s*\n)?)+/gm,
      (tableBlock) => {
        const tableLines = tableBlock.split('\n').filter(l => l.trim().startsWith('|'));
        let headerRows = [];
        let bodyRows = [];
        let sepIdx = -1;

        for (let i = 0; i < tableLines.length; i++) {
          const cells = tableLines[i].split('|').filter(c => c.trim());
          if (cells.every(c => /^[\s\-:]+$/.test(c))) { sepIdx = i; break; }
        }

        if (sepIdx > 0) {
          headerRows = tableLines.slice(0, sepIdx);
          bodyRows = tableLines.slice(sepIdx + 1);
        } else {
          bodyRows = tableLines.filter(l => {
            const cells = l.split('|').filter(c => c.trim());
            return !cells.every(c => /^[\s\-:]+$/.test(c));
          });
        }

        const toRow = (line, tag) => {
          const cells = line.split('|').filter(c => c.trim());
          return `<tr>${cells.map(c => `<${tag}>${c.trim()}</${tag}>`).join('')}</tr>`;
        };

        let tableHtml = '<table>';
        if (headerRows.length > 0) {
          tableHtml += '<thead>' + headerRows.map(r => toRow(r, 'th')).join('') + '</thead>';
        }
        tableHtml += '<tbody>' + bodyRows.map(r => toRow(r, 'td')).join('') + '</tbody>';
        tableHtml += '</table>';
        return tableHtml;
      }
    );

    // ── 第二步：逐行处理 ──
    const lines = html.split('\n');
    const result = [];
    let listStack = []; // 栈跟踪嵌套列表：[{type:'ul'|'ol', indent}]

    // 关闭列表到指定缩进级别
    function closeListsTo(indent) {
      while (listStack.length > 0 && listStack[listStack.length - 1].indent >= indent) {
        result.push(`</${listStack.pop().type}>`);
      }
    }

    // 关闭所有列表
    function closeAllLists() {
      while (listStack.length > 0) {
        result.push(`</${listStack.pop().type}>`);
      }
    }

    // 行内格式化（加粗、斜体、代码、行内 HTML 转义）
    function formatInline(text) {
      return text
        .replace(/&/g, '&amp;')
        .replace(/<(?!\/?(?:strong|em|code|table|thead|tbody|tr|th|td|ul|ol|li|h[1-4]|p|hr|blockquote|br)\b)/g, '&lt;')
        .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/`([^`]+)`/g, '<code>$1</code>');
    }

    for (const line of lines) {
      const trimmed = line.trim();

      // 跳过已包含 HTML 标签的行（表格输出）
      if (/^<(table|thead|tbody|tr|th|td|\/)/.test(trimmed)) {
        closeAllLists();
        result.push(line);
        continue;
      }

      // 空行
      if (!trimmed) {
        closeAllLists();
        result.push('');
        continue;
      }

      // 水平线
      if (/^---+$/.test(trimmed)) {
        closeAllLists();
        result.push('<hr/>');
        continue;
      }

      // 标题（h1-h4）
      const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
      if (headingMatch) {
        closeAllLists();
        const level = headingMatch[1].length;
        result.push(`<h${level}>${formatInline(headingMatch[2])}</h${level}>`);
        continue;
      }

      // Blockquote
      if (trimmed.startsWith('> ')) {
        closeAllLists();
        result.push(`<blockquote><p>${formatInline(trimmed.slice(2))}</p></blockquote>`);
        continue;
      }

      // 计算缩进（空格数）
      const indent = line.search(/\S/);

      // 无序列表项（- 或 * 开头）
      const ulMatch = trimmed.match(/^[-*]\s+(.+)$/);
      if (ulMatch) {
        if (listStack.length === 0 || indent > listStack[listStack.length - 1].indent) {
          listStack.push({ type: 'ul', indent });
          result.push('<ul>');
        } else if (indent < listStack[listStack.length - 1].indent) {
          closeListsTo(indent + 1);
        } else if (listStack[listStack.length - 1].type !== 'ul') {
          // 同级但类型不同，关闭旧的开新的
          result.push(`</${listStack.pop().type}>`);
          listStack.push({ type: 'ul', indent });
          result.push('<ul>');
        }
        result.push(`<li>${formatInline(ulMatch[1])}</li>`);
        continue;
      }

      // 有序列表项（1. 2. 3. 等开头）
      const olMatch = trimmed.match(/^\d+\.\s+(.+)$/);
      if (olMatch) {
        if (listStack.length === 0 || indent > listStack[listStack.length - 1].indent) {
          listStack.push({ type: 'ol', indent });
          result.push('<ol>');
        } else if (indent < listStack[listStack.length - 1].indent) {
          closeListsTo(indent + 1);
        } else if (listStack[listStack.length - 1].type !== 'ol') {
          result.push(`</${listStack.pop().type}>`);
          listStack.push({ type: 'ol', indent });
          result.push('<ol>');
        }
        result.push(`<li>${formatInline(olMatch[1])}</li>`);
        continue;
      }

      // 普通段落
      closeAllLists();
      if (!trimmed.startsWith('<')) {
        result.push(`<p>${formatInline(trimmed)}</p>`);
      } else {
        result.push(line);
      }
    }
    closeAllLists();
    return result.join('\n');
  }

  // ─── 生成精美 HTML 报告 ───
  function generateHtmlReport(markdownContent, metadata = {}) {
    const bodyHtml = markdownToHtml(markdownContent);
    const now = new Date().toLocaleString('zh-CN');
    const title = metadata.title || '抖音直播 AI 分析报告';
    const anchor = metadata.anchor || '';
    const date = metadata.date || '';

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", sans-serif;
    line-height: 1.8; color: #2d2d2d;
    background: linear-gradient(135deg, #faf8f5 0%, #f5f0eb 100%);
    min-height: 100vh; -webkit-font-smoothing: antialiased;
  }
  .report-container { max-width: 860px; margin: 0 auto; padding: 60px 40px; }
  .report-header { text-align: center; margin-bottom: 48px; padding-bottom: 32px; border-bottom: 2px solid #e8ddd4; position: relative; }
  .report-header::after { content: ''; position: absolute; bottom: -2px; left: 50%; transform: translateX(-50%); width: 80px; height: 2px; background: linear-gradient(90deg, #800020, #b8860b); }
  .report-header h1 { font-size: 28px; font-weight: 700; color: #800020; letter-spacing: 1px; margin-bottom: 16px; }
  .report-meta { font-size: 13px; color: #8b7b6e; display: flex; justify-content: center; gap: 24px; flex-wrap: wrap; }
  .report-meta span { display: inline-flex; align-items: center; gap: 4px; }
  .report-body { background: rgba(255,255,255,0.85); border-radius: 16px; padding: 48px; box-shadow: 0 4px 24px rgba(128,0,32,0.06), 0 1px 4px rgba(0,0,0,0.04); border: 1px solid rgba(232,221,212,0.6); }
  .report-body h1 { font-size: 24px; font-weight: 700; color: #800020; margin: 36px 0 16px; padding-bottom: 8px; border-bottom: 1px solid #ede4dc; }
  .report-body h1:first-child { margin-top: 0; }
  .report-body h2 { font-size: 20px; font-weight: 600; color: #5a3e35; margin: 32px 0 12px; padding-left: 12px; border-left: 3px solid #800020; }
  .report-body h3 { font-size: 17px; font-weight: 600; color: #6b5548; margin: 24px 0 10px; }
  .report-body h4 { font-size: 15px; font-weight: 600; color: #7d6658; margin: 20px 0 8px; }
  .report-body p { margin: 10px 0; color: #3d3d3d; font-size: 15px; }
  .report-body ul, .report-body ol { margin: 12px 0; padding-left: 24px; }
  .report-body li { margin: 6px 0; font-size: 15px; color: #3d3d3d; }
  .report-body li::marker { color: #800020; }
  .report-body strong { color: #800020; font-weight: 600; }
  .report-body em { color: #6b5548; font-style: italic; }
  .report-body code { background: #fdf5f0; padding: 2px 6px; border-radius: 4px; font-size: 13px; color: #9f1d35; font-family: "SF Mono", "Fira Code", monospace; }
  .report-body table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 13px; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,0.04); }
  .report-body thead th { background: linear-gradient(135deg, #800020, #9f1d35); color: #fff; font-weight: 600; padding: 10px 14px; text-align: left; font-size: 12px; letter-spacing: 0.3px; }
  .report-body tbody td { padding: 9px 14px; border-bottom: 1px solid #f0e8e2; color: #4a4a4a; }
  .report-body tbody tr:nth-child(even) { background: #fdfaf8; }
  .report-body tbody tr:hover { background: #fdf5f0; }
  .report-body blockquote { margin: 16px 0; padding: 12px 20px; border-left: 3px solid #b8860b; background: #fdf8f0; border-radius: 0 8px 8px 0; color: #6b5548; font-size: 14px; }
  .report-body blockquote p { margin: 0; color: inherit; }
  .report-body hr { border: none; height: 1px; background: linear-gradient(90deg, transparent, #d4c4b8, transparent); margin: 32px 0; }
  .report-footer { text-align: center; margin-top: 40px; padding-top: 24px; border-top: 1px solid #e8ddd4; font-size: 12px; color: #a09080; }
  @media print { body { background: #fff; } .report-container { padding: 20px; } .report-body { box-shadow: none; border: none; padding: 0; background: transparent; } .report-footer { display: none; } }
</style>
</head>
<body>
<div class="report-container">
  <div class="report-header">
    <h1>${title}</h1>
    <div class="report-meta">
      ${anchor ? `<span>主播: ${anchor}</span>` : ''}
      ${date ? `<span>直播日期: ${date}</span>` : ''}
      <span>生成时间: ${now}</span>
      <span>AI: 豆包大模型</span>
    </div>
  </div>
  <div class="report-body">${bodyHtml}</div>
  <div class="report-footer">本报告由「抖音直播数据提取」插件 + 豆包大模型自动生成<br>仅供参考，具体决策请结合实际情况</div>
</div>
</body>
</html>`;
  }

  // ─── 下载函数 ───
  function downloadFile(content, filename, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ─── SVG 图标 ───
  const ICONS = {
    SETTINGS: '<svg class="dex-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    CHECK: '<svg class="dex-icon" viewBox="0 0 24 24" fill="none" stroke="#2d8a4e" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>',
    WARN: '<svg class="dex-icon" viewBox="0 0 24 24" fill="none" stroke="#c0872e" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    LOADING: '<svg class="dex-icon dex-icon-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>',
    EDIT: '<svg class="dex-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
    AI: '<svg class="dex-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a4 4 0 0 1 4 4v1h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h2V6a4 4 0 0 1 4-4z"/><circle cx="9" cy="13" r="1" fill="currentColor"/><circle cx="15" cy="13" r="1" fill="currentColor"/><path d="M10 17h4"/></svg>',
    DOWNLOAD: '<svg class="dex-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
    COPY: '<svg class="dex-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    STOP: '<svg class="dex-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>',
    STOPPED: '<svg class="dex-icon" viewBox="0 0 24 24" fill="none" stroke="#888" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>',
    OPEN: '<svg class="dex-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
    CHEVRON: '<svg class="dex-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg>'
  };

  /**
   * 创建 AI 分析面板
   */
  function createAIPanel(getDataFn, getMetaFn) {
    const panel = document.createElement('div');
    panel.className = 'dex-ai-panel';
    panel.id = 'dex-ai-panel';

    // 板块卡片 HTML（默认收起）
    const sectionCards = LLM.SECTIONS.map((sec, idx) => `
      <div class="dex-ai-section" id="dex-ai-sec-${sec.key}" data-key="${sec.key}">
        <div class="dex-ai-section-header" id="dex-ai-toggle-${sec.key}">
          <span class="dex-ai-section-num">${idx + 1}</span>
          <div class="dex-ai-section-info">
            <span class="dex-ai-section-label">${sec.label}</span>
            <span class="dex-ai-section-desc">${sec.description}</span>
          </div>
          <span class="dex-ai-section-badge" id="dex-ai-badge-${sec.key}"></span>
          <span class="dex-ai-section-chevron" id="dex-ai-chevron-${sec.key}">${ICONS.CHEVRON}</span>
        </div>
        <div class="dex-ai-section-body" id="dex-ai-body-${sec.key}" style="display:none;">
          <div class="dex-ai-section-actions" id="dex-ai-actions-${sec.key}">
            <button class="dex-btn dex-btn-ai dex-btn-section" id="dex-ai-gen-${sec.key}">${ICONS.AI} 单独生成</button>
          </div>
          <div class="dex-ai-section-status" id="dex-ai-status-${sec.key}" style="display:none;">
            <span class="dex-ai-status-icon" id="dex-ai-icon-${sec.key}"></span>
            <span class="dex-ai-status-text" id="dex-ai-text-${sec.key}"></span>
            <button class="dex-btn dex-btn-stop dex-btn-sm" id="dex-ai-stop-${sec.key}" style="display:none;">${ICONS.STOP}</button>
          </div>
        </div>
      </div>
    `).join('');

    panel.innerHTML = `
      <!-- 设置区域 -->
      <div class="dex-ai-settings" id="dex-ai-settings">
        <div class="dex-ai-settings-header" id="dex-ai-settings-toggle">
          ${ICONS.SETTINGS} <span>API 设置</span>
          <span class="dex-ai-settings-status" id="dex-ai-settings-status"></span>
        </div>
        <div class="dex-ai-settings-body" id="dex-ai-settings-body">
          <div class="dex-ai-field">
            <label>API Key</label>
            <input type="password" id="dex-ai-apikey" placeholder="输入豆包 API Key" autocomplete="off"/>
          </div>
          <div class="dex-ai-field">
            <label>模型名称</label>
            <input type="text" id="dex-ai-model" value="doubao-seed-2-0-pro-260215" autocomplete="off"/>
          </div>
          <button class="dex-btn dex-btn-primary dex-ai-save-btn" id="dex-ai-save-config">保存配置</button>
        </div>
      </div>

      <!-- 一键生成综合报告 -->
      <div class="dex-ai-main-action">
        <button class="dex-btn dex-btn-ai" id="dex-ai-btn-all" disabled>${ICONS.AI} 一键生成综合报告</button>
        <button class="dex-btn dex-btn-ai dex-btn-stop-full" id="dex-ai-btn-all-stop" style="display:none;">${ICONS.STOP} 停止生成</button>
      </div>

      <!-- 直播类型选择弹窗 -->
      <div class="dex-ai-type-modal" id="dex-ai-type-modal" style="display:none;">
        <div class="dex-ai-type-modal-content">
          <div class="dex-ai-type-modal-title">选择直播类型</div>
          <div class="dex-ai-type-modal-desc">不同类型的直播有不同的合规审核标准</div>
          <div class="dex-ai-type-cards">
            <div class="dex-ai-type-card" data-type="fund" id="dex-ai-type-fund">
              <div class="dex-ai-type-card-icon">📊</div>
              <div class="dex-ai-type-card-title">基金直播</div>
              <div class="dex-ai-type-card-desc">公募/私募基金公司的投资者教育与产品介绍直播</div>
            </div>
            <div class="dex-ai-type-card" data-type="advisory" id="dex-ai-type-advisory">
              <div class="dex-ai-type-card-icon">💼</div>
              <div class="dex-ai-type-card-title">投顾直播</div>
              <div class="dex-ai-type-card-desc">持证投资顾问的市场分析与投资建议直播</div>
            </div>
          </div>
          <button class="dex-btn dex-ai-type-cancel" id="dex-ai-type-cancel">取消</button>
        </div>
      </div>

      <!-- 综合进度 -->
      <div class="dex-ai-progress" id="dex-ai-progress" style="display:none;">
        <span class="dex-ai-status-icon" id="dex-ai-progress-icon"></span>
        <span class="dex-ai-status-text" id="dex-ai-progress-text"></span>
      </div>

      <!-- 四大板块（整体折叠） -->
      <details class="dex-details dex-ai-details-wrap">
        <summary class="dex-summary">展开单项分析</summary>
        <div class="dex-ai-sections">
          ${sectionCards}
        </div>
      </details>

      <!-- 整体优化汇总板块 -->
      <div class="dex-ai-section dex-ai-section-summary" id="dex-ai-sec-summary" style="display:none;">
        <div class="dex-ai-section-header">
          <span class="dex-ai-section-num">📋</span>
          <div class="dex-ai-section-info">
            <span class="dex-ai-section-label">${LLM.SUMMARY_SECTION.label}</span>
            <span class="dex-ai-section-desc">${LLM.SUMMARY_SECTION.description}</span>
          </div>
          <span class="dex-ai-section-badge" id="dex-ai-badge-summary"></span>
        </div>
        <div class="dex-ai-section-body" id="dex-ai-body-summary" style="display:none;">
          <div class="dex-ai-section-status" id="dex-ai-status-summary" style="display:none;">
            <span class="dex-ai-status-icon" id="dex-ai-icon-summary"></span>
            <span class="dex-ai-status-text" id="dex-ai-text-summary"></span>
          </div>
        </div>
      </div>

      <!-- 汇总下载区 -->
      <div class="dex-ai-summary" id="dex-ai-summary" style="display:none;">
        <div class="dex-btn-row">
          <button class="dex-btn dex-btn-ai" id="dex-ai-open-html">${ICONS.OPEN} 打开报告</button>
        </div>
        <div class="dex-btn-row" style="margin-top:6px;">
          <button class="dex-btn dex-btn-export" id="dex-ai-dl-html">${ICONS.DOWNLOAD} 下载 HTML</button>
          <button class="dex-btn dex-btn-export" id="dex-ai-dl-txt">${ICONS.DOWNLOAD} 下载 TXT</button>
        </div>
      </div>

      <!-- 错误提示 -->
      <div class="dex-ai-error" id="dex-ai-error" style="display:none;"></div>
    `;

    // ─── 元素引用 ───
    const $el = (id) => panel.querySelector(`#${id}`);

    const settingsToggle = $el('dex-ai-settings-toggle');
    const settingsBody = $el('dex-ai-settings-body');
    const settingsStatus = $el('dex-ai-settings-status');
    const apiKeyInput = $el('dex-ai-apikey');
    const modelInput = $el('dex-ai-model');
    const saveConfigBtn = $el('dex-ai-save-config');
    const btnAll = $el('dex-ai-btn-all');
    const btnAllStop = $el('dex-ai-btn-all-stop');
    const progressWrap = $el('dex-ai-progress');
    const progressIcon = $el('dex-ai-progress-icon');
    const progressText = $el('dex-ai-progress-text');
    const summaryWrap = $el('dex-ai-summary');
    const openHtmlBtn = $el('dex-ai-open-html');
    const dlHtmlBtn = $el('dex-ai-dl-html');
    const dlTxtBtn = $el('dex-ai-dl-txt');
    const errorEl = $el('dex-ai-error');

    // 直播类型选择弹窗元素
    const typeModal = $el('dex-ai-type-modal');
    const typeCancelBtn = $el('dex-ai-type-cancel');
    const typeFundCard = $el('dex-ai-type-fund');
    const typeAdvisoryCard = $el('dex-ai-type-advisory');

    // summary 板块元素
    const summarySectionEl = $el('dex-ai-sec-summary');
    const summaryBodyEl = $el('dex-ai-body-summary');
    const summaryStatusWrap = $el('dex-ai-status-summary');
    const summaryStatusIcon = $el('dex-ai-icon-summary');
    const summaryStatusText = $el('dex-ai-text-summary');
    const summaryBadge = $el('dex-ai-badge-summary');

    // 状态存储
    const sectionResults = {};
    const activeSections = new Set();
    let isAutoMode = false;
    let autoStopped = false;
    let currentLiveType = 'advisory'; // 当前选中的直播类型

    // 定时检查数据可用性，控制按钮 disabled 状态
    function updateBtnAllState() {
      const data = getDataFn();
      btnAll.disabled = !data;
    }
    updateBtnAllState();
    setInterval(updateBtnAllState, 3000);

    // ─── 配置管理 ───
    async function loadConfig() {
      const config = await LLM.getConfig();
      if (config.apiKey) apiKeyInput.value = config.apiKey;
      if (config.model) modelInput.value = config.model;
      if (config.apiKey && config.model) {
        settingsStatus.innerHTML = ICONS.CHECK + ' 已配置';
        settingsStatus.className = 'dex-ai-settings-status configured';
        settingsBody.style.display = 'none';
      } else {
        settingsStatus.innerHTML = ICONS.WARN + ' 未配置';
        settingsStatus.className = 'dex-ai-settings-status unconfigured';
        settingsBody.style.display = '';
      }
    }
    loadConfig();

    settingsToggle.addEventListener('click', () => {
      settingsBody.style.display = settingsBody.style.display === 'none' ? '' : 'none';
    });

    saveConfigBtn.addEventListener('click', async () => {
      const apiKey = apiKeyInput.value.trim();
      const model = modelInput.value.trim();
      if (!apiKey || !model) { showError('请填写 API Key 和模型名称'); return; }
      await LLM.setConfig({ apiKey, model });
      settingsStatus.innerHTML = ICONS.CHECK + ' 已保存';
      settingsStatus.className = 'dex-ai-settings-status configured';
      settingsBody.style.display = 'none';
      hideError();
    });

    let errorTimer = null;
    function showError(msg) {
      if (errorTimer) clearTimeout(errorTimer);
      errorEl.innerHTML = `<span class="dex-error-icon">${ICONS.WARN}</span><span class="dex-error-msg">${msg}</span><button class="dex-error-close" title="关闭"><svg class="dex-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>`;
      errorEl.style.display = '';
      errorEl.querySelector('.dex-error-close').addEventListener('click', hideError);
      errorTimer = setTimeout(hideError, 8000);
    }
    function hideError() {
      if (errorTimer) { clearTimeout(errorTimer); errorTimer = null; }
      errorEl.style.display = 'none';
    }

    // ─── 加载上次选择的直播类型 ───
    chrome.storage.local.get(['dex_live_type'], (result) => {
      if (result.dex_live_type) currentLiveType = result.dex_live_type;
    });

    // ─── 汇总 Markdown ───
    function buildFullMarkdown() {
      const parts = [];
      LLM.SECTIONS.forEach((sec, idx) => {
        if (sectionResults[sec.key]) {
          parts.push(`# ${idx + 1}. ${sec.label}\n\n${sectionResults[sec.key]}`);
        }
      });
      // 追加整体优化汇总
      if (sectionResults.summary) {
        parts.push(`# ${LLM.SECTIONS.length + 1}. ${LLM.SUMMARY_SECTION.label}\n\n${sectionResults.summary}`);
      }
      return parts.join('\n\n---\n\n');
    }

    function updateDownloadArea() {
      summaryWrap.style.display = Object.keys(sectionResults).length > 0 ? '' : 'none';
    }

    // ─── 单板块生成（返回 Promise） ───
    function generateSection(sectionKey, data, { liveType = 'advisory', previousResults = {} } = {}) {
      return new Promise((resolve, reject) => {
        // summary 板块的 UI 元素处理不同
        const isSummary = sectionKey === 'summary';
        const statusWrap = $el(`dex-ai-status-${sectionKey}`);
        const statusIcon = $el(`dex-ai-icon-${sectionKey}`);
        const statusText = $el(`dex-ai-text-${sectionKey}`);
        const stopBtn = isSummary ? null : $el(`dex-ai-stop-${sectionKey}`);
        const badge = $el(`dex-ai-badge-${sectionKey}`);
        const actionsWrap = isSummary ? null : $el(`dex-ai-actions-${sectionKey}`);
        const genBtn = isSummary ? null : $el(`dex-ai-gen-${sectionKey}`);

        activeSections.add(sectionKey);
        let charCount = 0;
        sectionResults[sectionKey] = '';
        if (actionsWrap) actionsWrap.style.display = 'none';
        statusWrap.style.display = '';
        if (stopBtn && !isAutoMode) stopBtn.style.display = '';
        statusIcon.innerHTML = ICONS.LOADING;
        statusText.textContent = '正在生成...';
        badge.innerHTML = '';
        badge.className = 'dex-ai-section-badge';

        LLM.analyze(
          data,
          sectionKey,
          (chunk) => {
            sectionResults[sectionKey] += chunk;
            charCount += chunk.length;
            statusIcon.innerHTML = ICONS.EDIT;
            statusText.textContent = `生成中... ${charCount} 字`;
          },
          () => {
            activeSections.delete(sectionKey);
            if (stopBtn) stopBtn.style.display = 'none';
            statusIcon.innerHTML = ICONS.CHECK;
            statusText.textContent = `已完成，${sectionResults[sectionKey].length} 字`;
            badge.innerHTML = ICONS.CHECK;
            badge.className = 'dex-ai-section-badge done';
            if (actionsWrap) actionsWrap.style.display = '';
            if (genBtn) genBtn.innerHTML = ICONS.AI + ' 重新生成';
            updateDownloadArea();
            // 并行模式下更新综合进度
            if (isAutoMode && !isSummary) updateParallelProgress();
            resolve();
          },
          (error) => {
            activeSections.delete(sectionKey);
            if (stopBtn) stopBtn.style.display = 'none';
            if (sectionResults[sectionKey]) {
              statusIcon.innerHTML = ICONS.WARN;
              statusText.textContent = `中断，已生成 ${sectionResults[sectionKey].length} 字`;
              badge.innerHTML = ICONS.WARN;
              badge.className = 'dex-ai-section-badge warn';
              if (actionsWrap) actionsWrap.style.display = '';
              if (genBtn) genBtn.innerHTML = ICONS.AI + ' 重新生成';
              updateDownloadArea();
            } else {
              delete sectionResults[sectionKey];
              statusWrap.style.display = 'none';
              if (actionsWrap) actionsWrap.style.display = '';
              if (genBtn) genBtn.innerHTML = ICONS.AI + ' 单独生成';
              updateDownloadArea();
            }
            if (isAutoMode && !isSummary) updateParallelProgress();
            reject(error);
          },
          { liveType, previousResults }
        );
      });
    }

    // 并行模式下更新综合进度
    function updateParallelProgress() {
      const done = LLM.SECTIONS.filter(s => sectionResults[s.key] && !activeSections.has(s.key)).length;
      const total = LLM.SECTIONS.length;
      if (done === total) {
        progressIcon.innerHTML = ICONS.CHECK;
        progressText.textContent = `${total} 个板块生成完成，正在汇总整体优化建议...`;
      } else {
        progressIcon.innerHTML = ICONS.LOADING;
        progressText.textContent = `正在并行生成 ${activeSections.size} 个板块，已完成 ${done}/${total}`;
      }
    }

    // ─── 整体优化汇总生成 ───
    async function generateSummarySection(data) {
      // 显示汇总板块
      summarySectionEl.style.display = '';
      summaryBodyEl.style.display = '';

      try {
        await generateSection('summary', data, {
          liveType: currentLiveType,
          previousResults: { ...sectionResults }
        });
      } catch (err) {
        console.warn('[AI面板] 汇总生成出错:', err);
      }
    }

    // ─── 直播类型选择弹窗逻辑 ───
    function showTypeModal() {
      return new Promise((resolve) => {
        // 高亮上次选择
        typeFundCard.classList.toggle('selected', currentLiveType === 'fund');
        typeAdvisoryCard.classList.toggle('selected', currentLiveType === 'advisory');
        typeModal.style.display = '';

        function handleSelect(type) {
          currentLiveType = type;
          chrome.storage.local.set({ dex_live_type: type });
          typeModal.style.display = 'none';
          cleanup();
          resolve(type);
        }

        function handleCancel() {
          typeModal.style.display = 'none';
          cleanup();
          resolve(null);
        }

        function onFund() { handleSelect('fund'); }
        function onAdvisory() { handleSelect('advisory'); }

        function cleanup() {
          typeFundCard.removeEventListener('click', onFund);
          typeAdvisoryCard.removeEventListener('click', onAdvisory);
          typeCancelBtn.removeEventListener('click', handleCancel);
        }

        typeFundCard.addEventListener('click', onFund);
        typeAdvisoryCard.addEventListener('click', onAdvisory);
        typeCancelBtn.addEventListener('click', handleCancel);
      });
    }

    // ─── 一键生成综合报告（选择类型 → 并行生成 4 板块 → 汇总） ───
    btnAll.addEventListener('click', async () => {
      if (activeSections.size > 0) { showError('请等待当前板块生成完成'); return; }
      hideError();

      const data = getDataFn();
      if (!data) { showError('暂无数据，请先采集直播数据'); return; }

      // 弹出直播类型选择
      const selectedType = await showTypeModal();
      if (!selectedType) return; // 用户取消

      isAutoMode = true;
      autoStopped = false;
      btnAll.style.display = 'none';
      btnAllStop.style.display = '';
      progressWrap.style.display = '';
      progressIcon.innerHTML = ICONS.LOADING;
      progressText.textContent = `正在并行生成 ${LLM.SECTIONS.length} 个板块（${selectedType === 'fund' ? '基金' : '投顾'}模式）...`;

      // 隐藏上次的汇总板块
      summarySectionEl.style.display = 'none';
      summaryBodyEl.style.display = 'none';
      delete sectionResults.summary;

      // 展开所有板块
      LLM.SECTIONS.forEach(sec => {
        const body = $el(`dex-ai-body-${sec.key}`);
        const chevron = $el(`dex-ai-chevron-${sec.key}`);
        const sectionEl = $el(`dex-ai-sec-${sec.key}`);
        body.style.display = '';
        chevron.classList.add('open');
        sectionEl.classList.add('expanded');
      });

      // 并行发起所有板块生成
      const results = await Promise.allSettled(
        LLM.SECTIONS.map(sec => generateSection(sec.key, data, { liveType: selectedType }))
      );

      const succeeded = results.filter(r => r.status === 'fulfilled').length;

      // 4 板块全部完成后自动生成汇总
      if (succeeded === LLM.SECTIONS.length && !autoStopped) {
        progressIcon.innerHTML = ICONS.LOADING;
        progressText.textContent = '正在汇总整体优化建议...';
        await generateSummarySection(data);
        progressIcon.innerHTML = ICONS.CHECK;
        progressText.textContent = `综合报告生成完成，共 ${LLM.SECTIONS.length + 1} 个部分`;
      } else if (autoStopped) {
        progressIcon.innerHTML = ICONS.STOPPED;
        progressText.textContent = '已停止';
      } else {
        progressIcon.innerHTML = ICONS.WARN;
        progressText.textContent = `已完成 ${succeeded}/${LLM.SECTIONS.length} 个板块（部分失败，未生成汇总）`;
      }

      // 完成或中断
      isAutoMode = false;
      btnAll.style.display = '';
      btnAllStop.style.display = 'none';
      btnAll.innerHTML = ICONS.AI + ' 重新生成综合报告';
      updateDownloadArea();
    });

    // 停止一键生成（停止全部）
    btnAllStop.addEventListener('click', () => {
      autoStopped = true;
      LLM.stop(); // 停止全部活跃连接
    });

    // ─── 板块折叠/展开 ───
    LLM.SECTIONS.forEach((sec) => {
      const toggleEl = $el(`dex-ai-toggle-${sec.key}`);
      const bodyEl = $el(`dex-ai-body-${sec.key}`);
      const chevronEl = $el(`dex-ai-chevron-${sec.key}`);

      toggleEl.addEventListener('click', () => {
        const isHidden = bodyEl.style.display === 'none';
        bodyEl.style.display = isHidden ? '' : 'none';
        chevronEl.classList.toggle('open', isHidden);
        toggleEl.closest('.dex-ai-section').classList.toggle('expanded', isHidden);
      });

      // 单独生成按钮
      const genBtn = $el(`dex-ai-gen-${sec.key}`);
      genBtn.addEventListener('click', async () => {
        if (activeSections.has(sec.key)) { showError('该板块正在生成中'); return; }
        hideError();
        const data = getDataFn();
        if (!data) { showError('暂无数据，请先采集直播数据'); return; }
        try {
          await generateSection(sec.key, data, { liveType: currentLiveType });
        } catch (err) {
          showError(err);
        }
      });

      // 停止单独生成
      const stopBtn = $el(`dex-ai-stop-${sec.key}`);
      stopBtn.addEventListener('click', () => {
        LLM.stop(sec.key);
        activeSections.delete(sec.key);
        stopBtn.style.display = 'none';
        const statusIcon = $el(`dex-ai-icon-${sec.key}`);
        const statusText = $el(`dex-ai-text-${sec.key}`);
        if (sectionResults[sec.key]) {
          statusIcon.innerHTML = ICONS.STOPPED;
          statusText.textContent = `已停止，${sectionResults[sec.key].length} 字`;
          $el(`dex-ai-badge-${sec.key}`).innerHTML = ICONS.WARN;
          $el(`dex-ai-badge-${sec.key}`).className = 'dex-ai-section-badge warn';
          $el(`dex-ai-actions-${sec.key}`).style.display = '';
          genBtn.innerHTML = ICONS.AI + ' 重新生成';
          updateDownloadArea();
        } else {
          $el(`dex-ai-status-${sec.key}`).style.display = 'none';
          $el(`dex-ai-actions-${sec.key}`).style.display = '';
        }
      });
    });

    // ─── 生成 HTML 报告内容 ───
    function buildHtmlReport() {
      const md = buildFullMarkdown();
      if (!md) return null;
      const meta = getMetaFn();
      const reportTitle = `${meta.filename}_AI分析报告`;
      return {
        html: generateHtmlReport(md, {
          title: reportTitle,
          anchor: meta.anchor,
          date: meta.date
        }),
        filename: meta.filename
      };
    }

    // ─── 打开报告（新标签页） ───
    openHtmlBtn.addEventListener('click', () => {
      const report = buildHtmlReport();
      if (!report) return;
      const blob = new Blob([report.html], { type: 'text/html;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
    });

    // ─── 下载 HTML ───
    dlHtmlBtn.addEventListener('click', () => {
      const report = buildHtmlReport();
      if (!report) return;
      downloadFile(report.html, `${report.filename}_AI分析报告.html`, 'text/html;charset=utf-8');
    });

    // ─── 下载 TXT ───
    dlTxtBtn.addEventListener('click', () => {
      const md = buildFullMarkdown();
      if (!md) return;
      const meta = getMetaFn();
      downloadFile(md, `${meta.filename}_AI分析报告.txt`, 'text/plain;charset=utf-8');
    });

    return panel;
  }

  window.__douyinAIPanel = { createAIPanel };
})();
