/**
 * 数据采集引擎 — 高性能版
 *
 * 优化策略：
 * 1. 条件触发：用 MutationObserver 监听 DOM 变化，就绪即刻下一步
 * 2. 智能跳跃：按分钟时间戳跳跃滚动文字记录，每分钟只点一次
 * 3. 去重贯穿全流程：文字记录按内容去重，评论按分钟 + 内容双重去重
 */
class Scraper {
  constructor() {
    this.transcriptData = new Map();
    this.commentData = new Map();
    this.trendData = {};         // { tabName: { xAxis: [...], series: [{name, data}] } }
    this.isRunning = false;
    this._stopRequested = false;

    // 初始化 Tick Worker — 不被浏览器节流的定时器
    this._tickCallbacks = new Map();
    this._tickId = 0;
    this._initTickWorker();
  }

  /**
   * 内联创建 Tick Worker（Blob URL）
   * Web Worker 内的 setTimeout 不受标签页后台节流
   */
  _initTickWorker() {
    const workerCode = `
      const timers = new Map();
      self.onmessage = function(e) {
        const { action, id, delay } = e.data;
        if (action === 'setTimeout') {
          const t = setTimeout(() => {
            timers.delete(id);
            self.postMessage({ id });
          }, delay || 0);
          timers.set(id, t);
        }
        if (action === 'clearTimeout') {
          const t = timers.get(id);
          if (t) { clearTimeout(t); timers.delete(id); }
        }
      };
    `;
    try {
      const blob = new Blob([workerCode], { type: 'application/javascript' });
      this._tickWorker = new Worker(URL.createObjectURL(blob));
      this._tickWorker.onmessage = (e) => {
        const cb = this._tickCallbacks.get(e.data.id);
        if (cb) {
          this._tickCallbacks.delete(e.data.id);
          cb();
        }
      };
    } catch (err) {
      console.warn('[抖音提取] Tick Worker 创建失败，降级到原生 setTimeout:', err);
      this._tickWorker = null;
    }
  }

  // ─── 工具方法 ───

  _getDedupeKey(item) {
    const contentSlice = (item.content || '').substring(0, 30);
    return `${item.time || ''}_${item.speaker || ''}_${contentSlice}`;
  }

