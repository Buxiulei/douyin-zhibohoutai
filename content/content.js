/**
 * Content Script 主入口 — 悬浮窗 UI 创建与交互
 */
(function () {
  'use strict';

  // 防止重复注入
  if (document.getElementById('douyin-extractor-float')) return;

  const scraper = window.__douyinScraper;
  const Exporter = window.__douyinExporter;

  // ========================
  //  创建悬浮窗 DOM
  // ========================
  // SVG 图标常量
  const ICONS = {
    MINIMIZE: '<svg class="dex-icon" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    EXPAND: '<svg class="dex-icon" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" fill="none"><rect x="4" y="4" width="16" height="16" rx="2" ry="2"/></svg>',
    SCRAPING: '<svg class="dex-icon" style="width:10px;height:10px;margin-right:4px;" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10"/></svg>',
    FLASH: '<svg class="dex-icon" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linejoin="round" fill="none"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
    STOP: '<svg class="dex-icon" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
    PACKAGE: '<svg class="dex-icon" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>',
    PLAY: '<svg class="dex-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M5 3l14 9-14 9V3z"/></svg>',
    FILE_TEXT: '<svg class="dex-icon" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>',
    CLIPBOARD: '<svg class="dex-icon" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>',
    CHART: '<svg class="dex-icon" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>',
    TREND_UP: '<svg class="dex-icon" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>',
    TRASH: '<svg class="dex-icon" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>'
  };

  const floatEl = document.createElement('div');
  floatEl.id = 'douyin-extractor-float';
  floatEl.innerHTML = `
    <div class="dex-panel">
      <!-- 标题栏 -->
      <div class="dex-header" id="dex-drag-handle">
        <div class="dex-header-title">
          直播数据提取
          <span class="dex-version">v2.4.0</span>
          <span class="dex-scraping-indicator" id="dex-scraping-indicator">${ICONS.SCRAPING} 采集中</span>
        </div>
        <div class="dex-header-actions">
          <button class="dex-header-btn dex-btn-minimize" id="dex-btn-minimize" title="最小化">${ICONS.MINIMIZE}</button>
        </div>
      </div>

      <!-- 主体 -->
      <div class="dex-body">
        <!-- 统计 -->
        <div class="dex-stats">
          <div class="dex-stat-item">
            <span class="dex-stat-value" id="dex-stat-transcript">0</span>
            <span class="dex-stat-label">文字记录</span>
          </div>
          <div class="dex-stat-item">
            <span class="dex-stat-value" id="dex-stat-comment">0</span>
            <span class="dex-stat-label">评论</span>
          </div>
          <div class="dex-stat-item">
            <span class="dex-stat-value" id="dex-stat-trend">0</span>
            <span class="dex-stat-label">趋势</span>
          </div>
        </div>

        <!-- 一键全部采集 -->
        <div class="dex-btn-row">
          <button class="dex-btn dex-btn-all" id="dex-btn-scrape-all">${ICONS.FLASH} 一键全部采集</button>
          <button class="dex-btn dex-btn-stop" id="dex-btn-stop-all" style="display:none;">${ICONS.STOP} 停止</button>
        </div>
        <div class="dex-btn-row">
          <button class="dex-btn dex-btn-export" id="dex-btn-export-fusion-md" disabled>${ICONS.FILE_TEXT} 导出 MD</button>
          <button class="dex-btn dex-btn-export" id="dex-btn-export-fusion-txt" disabled>${ICONS.FILE_TEXT} 导出 TXT</button>
        </div>

        <!-- 进度条 -->
        <div class="dex-progress-wrap" id="dex-progress-wrap">
          <div class="dex-progress-bar">
            <div class="dex-progress-fill" id="dex-progress-fill"></div>
          </div>
          <div class="dex-progress-text" id="dex-progress-text">准备中...</div>
        </div>

        <!-- 单项操作折叠区 -->
        <details class="dex-details">
          <summary class="dex-summary">展开单项操作</summary>
          
          <!-- 文字记录操作 -->
          <div class="dex-section-label">文字记录</div>
          <div class="dex-btn-row">
            <button class="dex-btn dex-btn-primary" id="dex-btn-scrape-transcript">${ICONS.PLAY} 开始采集</button>
            <button class="dex-btn dex-btn-stop" id="dex-btn-stop-transcript" style="display:none;">${ICONS.STOP} 停止</button>
          </div>
          <div class="dex-btn-row">
            <button class="dex-btn dex-btn-export" id="dex-btn-export-transcript-plain" disabled>${ICONS.FILE_TEXT} 导出纯文本</button>
            <button class="dex-btn dex-btn-export" id="dex-btn-export-transcript-full" disabled>${ICONS.CLIPBOARD} 导出完整记录</button>
          </div>

          <div class="dex-divider"></div>

          <!-- 评论操作 -->
          <div class="dex-section-label">直播间评论</div>
          <div class="dex-btn-row">
            <button class="dex-btn dex-btn-primary" id="dex-btn-scrape-comment">${ICONS.PLAY} 开始采集</button>
            <button class="dex-btn dex-btn-stop" id="dex-btn-stop-comment" style="display:none;">${ICONS.STOP} 停止</button>
          </div>
          <div class="dex-btn-row">
            <button class="dex-btn dex-btn-export" id="dex-btn-export-comment-plain" disabled>${ICONS.FILE_TEXT} 导出纯文本</button>
            <button class="dex-btn dex-btn-export" id="dex-btn-export-comment-full" disabled>${ICONS.CLIPBOARD} 导出完整记录</button>
          </div>

          <div class="dex-divider"></div>

          <!-- 趋势数据 -->
          <div class="dex-section-label">趋势数据</div>
          <div class="dex-btn-row">
            <button class="dex-btn dex-btn-primary" id="dex-btn-scrape-trend">${ICONS.TREND_UP} 采集趋势</button>
          </div>
          <div class="dex-btn-row">
            <button class="dex-btn dex-btn-export" id="dex-btn-export-trend" disabled>${ICONS.CHART} 导出CSV</button>
          </div>
        </details>

        <!-- AI 分析面板挂载点 -->
        <div id="dex-ai-mount"></div>
      </div>

      <!-- 底部 -->
      <div class="dex-footer">
        <button class="dex-btn dex-btn-danger" id="dex-btn-clear">${ICONS.TRASH} 清空全部数据</button>
      </div>
      <!-- 四角缩放手柄 -->
      <div class="dex-resize-handle dex-resize-tl" data-dir="tl" title="拖拽缩放"></div>
      <div class="dex-resize-handle dex-resize-tr" data-dir="tr" title="拖拽缩放"></div>
      <div class="dex-resize-handle dex-resize-bl" data-dir="bl" title="拖拽缩放"></div>
      <div class="dex-resize-handle dex-resize-br" data-dir="br" title="拖拽缩放"></div>
    </div>
  `;

  document.body.appendChild(floatEl);

  // ========================
  //  DOM 引用
  // ========================
  const $ = (id) => document.getElementById(id);

  const statTranscript = $('dex-stat-transcript');
  const statComment = $('dex-stat-comment');
  const statTrend = $('dex-stat-trend');
  const progressWrap = $('dex-progress-wrap');
  const progressFill = $('dex-progress-fill');
  const progressText = $('dex-progress-text');
  const scrapingIndicator = $('dex-scraping-indicator');

  const btnScrapeTranscript = $('dex-btn-scrape-transcript');
  const btnStopTranscript = $('dex-btn-stop-transcript');
  const btnExportTranscriptPlain = $('dex-btn-export-transcript-plain');
  const btnExportTranscriptFull = $('dex-btn-export-transcript-full');

  const btnScrapeComment = $('dex-btn-scrape-comment');
  const btnStopComment = $('dex-btn-stop-comment');
  const btnExportCommentPlain = $('dex-btn-export-comment-plain');
  const btnExportCommentFull = $('dex-btn-export-comment-full');

  const btnScrapeAll = $('dex-btn-scrape-all');
  const btnStopAll = $('dex-btn-stop-all');
  const btnExportFusionMd = $('dex-btn-export-fusion-md');
  const btnExportFusionTxt = $('dex-btn-export-fusion-txt');

  const btnMinimize = $('dex-btn-minimize');
  const btnClear = $('dex-btn-clear');

  // ========================
  //  拖拽功能
  // ========================
  const dragHandle = $('dex-drag-handle');
  let isDragging = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;
  let currentScale = 1; // 当前缩放比例

  dragHandle.addEventListener('mousedown', (e) => {
    // 点击按钮时不触发拖拽
    if (e.target.closest('.dex-header-actions')) return;
    isDragging = true;
    const rect = floatEl.getBoundingClientRect();
    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const x = e.clientX - dragOffsetX;
    const y = e.clientY - dragOffsetY;
    floatEl.style.left = `${Math.max(0, x)}px`;
    floatEl.style.top = `${Math.max(0, y)}px`;
    floatEl.style.right = 'auto';
    floatEl.style.bottom = 'auto';
  });

  document.addEventListener('mouseup', () => {
    isDragging = false;
  });

  // ========================
  //  缩放功能（四角手柄）
  // ========================
  const resizeHandles = floatEl.querySelectorAll('.dex-resize-handle');
  let isResizing = false;
  let resizeStartX = 0;
  let resizeStartY = 0;
  let resizeStartScale = 1;
  let resizeDir = 'br';

  resizeHandles.forEach((handle) => {
    handle.addEventListener('mousedown', (e) => {
      isResizing = true;
      resizeDir = handle.dataset.dir;
      resizeStartX = e.clientX;
      resizeStartY = e.clientY;
      resizeStartScale = currentScale;
      e.preventDefault();
      e.stopPropagation();
    });
  });

  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    const dx = e.clientX - resizeStartX;
    const dy = e.clientY - resizeStartY;

    // 根据角落方向计算缩放增量
    let delta;
    switch (resizeDir) {
      case 'br': delta = (dx + dy) / 2; break;   // 右下：正向
      case 'tl': delta = (-dx - dy) / 2; break;   // 左上：反向
      case 'tr': delta = (dx - dy) / 2; break;    // 右上：x正y反
      case 'bl': delta = (-dx + dy) / 2; break;   // 左下：x反y正
      default: delta = (dx + dy) / 2;
    }

    const newScale = Math.min(1.5, Math.max(0.5, resizeStartScale + delta / 300));
    currentScale = newScale;
    floatEl.style.transform = `scale(${currentScale})`;
  });

  document.addEventListener('mouseup', () => {
    isResizing = false;
  });

  // ========================
  //  最小化
  // ========================
  let isMinimized = false;
  btnMinimize.addEventListener('click', () => {
    isMinimized = !isMinimized;
    floatEl.classList.toggle('minimized', isMinimized);
    btnMinimize.innerHTML = isMinimized ? ICONS.EXPAND : ICONS.MINIMIZE; // 使用 innerHTML 替换 SVG
    btnMinimize.title = isMinimized ? '展开' : '最小化';
  });

  // ========================
  //  更新 UI 状态
  // ========================
  function updateStats() {
    statTranscript.textContent = scraper.transcriptData.size;
    statComment.textContent = scraper.commentData.size;
    const trendCount = Object.keys(scraper.trendData).length;
    statTrend.textContent = trendCount;

    btnExportTranscriptPlain.disabled = scraper.transcriptData.size === 0;
    btnExportTranscriptFull.disabled = scraper.transcriptData.size === 0;
    btnExportCommentPlain.disabled = scraper.commentData.size === 0;
    btnExportCommentFull.disabled = scraper.commentData.size === 0;

    const btnExportTrend = $('dex-btn-export-trend');
    if (btnExportTrend) btnExportTrend.disabled = trendCount === 0;

    // 融合报告：任意一类数据有内容即可导出
    const hasData = !(scraper.transcriptData.size === 0 && scraper.commentData.size === 0 && trendCount === 0);
    btnExportFusionMd.disabled = !hasData;
    btnExportFusionTxt.disabled = !hasData;
  }

  function showProgress(show) {
    progressWrap.classList.toggle('active', show);
  }

  function setProgress(percent, text) {
    progressFill.style.width = `${percent}%`;
    progressText.textContent = text || '';
  }

  function setScrapingState(type, isScraping) {
    if (type === 'transcript') {
      btnScrapeTranscript.style.display = isScraping ? 'none' : '';
      btnStopTranscript.style.display = isScraping ? '' : 'none';
      btnScrapeTranscript.disabled = false;
    } else {
      btnScrapeComment.style.display = isScraping ? 'none' : '';
      btnStopComment.style.display = isScraping ? '' : 'none';
      btnScrapeComment.disabled = false;
    }
    scrapingIndicator.classList.toggle('active', isScraping);
    showProgress(isScraping);
  }

  // ========================
  //  采集按钮事件
  // ========================
  async function startScraping(type) {
    setScrapingState(type, true);
    // 禁用另一个采集按钮
    if (type === 'transcript') {
      btnScrapeComment.disabled = true;
    } else {
      btnScrapeTranscript.disabled = true;
    }

    await scraper.startScraping(type, (count, percent, status, message) => {
      setProgress(percent, message);
      updateStats();

      if (status === 'done' || status === 'stopped' || status === 'error') {
        setScrapingState(type, false);
        // 恢复另一个采集按钮
        btnScrapeComment.disabled = false;
        btnScrapeTranscript.disabled = false;
        showProgress(false);
      }
    });
  }

  btnScrapeTranscript.addEventListener('click', () => startScraping('transcript'));
  btnScrapeComment.addEventListener('click', () => startScraping('comment'));

  btnStopTranscript.addEventListener('click', () => scraper.stop());
  btnStopComment.addEventListener('click', () => scraper.stop());

  // ========================
  //  一键全部采集
  // ========================
  let isScrapingAll = false;

  async function startScrapingAll() {
    if (scraper.isRunning || isScrapingAll) return;
    isScrapingAll = true;

    // UI 状态：禁用所有单独采集按钮
    btnScrapeAll.style.display = 'none';
    btnStopAll.style.display = '';
    btnScrapeTranscript.disabled = true;
    btnScrapeComment.disabled = true;
    scrapingIndicator.classList.add('active');
    showProgress(true);

    // 单次扫描：同时采集文字记录 + 评论
    setProgress(0, '正在采集...');
    await scraper.startScraping('all', (count, percent, status, message) => {
      setProgress(percent, message);
      updateStats();
    });

    // 恢复 UI
    isScrapingAll = false;
    btnScrapeAll.style.display = '';
    btnStopAll.style.display = 'none';
    btnScrapeTranscript.disabled = false;
    btnScrapeComment.disabled = false;
    scrapingIndicator.classList.remove('active');
    showProgress(false);
    updateStats();
  }

  btnScrapeAll.addEventListener('click', () => startScrapingAll());
  btnStopAll.addEventListener('click', () => scraper.stop());

  /**
   * 从页面 DOM 中提取直播元数据，生成有意义的文件名前缀
   * 格式: 主播名_日期_标题
   */
  const getLiveMetaFilename = () => {
    /**
     * 清理文件名：只保留中英文、数字、下划线，去掉零宽字符、特殊符号等
     */
    const sanitize = (str) => {
      if (!str) return '';
      return str
        .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '')  // 去掉零宽/不可见字符
        .replace(/[^\u4e00-\u9fa5a-zA-Z0-9_\-]/g, '')  // 只保留中英文数字下划线连字符
        .substring(0, 30);
    };

    // 主播名
    const anchorName = sanitize(document.querySelector('.WGzwx span')?.textContent?.trim());

    // 直播标题
    const title = sanitize(document.querySelector('.basic-name')?.textContent?.trim());

    // 开播时间 → 提取日期
    let dateStr = '';
    const timeEls = document.querySelectorAll('.basic-time');
    for (const el of timeEls) {
      const label = el.querySelector('.basic-time-label')?.textContent || '';
      if (label.includes('开播时间')) {
        const val = el.querySelector('.basic-time-value')?.textContent?.trim() || '';
        dateStr = val.split(' ')[0]?.replace(/-/g, '') || '';
        break;
      }
    }

    // 组合：主播名_日期_标题，缺失部分跳过
    const parts = [anchorName, dateStr, title].filter(Boolean);
    return parts.length > 0 ? parts.join('_') : `直播数据_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
  };

  btnExportTranscriptPlain.addEventListener('click', () => {
    Exporter.exportPlainText(scraper.getData('transcript'), `${getLiveMetaFilename()}_文字记录`);
  });

  btnExportTranscriptFull.addEventListener('click', () => {
    Exporter.exportFullRecord(scraper.getData('transcript'), `${getLiveMetaFilename()}_文字记录`);
  });

  btnExportCommentPlain.addEventListener('click', () => {
    Exporter.exportPlainText(scraper.getData('comment'), `${getLiveMetaFilename()}_评论`);
  });

  btnExportCommentFull.addEventListener('click', () => {
    Exporter.exportFullRecord(scraper.getData('comment'), `${getLiveMetaFilename()}_评论`);
  });

  // ========================
  //  清空数据
  // ========================
  btnClear.addEventListener('click', () => {
    if (confirm('确定要清空全部已采集的数据吗？')) {
      scraper.clearData();
      updateStats();
    }
  });

  // ========================
  //  趋势数据
  // ========================
  const btnScrapeTrend = $('dex-btn-scrape-trend');
  const btnExportTrend = $('dex-btn-export-trend');

  btnScrapeTrend.addEventListener('click', async () => {
    if (scraper.isRunning) return;
    btnScrapeTrend.disabled = true;
    scrapingIndicator.classList.add('active');
    showProgress(true);

    await scraper.startScraping('trend', (count, percent, status, message) => {
      setProgress(percent, message);
      updateStats();
    });

    btnScrapeTrend.disabled = false;
    scrapingIndicator.classList.remove('active');
    showProgress(false);
    updateStats();
  });

  btnExportTrend.addEventListener('click', () => {
    Exporter.exportTrendCSV(scraper.getData('trend'), getLiveMetaFilename());
  });

  // ========================
  //  融合报告导出
  // ========================  // 导出融合报告 (Markdown)
  btnExportFusionMd.addEventListener('click', () => {
    const filename = getLiveMetaFilename();
    Exporter.exportFusion(
      Array.from(scraper.transcriptData.values()),
      Array.from(scraper.commentData.values()),
      scraper.trendData,
      filename,
      'md'
    );
  });

  // 导出融合报告 (TXT)
  btnExportFusionTxt.addEventListener('click', () => {
    const filename = getLiveMetaFilename();
    Exporter.exportFusion(
      Array.from(scraper.transcriptData.values()),
      Array.from(scraper.commentData.values()),
      scraper.trendData,
      filename,
      'txt'
    );
  });

  // ========================
  //  AI 分析面板
  // ========================
  const AIPanel = window.__douyinAIPanel;
  if (AIPanel) {
    const aiMount = $('dex-ai-mount');
    const aiPanelEl = AIPanel.createAIPanel(
      // getDataFn — 收集当前已采集的所有数据
      () => {
        const transcriptData = Array.from(scraper.transcriptData.values());
        const commentData = Array.from(scraper.commentData.values());
        const trendData = scraper.trendData;
        if (transcriptData.length === 0 && commentData.length === 0 && Object.keys(trendData).length === 0) {
          return null;
        }
        return { transcriptData, commentData, trendData };
      },
      // getMetaFn — 获取直播元数据
      () => {
        const filename = getLiveMetaFilename();
        const anchorName = document.querySelector('.WGzwx span')?.textContent?.trim() || '';
        let dateStr = '';
        const timeEls = document.querySelectorAll('.basic-time');
        for (const el of timeEls) {
          const label = el.querySelector('.basic-time-label')?.textContent || '';
          if (label.includes('开播时间')) {
            dateStr = el.querySelector('.basic-time-value')?.textContent?.trim()?.split(' ')[0] || '';
            break;
          }
        }
        return { filename, anchor: anchorName, date: dateStr };
      }
    );
    aiMount.appendChild(aiPanelEl);
  }

  // ========================
  //  Service Worker 保活（心跳）
  // ========================
  // 当抖音直播后台页面打开时，维持 background Service Worker 活跃，
  // 防止 Chrome 休眠导致 LLM 流式请求中断。
  let keepAlivePort = null;
  let keepAliveTimer = null;

  function setupKeepAlive() {
    try {
      keepAlivePort = chrome.runtime.connect({ name: 'keep-alive' });

      keepAlivePort.onDisconnect.addListener(() => {
        keepAlivePort = null;
        // Service Worker 可能被重启，延迟后自动重连
        setTimeout(setupKeepAlive, 1000);
      });

      // 每 25 秒发送一次心跳（Chrome 30 秒无活动会休眠 SW）
      if (keepAliveTimer) clearInterval(keepAliveTimer);
      keepAliveTimer = setInterval(() => {
        try {
          if (keepAlivePort) keepAlivePort.postMessage({ type: 'PING' });
        } catch (_) {
          // port 已关闭，等 onDisconnect 处理重连
        }
      }, 25000);
    } catch (_) {
      // 插件被禁用或卸载时忽略
    }
  }

  setupKeepAlive();

  // 页面卸载时清理
  window.addEventListener('beforeunload', () => {
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    if (keepAlivePort) { try { keepAlivePort.disconnect(); } catch (_) { } }
  });

  console.log('[抖音直播数据提取] 插件已加载，悬浮窗已就绪');
})();
