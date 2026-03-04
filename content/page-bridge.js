/**
 * 页面桥接脚本 — 运行在 MAIN world（页面上下文）
 * 通过 React Fiber 访问 ECharts 实例 + 事件数据
 * 通过 window.postMessage 与 content script 通信
 */

// ─── 关键时刻字段名 → 中文标签映射 ───
const KEY_POINT_LABELS = {
    commentTop: '评论次数高峰',
    followTop: '新增关注高峰',
    giftTop: '送礼音浪高峰',
    giftUcntTop: '送礼人数高峰',
    watchTop: '在线观众高峰',
    pcuTotalTop: '在线观众高峰',
    enterTop: '进房人次高峰',
    likeTop: '点赞高峰',
    earnScoreTop: '带货口碑分高峰',
    consumeUcntTop: '消费人数高峰',
    payUcntTop: '付费人数高峰',
    shareTop: '分享高峰',
    clubJoinTop: '粉丝团加入高峰'
};

// ─── 互动玩法字段名 → 中文标签映射 ───
const INTERACTION_LABELS = {
    diamondLottery: '钻石福袋',
    lottery: '福袋',
    redPacket: '红包',
    vote: '投票',
    quiz: '竞猜',
    pk: 'PK'
};

window.addEventListener('message', (event) => {
    if (event.source !== window) return;

    if (event.data?.type === 'DEX_EXTRACT_CHART') {
        const tabIndex = event.data.tabIndex || 0;
        const chartResult = extractChartData();
        window.postMessage({ type: 'DEX_CHART_DATA', tabIndex, data: chartResult }, '*');
    }

    if (event.data?.type === 'DEX_EXTRACT_EVENTS') {
        const eventResult = extractEventData();
        window.postMessage({ type: 'DEX_EVENT_DATA', data: eventResult }, '*');
    }
});

// ─── ECharts 图表数据提取 ───

function getEchartsInstanceViaFiber(container) {
    if (!container) return null;
    const fiberKey = Object.keys(container).find(
        k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance')
    );
    if (!fiberKey) return null;
    let fiber = container[fiberKey];
    while (fiber) {
        if (fiber.stateNode && typeof fiber.stateNode.getEchartsInstance === 'function') {
            return fiber.stateNode.getEchartsInstance();
        }
        fiber = fiber.return;
    }
    return null;
}

function extractChartData() {
    try {
        const container = document.querySelector('.echarts-for-react[_echarts_instance_]');
        if (!container) return { error: '未找到 ECharts 图表容器' };

        const instance = getEchartsInstanceViaFiber(container);
        if (!instance) return { error: '无法通过 React Fiber 获取 ECharts 实例' };

        const option = instance.getOption();
        if (!option) return { error: 'getOption 返回 null' };

        return {
            xAxis: option.xAxis?.[0]?.data || [],
            series: (option.series || []).map(s => ({
                name: s.name || '',
                data: (s.data || []).map(d => {
                    if (typeof d === 'object' && d !== null) return d.value ?? d;
                    return d;
                })
            }))
        };
    } catch (err) {
        return { error: err.message };
    }
}

// ─── 事件数据提取 ───

/**
 * eventData 结构要点（通过浏览器实测确认）：
 *   eventData.keyPoint = [16, 17, 21, ...]        ← series 数组的索引
 *   eventData.interaction = [2, 32]                ← series 数组的索引
 *   eventData.interactionIcon = [["lottery"], ...]  ← 互动类型标识
 *
 * series[idx] 是一个对象，包含：
 *   - timeMinute: "2026-02-10 16:03:00"  ← 时间戳
 *   - commentTop: "39"                   ← 关键时刻字段（以 Top 结尾）
 *   - diamondLottery: "30钻/3个"           ← 互动玩法字段
 *   - lottery: "钻石福袋3个"                ← 互动玩法字段
 */