  /**
   * 不被浏览器节流的 sleep
   * 优先使用 Tick Worker，失败时降级到原生 setTimeout
   */
  _sleep(ms) {
    if (this._tickWorker) {
      return new Promise(resolve => {
        const id = ++this._tickId;
        this._tickCallbacks.set(id, resolve);
        this._tickWorker.postMessage({ action: 'setTimeout', id, delay: ms });
      });
    }
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 模拟真实鼠标滚轮操作
   * 派发 wheel 事件 + 设置 scrollTop，确保触发所有滚动监听器
   * @param {Element} container - 滚动容器
   * @param {number} deltaY - 正值向下滚，负值向上滚
   */
  _simulateScroll(container, deltaY) {
    // 派发 wheel 事件（模拟鼠标滚轮）
    container.dispatchEvent(new WheelEvent('wheel', {
      deltaY,
      deltaX: 0,
      bubbles: true,
      cancelable: true,
    }));
    // 同时设置 scrollTop 确保实际滚动发生
    container.scrollTop += deltaY;
    // 派发 scroll 事件（确保所有监听器收到通知）
    container.dispatchEvent(new Event('scroll', { bubbles: true }));
  }

  /**
   * 模拟滚动到底部
   */
  _scrollToBottom(container) {
    const delta = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (delta > 0) {
      this._simulateScroll(container, delta);
    }
  }

  /**
   * 模拟滚动到顶部
   */
  _scrollToTop(container) {
    container.scrollTop = 0;
    container.dispatchEvent(new Event('scroll', { bubbles: true }));
  }

  /**
   * 条件等待：监听容器子节点变化，变化即返回；超时兜底
   * 比固定 sleep 快得多 — 数据就绪瞬间触发，不浪费时间
   */
  _waitForDOMUpdate(container, timeoutMs = 2000) {
    return new Promise(resolve => {
      let resolved = false;
      let tickTimerId = null;

      const done = () => {
        if (resolved) return;
        resolved = true;
        observer.disconnect();
        // 清除超时定时器
        if (this._tickWorker && tickTimerId !== null) {
          this._tickWorker.postMessage({ action: 'clearTimeout', id: tickTimerId });
          this._tickCallbacks.delete(tickTimerId);
        }
        resolve();
      };

      const observer = new MutationObserver(() => {
        requestAnimationFrame(done);
      });

      observer.observe(container, {
        childList: true,
        subtree: true,
        characterData: true
      });

      // 超时兜底 — 使用 Tick Worker
      if (this._tickWorker) {
        tickTimerId = ++this._tickId;
        this._tickCallbacks.set(tickTimerId, done);
        this._tickWorker.postMessage({ action: 'setTimeout', id: tickTimerId, delay: timeoutMs });
      } else {
        setTimeout(done, timeoutMs);
      }
    });
  }

  /**
   * 等待评论面板内容变化
   * 点击文字记录后，评论区 DOM 会更新 — 监听到变化即采集
   */
  _waitForCommentChange(commentContainer, timeoutMs = 2000) {
    if (!commentContainer) return this._sleep(200);
    return this._waitForDOMUpdate(commentContainer, timeoutMs);
  }

  /**
   * 检测评论面板是否显示「该分钟内无评论内容」
   */
  _isCommentEmpty() {
    const emptyEl = document.querySelector('.empty[elementtiming="element-timing"]');
    if (emptyEl && emptyEl.textContent.includes('该分钟内无评论内容')) return true;
    // 备用：检测所有可能的空状态提示
    const emptyDivs = document.querySelectorAll('.empty');
    for (const el of emptyDivs) {
      if (el.textContent.includes('无评论')) return true;
    }
    return false;
  }

  /**
   * 等待评论面板加载完成（动态检测 DOM 稳定）
   * 使用 MutationObserver 监听：Observer 触发后，若 stableMs 内无新变化，即认为加载完毕
   */
  _waitForCommentReady(stableMs = 200) {
    return new Promise((resolve) => {
      const container = this._findCommentScrollContainer();
      if (!container) return resolve();

      let lastMutation = 0;
      let observerFired = false;

      const observer = new MutationObserver(() => {
        lastMutation = Date.now();
        observerFired = true;
      });

      observer.observe(container, { childList: true, subtree: true });

      const checkInterval = 50;
      const maxWait = 3000;
      const startTime = Date.now();

      // 轮询检测 — 使用递归 tick 替代 setInterval
      const check = () => {
        const now = Date.now();
        if (now - startTime > maxWait) { cleanup(); resolve(); return; }
        if (observerFired && (now - lastMutation > stableMs)) { cleanup(); resolve(); return; }
        if (!observerFired && (now - startTime > 500) && this._parseCommentNodes().length > 0) { cleanup(); resolve(); return; }
        // 下一轮 tick
        this._sleep(checkInterval).then(check);
      };
      check();

      function cleanup() {
        observer.disconnect();
      }
    });
  }

  // ─── 容器定位 ───

  _getAllGrids() {
    return document.querySelectorAll('.ReactVirtualized__Grid.ReactVirtualized__List');
  }

  _findTranscriptScrollContainer() {
    const grids = this._getAllGrids();
    return grids.length > 0 ? grids[0] : null;
  }

  _findCommentScrollContainer() {
    const grids = this._getAllGrids();
    return grids.length > 1 ? grids[1] : null;
  }

  _getTranscriptInner() {
    const containers = document.querySelectorAll('.ReactVirtualized__Grid__innerScrollContainer');
    return containers.length > 0 ? containers[0] : null;
  }

  /**
   * 确保文字记录区域在视口中可见
   * 虚拟列表（ReactVirtualized）只在可见时渲染内容
   * 必须先滚动页面到该区域，否则容器为空
   */
  async _ensureTranscriptVisible() {
    // 查找"文字记录"标签元素并滚动到视口
    const labels = document.querySelectorAll('div, span, h3');
    for (const el of labels) {
      if (el.textContent.trim() === '文字记录' && el.getBoundingClientRect().width > 0) {
        el.scrollIntoView({ behavior: 'auto', block: 'center' });
        // 等待虚拟列表渲染
        await this._sleep(800);
        return true;
      }
    }

    // 降级：直接查找虚拟列表容器
    const grid = document.querySelector('.ReactVirtualized__Grid.ReactVirtualized__List');
    if (grid) {
      grid.scrollIntoView({ behavior: 'auto', block: 'center' });
      await this._sleep(500);
      return true;
    }

    return false;
  }

  /**
   * 确保趋势图表区域在视口中可见
   * ECharts 图表容器需要在视口内才能正确渲染和提取数据
   */
  async _ensureTrendVisible() {
    // 优先找趋势 tab 容器并滚动
    const tabContainer = document.querySelector('.webcast-data-browser-component-scene-anchor-web-line-tab');
    if (tabContainer) {
      tabContainer.scrollIntoView({ behavior: 'auto', block: 'center' });
      await this._sleep(800);
      return true;
    }

    // 降级：找 ECharts 容器
    const chart = document.querySelector('.echarts-for-react');
    if (chart) {
      chart.scrollIntoView({ behavior: 'auto', block: 'center' });
      await this._sleep(500);
      return true;
    }

    return false;
  }

  // ─── 时间戳工具 ───

  /** 提取分钟标识 "2026-02-05 16:02:56" → "2026-02-05 16:02" */
  _getMinuteKey(timeStr) {
    if (!timeStr) return '';
    return timeStr.substring(0, 16);
  }

  /** 从一行文字记录 DOM 节点中提取时间戳 */
  _extractTimeFromRow(row) {
    const infoDiv = row.querySelector('.shrink.grow.pl-2, [class*="shrink"][class*="grow"][class*="pl-2"]');
    if (!infoDiv) return '';
    const headerRow = infoDiv.querySelector('.flex.items-center, [class*="flex"][class*="items-center"]');
    if (!headerRow) return '';
    const timeEl = headerRow.querySelector('.pl-2, [class*="pl-2"]');
    return timeEl ? timeEl.textContent.trim() : '';
  }

  /**
   * 从页面 DOM 提取时间信息
   */
  _getTimeByLabel(labelKeyword) {
    const timeEls = document.querySelectorAll('.basic-time');
    for (const el of timeEls) {
      const label = el.querySelector('.basic-time-label')?.textContent || '';
      if (label.includes(labelKeyword)) {
        return el.querySelector('.basic-time-value')?.textContent?.trim() || '';
      }
    }
    return '';
  }

  _getStartTime() { return this._getTimeByLabel('开播时间'); }
  _getEndTime() { return this._getTimeByLabel('关播时间'); }

  /**
   * 基于时间范围计算采集进度百分比
   * （当前采集到的最新时间 - 开播时间）/（关播时间 - 开播时间）× 100
   * 无法计算时返回 null，由调用方降级到滚动百分比
   */
  _calcTimeProgress(dataMap) {
    const startTime = this._getStartTime();
    const endTime = this._getEndTime();
    if (!startTime || !endTime) return null;

    const startHHMM = this._extractHHMM(startTime);
    const endHHMM = this._extractHHMM(endTime);
    if (!startHHMM || !endHHMM) return null;

    // 找最新时间
    let latestTime = '';
    for (const item of dataMap.values()) {
      if (item.time && item.time > latestTime) latestTime = item.time;
    }
    if (!latestTime) return 0;

    const currentHHMM = this._extractHHMM(latestTime);
    if (!currentHHMM) return 0;

    const [sh, sm] = startHHMM.split(':').map(Number);
    const [eh, em] = endHHMM.split(':').map(Number);
    const [ch, cm] = currentHHMM.split(':').map(Number);

    const totalMin = (eh * 60 + em) - (sh * 60 + sm);
    const doneMin = (ch * 60 + cm) - (sh * 60 + sm);
    if (totalMin <= 0) return 100;

    return Math.min(100, Math.max(0, Math.round(doneMin / totalMin * 100)));
  }

  /**
   * 判断最后采集的时间戳是否已达到或超过关播时间
   * 对比分钟级别，容差 1 分钟
   */
  _hasReachedEnd(dataMap) {
    const endTime = this._getEndTime();
    if (!endTime) return false; // 没找到关播时间，回退到旧逻辑

    // 找到已采集数据中最晚的时间戳
    let latestTime = '';
    for (const item of dataMap.values()) {
      if (item.time && item.time > latestTime) latestTime = item.time;
    }
    if (!latestTime) return false;

    const lastHHMM = this._extractHHMM(latestTime);
    const endHHMM = this._extractHHMM(endTime);
    if (!lastHHMM || !endHHMM) return false;

    // 最后采集的分钟 >= 关播时间的前一分钟就算采集完成
    return lastHHMM >= endHHMM || this._minuteDiff(lastHHMM, endHHMM) <= 1;
  }

  /**
   * 从各种时间格式中提取 HH:MM
   * 兼容 "2026-02-05 16:02:56"、"16:02:56"、"16:02" 等
   */
  _extractHHMM(timeStr) {
    if (!timeStr) return '';
    // 匹配 HH:MM 模式（可能在任意位置）
    const match = timeStr.match(/(\d{1,2}:\d{2})/);
    return match ? match[1].padStart(5, '0') : '';
  }

  /** 计算两个 HH:MM 之间的分钟差 */
  _minuteDiff(hhmm1, hhmm2) {
    const [h1, m1] = hhmm1.split(':').map(Number);
    const [h2, m2] = hhmm2.split(':').map(Number);
    if (isNaN(h1) || isNaN(m1) || isNaN(h2) || isNaN(m2)) return Infinity;
    return Math.abs((h2 * 60 + m2) - (h1 * 60 + m1));
  }

  /** 从完整时间戳计算两个时间之间的分钟跨度 */
  _minuteDiffAbs(time1, time2) {
    if (!time1 || !time2) return 0;
    const hhmm1 = this._extractHHMM(time1);
    const hhmm2 = this._extractHHMM(time2);
    if (!hhmm1 || !hhmm2) return 0;
    return this._minuteDiff(hhmm1, hhmm2);
  }

  // ─── 解析节点 ───

  _parseTranscriptNodes() {
    const items = [];
    const container = this._getTranscriptInner();
    if (!container) return items;

    for (const row of container.children) {
      try {
        const infoDiv = row.querySelector('.shrink.grow.pl-2, [class*="shrink"][class*="grow"][class*="pl-2"]');
        if (!infoDiv) continue;
        const headerRow = infoDiv.querySelector('.flex.items-center, [class*="flex"][class*="items-center"]');
        if (!headerRow) continue;

        // 发言人
        let speaker = '';
        for (const node of headerRow.childNodes) {
          if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
            speaker = node.textContent.trim();
            break;
          }
          if (node.nodeType === Node.ELEMENT_NODE && !node.classList.contains('pl-2') && !node.querySelector('.pl-2')) {
            const text = node.textContent.trim();
            if (text && !text.match(/^\d{4}-\d{2}-\d{2}/)) {
              speaker = text;
              break;
            }
          }
        }

        // 时间戳
        const timeEl = headerRow.querySelector('.pl-2, [class*="pl-2"]');
        const time = timeEl ? timeEl.textContent.trim() : '';

        // 内容
        let content = '';
        const children = Array.from(infoDiv.children);
        for (let i = 0; i < children.length; i++) {
          if (children[i] === headerRow || children[i].contains(headerRow)) {
            if (i + 1 < children.length) content = children[i + 1].textContent.trim();
            break;
          }
        }

        if (content) items.push({ speaker, time, content });
      } catch (e) {
        console.warn('[抖音提取] 解析文字记录节点出错:', e);
      }
    }
    return items;
  }

  _parseCommentNodes() {
    const items = [];
    const containers = document.querySelectorAll('.ReactVirtualized__Grid__innerScrollContainer');
    const commentContainer = containers.length > 1 ? containers[1] : null;
    const searchRoot = commentContainer || document;
    const comments = searchRoot.querySelectorAll('.webcast-data-browser-component-base-live-comment-gift');
    for (const comment of comments) {
      try {
        const nameEl = comment.querySelector('.webcast-data-browser-component-base-live-comment-gift-base-info-name');
        const contentEl = comment.querySelector('.webcast-data-browser-component-base-live-comment-gift-base-info-content');
        const timeEl = comment.querySelector('.webcast-data-browser-component-base-live-comment-gift-time');
        const speaker = nameEl ? nameEl.textContent.trim() : '';
        const content = contentEl ? contentEl.textContent.trim() : '';
        const time = timeEl ? timeEl.textContent.trim() : '';
        if (content) items.push({ speaker, time, content });
      } catch (e) {
        console.warn('[抖音提取] 解析评论节点出错:', e);
      }
    }
    return items;
  }

  // ─── Tab 切换 ───

  _ensureCommentTabActive() {
    const tabs = document.querySelectorAll('.semi-tabs-tab');
    for (const tab of tabs) {
      if (tab.textContent.trim().includes('直播间评论')) {
        if (!tab.classList.contains('semi-tabs-tab-active')) tab.click();
        return true;
      }
    }
    return false;
  }