function extractEventData() {
    try {
        // 找到包含 eventData 的 React Fiber 节点
        const container = document.querySelector('.review-page-container');
        if (!container) return { error: '未找到 review-page-container' };

        let targetProps = null;
        const allElements = container.querySelectorAll('*');
        for (const el of allElements) {
            const fiberKey = Object.keys(el).find(
                k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance')
            );
            if (!fiberKey) continue;
            let fiber = el[fiberKey];
            while (fiber) {
                if (fiber.memoizedProps?.eventData) {
                    targetProps = fiber.memoizedProps;
                    break;
                }
                fiber = fiber.return;
            }
            if (targetProps) break;
        }

        if (!targetProps) return { error: '未在 Fiber 中找到 eventData' };

        const eventData = targetProps.eventData;

        // 从 props 树中查找 series 数据
        const series = findSeries(targetProps);
        if (!series) {
            console.warn('[抖音数据提取] 找到 eventData 但未找到 series 数组');
            return { error: '未找到 series 数据数组' };
        }

        console.log(`[抖音数据提取] series 共 ${series.length} 项`);
        console.log(`[抖音数据提取] keyPoint 索引: [${eventData.keyPoint}]`);
        console.log(`[抖音数据提取] interaction 索引: [${eventData.interaction}]`);

        // ─── 解析关键时刻 ───
        const keyPoints = [];
        for (const idx of (eventData.keyPoint || [])) {
            const item = series[idx];
            if (!item) continue;
            const time = item.timeMinute || '';

            // 查找以 Top 结尾的字段，这些就是关键时刻
            for (const [field, label] of Object.entries(KEY_POINT_LABELS)) {
                if (item[field] !== undefined && item[field] !== null) {
                    keyPoints.push({
                        time,
                        label,
                        value: String(item[field]),
                        field
                    });
                }
            }

            // 如果没有匹配到已知字段，尝试查找所有 *Top 字段
            if (keyPoints.filter(kp => kp.time === time).length === 0) {
                for (const key of Object.keys(item)) {
                    if (key.endsWith('Top') && !key.endsWith('TopRank')) {
                        keyPoints.push({
                            time,
                            label: key,
                            value: String(item[key]),
                            field: key
                        });
                    }
                }
            }
        }

        // ─── 解析互动玩法 ───
        const interactions = [];
        for (let i = 0; i < (eventData.interaction || []).length; i++) {
            const idx = eventData.interaction[i];
            const item = series[idx];
            if (!item) continue;
            const time = item.timeMinute || '';
            const icons = (eventData.interactionIcon || [])[i] || [];

            // 查找互动玩法字段
            for (const [field, label] of Object.entries(INTERACTION_LABELS)) {
                if (item[field] !== undefined && item[field] !== null && String(item[field]).length > 0) {
                    interactions.push({
                        time,
                        label,
                        value: String(item[field]),
                        field,
                        icon: icons[0] || ''
                    });
                }
            }

            // 如果没有匹配到已知字段，dump 所有非通用字段
            if (interactions.filter(ia => ia.time === time).length === 0) {
                const commonFields = new Set(['timeMinute', '_index', 'clientCommentCnt', 'commentCnt', 'commentUcnt',
                    'consumeUcnt', 'earnScore', 'enterCnt', 'followCnt', 'leaveCnt',
                    'likeCnt', 'watchCnt', 'watchUcnt', 'unfollowCnt', 'giftCnt', 'giftUcnt']);
                for (const key of Object.keys(item)) {
                    if (!commonFields.has(key) && !key.endsWith('Top') && !key.endsWith('TopRank')) {
                        const val = item[key];
                        if (val !== undefined && val !== null && String(val).length > 0) {
                            interactions.push({
                                time,
                                label: key,
                                value: String(val),
                                field: key,
                                icon: icons[0] || ''
                            });
                        }
                    }
                }
            }
        }

        console.log(`[抖音数据提取] 解析结果: ${keyPoints.length} 个关键时刻, ${interactions.length} 个互动玩法`);

        return {
            keyPoint: keyPoints,
            interaction: interactions
        };
    } catch (err) {
        console.error('[抖音数据提取] 事件数据提取错误:', err);
        return { error: err.message };
    }
}

/**
 * 在 React props 树中递归查找 series 数组
 */
function findSeries(props, depth = 0) {
    if (!props || typeof props !== 'object' || depth > 8) return null;

    // 直接检查当前对象
    if (Array.isArray(props.series)) return props.series;

    // 遍历 children.props.data 等常见路径
    const checkKeys = ['children', 'props', 'data'];
    for (const key of checkKeys) {
        if (props[key] && typeof props[key] === 'object') {
            const found = findSeries(props[key], depth + 1);
            if (found) return found;
        }
    }

    return null;
}

console.log('[抖音数据提取] 页面桥接脚本已加载（事件数据 v3 - 索引+series 模式）');