  // ─── 评论面板采集 ───

  /**
   * 快速采集当前评论面板的所有评论
   * 用条件触发滚动，不做固定等待
   */
  async _collectAllCommentsInPanel() {
    const commentContainer = this._findCommentScrollContainer();
    if (!commentContainer) return [];

    const allComments = new Map();
    this._scrollToTop(commentContainer);

    // 先采集当前可视的
    for (const item of this._parseCommentNodes()) {
      allComments.set(this._getDedupeKey(item), item);
    }

    // 如果评论面板不需要滚动（内容少），直接返回
    if (commentContainer.scrollHeight <= commentContainer.clientHeight + 5) {
      return Array.from(allComments.values());
    }

    // 需要滚动时，用 70% 页高步长，确保重叠不漏
    while (!this._stopRequested) {
      const prevSize = allComments.size;
      this._simulateScroll(commentContainer, Math.floor(commentContainer.clientHeight * 0.7));
      await this._waitForDOMUpdate(commentContainer, 500);

      for (const item of this._parseCommentNodes()) {
        allComments.set(this._getDedupeKey(item), item);
      }

      const isAtBottom = commentContainer.scrollTop + commentContainer.clientHeight >= commentContainer.scrollHeight - 5;
      if (isAtBottom || allComments.size === prevSize) break;
    }

    return Array.from(allComments.values());
  }

  // ─── 核心入口 ───

  async startScraping(type, onProgress) {
    if (this.isRunning) {
      console.warn('[抖音提取] 已有采集任务在运行');
      return null;
    }

    this.isRunning = true;
    this._stopRequested = false;

    let result;
    if (type === 'transcript') {
      result = await this._scrapeTranscript(onProgress);
    } else if (type === 'comment') {
      result = await this._scrapeComments(onProgress);
    } else if (type === 'all') {
      result = await this._scrapeAll(onProgress);
    } else if (type === 'trend') {
      result = await this._scrapeTrend(onProgress);
    }

    this.isRunning = false;
    return result;
  }

  // ─── 文字记录采集 ───

  /**
   * 滚动虚拟列表，条件触发下一步
   * 每次滚动后等 DOM 更新而非固定等待
   */
  async _scrapeTranscript(onProgress) {
    const dataMap = this.transcriptData;

    // 先滚动页面到文字记录区域，确保虚拟列表渲染
    onProgress && onProgress(0, 0, 'scrolling', '正在定位文字记录区域...');
    await this._ensureTranscriptVisible();

    const container = this._findTranscriptScrollContainer();

    if (!container) {
      onProgress && onProgress(0, 0, 'error', '未找到文字记录区域，请确保页面已加载完成');
      return dataMap;
    }

    onProgress && onProgress(dataMap.size, 0, 'scrolling', '正在采集文字记录...');
    this._scrollToTop(container);
    await this._waitForDOMUpdate(container, 500);

    let noNewDataCount = 0;
    let prevScrollHeight = 0;

    while (!this._stopRequested) {
      const items = this._parseTranscriptNodes();
      let newCount = 0;
      for (const item of items) {
        const key = this._getDedupeKey(item);
        if (!dataMap.has(key)) {
          dataMap.set(key, item);
          newCount++;
        }
      }

      // 优先用时间进度，无法计算时降级到滚动百分比
      const timePercent = this._calcTimeProgress(dataMap);
      const scrollPercent = container.scrollHeight > container.clientHeight
        ? Math.min(100, Math.round((container.scrollTop + container.clientHeight) / container.scrollHeight * 100))
        : 100;
      const percent = timePercent !== null ? timePercent : scrollPercent;

      // 显示当前采集进度和时间范围
      let latestTime = '';
      for (const item of dataMap.values()) {
        if (item.time && item.time > latestTime) latestTime = item.time;
      }
      const endTime = this._getEndTime();
      const timeInfo = latestTime ? ` | ${this._extractHHMM(latestTime)}` + (endTime ? `→${this._extractHHMM(endTime)}` : '') : '';
      onProgress && onProgress(dataMap.size, percent, 'scrolling', `已采集 ${dataMap.size} 条${timeInfo}`);

      const isAtBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 5;
      if (newCount === 0) { noNewDataCount++; } else { noNewDataCount = 0; }

      if (isAtBottom && noNewDataCount >= 2) {
        // 时间判据：如果最后一条记录已接近关播时间，确认采集完成
        if (this._hasReachedEnd(dataMap)) break;

        // ── 到底但时间未到：积极重试 ──
        // 策略：点击最后一行 + 回滚重滚，强制虚拟列表加载更多数据
        let retrySuccess = false;
        const maxRetries = 10;

        for (let retry = 0; retry < maxRetries && !this._stopRequested; retry++) {
          onProgress && onProgress(dataMap.size, percent, 'scrolling',
            `等待加载更多数据... (${retry + 1}/${maxRetries})`);

          // 策略 1：点击最后一条可见记录，迫使列表加载后续内容
          const inner = this._getTranscriptInner();
          if (inner && inner.lastElementChild) {
            const clickTarget = inner.lastElementChild.querySelector('.flex.cursor-pointer') || inner.lastElementChild;
            clickTarget.click();
            await this._sleep(800);
          }

          // 策略 2：用 wheel 事件回滚再滚到底，模拟真实用户操作
          this._simulateScroll(container, -container.clientHeight);
          await this._sleep(500);
          this._scrollToBottom(container);
          await this._waitForDOMUpdate(container, 2000);

          // 检查是否有新数据
          const retryItems = this._parseTranscriptNodes();
          let retryNewCount = 0;
          for (const item of retryItems) {
            const key = this._getDedupeKey(item);
            if (!dataMap.has(key)) {
              dataMap.set(key, item);
              retryNewCount++;
            }
          }

          if (retryNewCount > 0 || container.scrollHeight > prevScrollHeight) {
            retrySuccess = true;
            prevScrollHeight = container.scrollHeight;
            noNewDataCount = 0;
            break;
          }

          // 再检查一次时间判据
          if (this._hasReachedEnd(dataMap)) break;
        }

        if (!retrySuccess) break; // 重试耗尽仍无新数据，确认到底
        continue;
      }

      prevScrollHeight = container.scrollHeight;

      // 70% 页高步长 + 模拟真实滚轮滚动 + 条件等待 DOM 渲染
      this._simulateScroll(container, Math.floor(container.clientHeight * 0.7));
      await this._waitForDOMUpdate(container, 300);
    }

    const finalStatus = this._stopRequested ? 'stopped' : 'done';
    onProgress && onProgress(dataMap.size, 100, finalStatus,
      `${finalStatus === 'stopped' ? '已停止' : '采集完成'}，共 ${dataMap.size} 条`);
    return dataMap;
  }

  // ─── 一键全部采集（点击驱动） ───

  /**
   * 点击驱动同时采集文字记录 + 评论
   *
   * 核心发现：点击任意一条文字记录，页面会自动将其跳到视口中间，
   * 同时加载其上下的文字记录行。所以不需要手动滚动，只需要：
   *   1. 找到当前视口中下一个未处理的分钟行
   *   2. 点击 → 页面自动跳转 → 加载新行 → 采集文字记录 + 评论
   *   3. 重复直到所有分钟处理完毕
   */
  async _scrapeAll(onProgress) {
    const transcriptMap = this.transcriptData;
    const commentMap = this.commentData;

    // 先滚动页面到文字记录区域，确保虚拟列表渲染
    onProgress && onProgress(0, 0, 'scrolling', '正在定位文字记录区域...');
    await this._ensureTranscriptVisible();

    const container = this._findTranscriptScrollContainer();

    if (!container) {
      onProgress && onProgress(0, 0, 'error', '未找到文字记录区域，请确保页面已加载完成');
      return { transcript: transcriptMap, comment: commentMap };
    }

    // 确保评论 Tab 已激活
    this._ensureCommentTabActive();
    await this._sleep(100);

    onProgress && onProgress(0, 0, 'scrolling', '正在采集...');
    this._scrollToTop(container);
    await this._waitForDOMUpdate(container, 500);

    const processedMinutes = new Set();
    let noNewDataCount = 0;
    let prevScrollHeight = 0;

    while (!this._stopRequested) {
      // ── 步骤 1：采集当前视口中所有可见的文字记录 ──
      const items = this._parseTranscriptNodes();
      for (const item of items) {
        const key = this._getDedupeKey(item);
        if (!transcriptMap.has(key)) transcriptMap.set(key, item);
      }

      // ── 步骤 2：在当前视口中找到下一个未处理的分钟行 ──
      const inner = this._getTranscriptInner();
      let nextRow = null;
      let nextMinuteKey = null;

      if (inner) {
        for (const row of inner.children) {
          const time = this._extractTimeFromRow(row);
          const minuteKey = this._getMinuteKey(time);
          if (minuteKey && !processedMinutes.has(minuteKey)) {
            nextRow = row;
            nextMinuteKey = minuteKey;
            break;
          }
        }
      }

      // ── 有未处理的分钟：点击 + 采集评论 ──
      if (nextRow) {
        noNewDataCount = 0;
        processedMinutes.add(nextMinuteKey);

        const clickTarget = nextRow.querySelector('.flex.cursor-pointer') || nextRow;
        clickTarget.click();

        // 先将评论面板滚到底部（新评论追加在底部，需滚动才能触发加载）
        const commentContainer = this._findCommentScrollContainer();
        if (commentContainer) {
          this._scrollToBottom(commentContainer);
          await this._waitForDOMUpdate(commentContainer, 300);
        }

        // 等待评论面板响应（DOM observer，变化即返回）
        await this._waitForCommentChange(commentContainer, 1500);

        if (!this._isCommentEmpty()) {
          // 等评论稳定（200ms 无变化即判定，毫秒级响应）
          await this._waitForCommentReady(200);
          const comments = await this._collectAllCommentsInPanel();
          for (const comment of comments) {
            const key = this._getDedupeKey(comment);
            if (!commentMap.has(key)) commentMap.set(key, comment);
          }
        }

        // 点击后重新采集新出现的文字记录
        for (const item of this._parseTranscriptNodes()) {
          const key = this._getDedupeKey(item);
          if (!transcriptMap.has(key)) transcriptMap.set(key, item);
        }

        // ── 进度显示（映射到 0~90%） ──
        const timePercent = this._calcTimeProgress(transcriptMap);
        const rawPercent = timePercent !== null ? timePercent : 0;
        const percent = Math.round(rawPercent * 0.9);
        let latestTime = '';
        let earliestTime = '';
        for (const item of transcriptMap.values()) {
          if (item.time) {
            if (item.time > latestTime) latestTime = item.time;
            if (!earliestTime || item.time < earliestTime) earliestTime = item.time;
          }
        }
        const endTime = this._getEndTime();
        const timeInfo = latestTime
          ? ` | ${this._extractHHMM(latestTime)}` + (endTime ? `→${this._extractHHMM(endTime)}` : '')
          : '';
        const coveredMin = this._minuteDiffAbs(earliestTime, latestTime);
        onProgress && onProgress(
          transcriptMap.size + commentMap.size, percent, 'scrolling',
          `文字 ${transcriptMap.size} + 评论 ${commentMap.size}${timeInfo} (${coveredMin}分钟)`
        );

        // 不主动滚动，在当前视口继续找下一个未处理分钟
        continue;
      }

      // ── 当前视口无未处理分钟 → 显式滚动前进 ──
      noNewDataCount++;

      const isAtBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 5;

      if (isAtBottom) {
        // 已到底：判断是否真正采集完毕
        if (this._hasReachedEnd(transcriptMap)) break;

        // 到底但时间未到：回弹重滚，迫使虚拟列表加载更多
        let retryOk = false;
        for (let r = 0; r < 10 && !this._stopRequested; r++) {
          onProgress && onProgress(
            transcriptMap.size + commentMap.size,
            Math.round((this._calcTimeProgress(transcriptMap) || 0) * 0.9),
            'scrolling',
            `等待加载更多数据... (${r + 1}/10)`
          );

          // 点击最后一行 + 回弹重滚
          if (inner && inner.lastElementChild) {
            const ct = inner.lastElementChild.querySelector('.flex.cursor-pointer') || inner.lastElementChild;
            ct.click();
            await this._sleep(500);
          }
          this._simulateScroll(container, -container.clientHeight);
          await this._sleep(300);
          this._scrollToBottom(container);
          await this._waitForDOMUpdate(container, 1500);

          let rNew = 0;
          for (const item of this._parseTranscriptNodes()) {
            const key = this._getDedupeKey(item);
            if (!transcriptMap.has(key)) { transcriptMap.set(key, item); rNew++; }
          }

          if (rNew > 0 || container.scrollHeight > prevScrollHeight) {
            retryOk = true;
            prevScrollHeight = container.scrollHeight;
            noNewDataCount = 0;
            break;
          }
          if (this._hasReachedEnd(transcriptMap)) break;
        }
        if (!retryOk) break;
        continue;
      }

      // ── 未到底，继续往下滚动 ──
      prevScrollHeight = container.scrollHeight;
      this._simulateScroll(container, Math.floor(container.clientHeight * 0.7));
      await this._waitForDOMUpdate(container, 300);
    }

    // ── 趋势数据采集 ──
    if (!this._stopRequested) {
      onProgress && onProgress(
        transcriptMap.size + commentMap.size, 90, 'scrolling',
        `文字+评论采集完成，正在采集趋势数据...`
      );
      await this._scrapeTrend((count, percent, status, message) => {
        const overallPercent = 90 + Math.round(percent * 0.1);
        onProgress && onProgress(count, overallPercent, status, message);
      });
    }

    const trendCount = Object.keys(this.trendData).length;
    let finalEarliest = '';
    let finalLatest = '';
    for (const item of transcriptMap.values()) {
      if (item.time) {
        if (item.time > finalLatest) finalLatest = item.time;
        if (!finalEarliest || item.time < finalEarliest) finalEarliest = item.time;
      }
    }
    const finalCoveredMin = this._minuteDiffAbs(finalEarliest, finalLatest);
    const finalStatus = this._stopRequested ? 'stopped' : 'done';
    onProgress && onProgress(
      transcriptMap.size + commentMap.size, 100, finalStatus,
      `${finalStatus === 'stopped' ? '已停止' : '采集完成'}，文字 ${transcriptMap.size} + 评论 ${commentMap.size} + 趋势 ${trendCount}类 (${finalCoveredMin}分钟)`
    );
    return { transcript: transcriptMap, comment: commentMap };
  }

  // ─── 评论采集（并行流水线） ───

  /**
   * 并行评论采集：
   *
   * 核心思路：滚动文字记录和等待评论加载 **并行执行**
   *
   *   串行（旧）:  [点击] → [等评论加载] → [采集评论] → [滚动文字记录] → [等渲染] → [扫描] ...
   *   并行（新）:  [点击] → [等评论加载 ‖ 滚动+扫描下一分钟] → [采集评论] → [立刻点击下一个] ...
   *
   * 约束：评论面板同一时间只能显示一个分钟的评论，
   * 所以必须在点击下一个分钟之前采集完当前分钟的评论。
   * 但在等待评论加载的 I/O 时间内，可以同步预滚动文字记录。
   */
  async _scrapeComments(onProgress) {
    const dataMap = this.commentData;

    // 先滚动页面到文字记录区域，确保虚拟列表渲染
    onProgress && onProgress(0, 0, 'scrolling', '正在定位文字记录区域...');
    await this._ensureTranscriptVisible();

    const transcriptContainer = this._findTranscriptScrollContainer();

    if (!transcriptContainer) {
      onProgress && onProgress(0, 0, 'error', '未找到文字记录区域，无法采集评论');
      return dataMap;
    }

    this._ensureCommentTabActive();
    await this._sleep(200);

    onProgress && onProgress(dataMap.size, 0, 'scrolling', '正在准备采集评论...');

    // 滚到文字记录顶部
    this._scrollToTop(transcriptContainer);
    await this._waitForDOMUpdate(transcriptContainer, 500);

    const processedMinutes = new Set();
    const scrollStep = Math.floor(transcriptContainer.clientHeight * 0.7);
    let noNewDataCount = 0;
    let lastScrollTop = -1;
    let prevScrollHeight = 0;

    /**
     * 从当前可视行中找到第一个未处理分钟的行
     * 返回 { row, minuteKey } 或 null
     */
    const findNextNewMinuteRow = () => {
      const transcriptInner = this._getTranscriptInner();
      if (!transcriptInner) return null;
      for (const row of transcriptInner.children) {
        const time = this._extractTimeFromRow(row);
        const minuteKey = this._getMinuteKey(time);
        if (minuteKey && !processedMinutes.has(minuteKey)) {
          return { row, minuteKey };
        }
      }
      return null;
    };

    /**
     * 预滚动：在等待评论加载期间提前滚动文字记录
     * 不阻塞主流程，返回 Promise
     */
    const scrollTranscriptAhead = () => {
      this._simulateScroll(transcriptContainer, scrollStep);
      return this._waitForDOMUpdate(transcriptContainer, 300);
    };

    while (!this._stopRequested) {
      // 1) 在当前可视行中寻找下一个未处理分钟
      let target = findNextNewMinuteRow();

      // 如果当前视口没有新分钟 → 滚动加载更多
      if (!target) {
        const isAtBottom = transcriptContainer.scrollTop + transcriptContainer.clientHeight >= transcriptContainer.scrollHeight - 5;
        if (transcriptContainer.scrollTop === lastScrollTop) { noNewDataCount++; } else { noNewDataCount = 0; }
        lastScrollTop = transcriptContainer.scrollTop;

        if (isAtBottom && noNewDataCount >= 2) {
          // 时间判据：检查评论是否已覆盖到关播时间
          if (this._hasReachedEnd(dataMap)) break;

          // ── 到底但时间未到：点击最后一行 + 回滚重滚 ──
          let retrySuccess = false;
          for (let retry = 0; retry < 10 && !this._stopRequested; retry++) {
            const inner = this._getTranscriptInner();
            if (inner && inner.lastElementChild) {
              const clickTarget = inner.lastElementChild.querySelector('.flex.cursor-pointer') || inner.lastElementChild;
              clickTarget.click();
              await this._sleep(800);
            }

            this._simulateScroll(transcriptContainer, -transcriptContainer.clientHeight);
            await this._sleep(500);
            this._scrollToBottom(transcriptContainer);
            await this._waitForDOMUpdate(transcriptContainer, 2000);

            // 检查是否有新的未处理分钟
            if (findNextNewMinuteRow() || transcriptContainer.scrollHeight > prevScrollHeight) {
              retrySuccess = true;
              prevScrollHeight = transcriptContainer.scrollHeight;
              noNewDataCount = 0;
              break;
            }
            if (this._hasReachedEnd(dataMap)) break;
          }

          if (!retrySuccess) break;
          continue;
        }

        prevScrollHeight = transcriptContainer.scrollHeight;
        await scrollTranscriptAhead();
        continue;
      }

      noNewDataCount = 0;
      lastScrollTop = transcriptContainer.scrollTop;
      processedMinutes.add(target.minuteKey);

      // 2) 点击该行，触发评论加载
      const commentContainer = this._findCommentScrollContainer();
      const clickTarget = target.row.querySelector('.flex.cursor-pointer') || target.row;
      clickTarget.click();

      // 3) ⚡ 并行：等待评论加载 + 预滚动文字记录 同时进行
      await Promise.all([
        this._waitForCommentChange(commentContainer, 1500),
        scrollTranscriptAhead()
      ]);

      // 4) 评论已就绪，立刻采集
      const comments = await this._collectAllCommentsInPanel();
      for (const comment of comments) {
        const key = this._getDedupeKey(comment);
        if (!dataMap.has(key)) dataMap.set(key, comment);
      }

      // 5) 更新进度 — 优先用时间进度
      const timePercent = this._calcTimeProgress(dataMap);
      const scrollPercent = transcriptContainer.scrollHeight > transcriptContainer.clientHeight
        ? Math.min(100, Math.round((transcriptContainer.scrollTop + transcriptContainer.clientHeight) / transcriptContainer.scrollHeight * 100))
        : 100;
      const percent = timePercent !== null ? timePercent : scrollPercent;
      onProgress && onProgress(dataMap.size, percent, 'scrolling',
        `已采集 ${dataMap.size} 条评论 | 已处理 ${processedMinutes.size} 个分钟段`);
    }

    const finalStatus = this._stopRequested ? 'stopped' : 'done';
    onProgress && onProgress(dataMap.size, 100, finalStatus,
      `${finalStatus === 'stopped' ? '已停止' : '采集完成'}，共 ${dataMap.size} 条评论（${processedMinutes.size} 个分钟段）`);
    return dataMap;
  }

  // ─── 控制方法 ───

  stop() {
    this._stopRequested = true;
  }

  clearData(type) {
    if (type === 'transcript') {
      this.transcriptData.clear();
    } else if (type === 'comment') {
      this.commentData.clear();
    } else if (type === 'trend') {
      this.trendData = {};
    } else {
      this.transcriptData.clear();
      this.commentData.clear();
      this.trendData = {};
    }
  }

  getData(type) {
    if (type === 'trend') return this.trendData;
    const map = type === 'transcript' ? this.transcriptData : this.commentData;
    return Array.from(map.values());
  }

  // ─── 趋势数据采集（ECharts API 直连） ───

  /**
   * 通过 postMessage 桥接从 MAIN world 提取 ECharts 图表数据
   * page-bridge.js 运行在页面上下文，可直接访问 echarts.getInstanceByDom().getOption()
   */
  _extractChartViaBridge(tabIndex) {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        window.removeEventListener('message', handler);
        console.warn(`[趋势采集] Tab ${tabIndex}: 桥接超时`);
        resolve(null);
      }, 5000);

      function handler(event) {
        if (event.source !== window) return;
        if (event.data?.type !== 'DEX_CHART_DATA') return;
        if (event.data.tabIndex !== tabIndex) return;

        clearTimeout(timeout);
        window.removeEventListener('message', handler);

        const data = event.data.data;
        if (data?.error) {
          console.warn(`[趋势采集] Tab ${tabIndex}: ${data.error}`);
          resolve(null);
        } else {
          resolve(data);
        }
      }

      window.addEventListener('message', handler);
      window.postMessage({ type: 'DEX_EXTRACT_CHART', tabIndex }, '*');
    });
  }

  /**
   * 采集趋势数据：逐个点击 tab，通过 ECharts API 直接提取数据
   */
  async _scrapeTrend(onProgress) {
    // 先滚动到趋势图表区域，确保 ECharts 容器可见
    onProgress && onProgress(0, 0, 'scrolling', '正在定位趋势数据区域...');
    await this._ensureTrendVisible();

    const tabContainer = document.querySelector('.webcast-data-browser-component-scene-anchor-web-line-tab');
    if (!tabContainer) {
      onProgress && onProgress(0, 0, 'error', '未找到趋势数据区域');
      return this.trendData;
    }

    const tabs = tabContainer.querySelectorAll('.webcast-data-browser-component-scene-anchor-web-line-tab-item');
    const tabCount = tabs.length;

    for (let i = 0; i < tabCount; i++) {
      if (this._stopRequested) break;

      const tab = tabs[i];
      const tabName = tab.querySelector('.text')?.textContent?.trim() || `Tab${i + 1}`;

      onProgress && onProgress(0, Math.round((i / tabCount) * 100), 'scrolling',
        `正在采集趋势：${tabName} (${i + 1}/${tabCount})`);

      // 点击 tab 并等待图表渲染
      tab.click();
      await this._sleep(1500);

      // 通过 MAIN world 桥接直接提取 ECharts 数据
      const chartData = await this._extractChartViaBridge(i);
      if (chartData && chartData.xAxis && chartData.xAxis.length > 0) {
        this.trendData[tabName] = chartData;
        console.log(`[趋势采集] ${tabName}: ${chartData.xAxis.length} 个数据点, ${chartData.series.length} 个指标`);
      }
    }

    // 采集事件数据（关键时刻、互动玩法等）
    onProgress && onProgress(0, 95, 'scrolling', '正在采集事件数据...');
    const eventData = await this._extractEventsViaBridge();
    if (eventData && !eventData.error) {
      this.trendData._events = eventData;
      const eventCount = (eventData.keyPoint?.length || 0) +
        (eventData.interaction?.length || 0);
      console.log(`[趋势采集] 事件数据: ${eventData.keyPoint?.length || 0} 个关键时刻, ${eventData.interaction?.length || 0} 个互动玩法`);
    }

    const tabNames = Object.keys(this.trendData).filter(k => k !== '_events');
    const totalPoints = tabNames.reduce((sum, k) => sum + (this.trendData[k].xAxis?.length || 0), 0);

    onProgress && onProgress(totalPoints, 100, 'done',
      `趋势采集完成：${tabNames.length} 个分类，${totalPoints} 个数据点`);
    return this.trendData;
  }

  /**
   * 通过 postMessage 桥接提取事件数据（关键时刻、互动玩法等）
   */
  _extractEventsViaBridge() {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        window.removeEventListener('message', handler);
        console.warn('[趋势采集] 事件数据桥接超时');
        resolve(null);
      }, 5000);

      function handler(event) {
        if (event.source !== window) return;
        if (event.data?.type !== 'DEX_EVENT_DATA') return;

        clearTimeout(timeout);
        window.removeEventListener('message', handler);
        resolve(event.data.data);
      }

      window.addEventListener('message', handler);
      window.postMessage({ type: 'DEX_EXTRACT_EVENTS' }, '*');
    });
  }
}

// 全局实例
window.__douyinScraper = new Scraper();

