/**
 * LLM 服务模块 — 豆包大模型 Responses API 对接
 *
 * 职责：
 * - API Key / 模型名称的本地持久化存储
 * - 将采集数据 + 预设提示词组装为 prompt
 * - 通过 background worker 代理发送请求
 * - 流式回调输出分析结果
 */

class DoubaoLLM {
    // ─── 配置管理 ───

    /** 保存 API 配置到 chrome.storage.local */
    static async setConfig({ apiKey, model }) {
        return new Promise((resolve) => {
            chrome.storage.local.set({ dex_llm_apiKey: apiKey, dex_llm_model: model }, resolve);
        });
    }

    /** 读取已保存的 API 配置 */
    static async getConfig() {
        return new Promise((resolve) => {
            chrome.storage.local.get(['dex_llm_apiKey', 'dex_llm_model'], (result) => {
                resolve({
                    apiKey: result.dex_llm_apiKey || '',
                    model: result.dex_llm_model || 'doubao-seed-2-0-pro-260215'
                });
            });
        });
    }



    // ─── 三大板块提示词（分段生成，最终汇总） ───

    /** 通用业务背景（所有板块共享） */
    static CONTEXT = `你是一位资深的抖音直播运营分析专家和合规顾问。

业务背景须知：
- 本直播间的主播持有中国证券业协会颁发的投资顾问（投顾）资格证书，具备合法荐股资质。主播在直播中对个股、板块进行分析推荐属于持证合规行为，不应视为违规。
- 抖音直播的"福袋"功能：主播发放福袋后，用户需要发送主播设定好的一句指定评论才能参与领取。因此在福袋发放后，短时间内出现大量完全相同的评论是正常的运营行为，不应视为异常刷屏或无效互动。分析评论时需识别并排除这类福袋口令评论，单独说明福袋互动数据。

输出要求：
- 使用 Markdown 格式
- 所有结论必须引用原始数据中的具体话术或数据作为依据
- 优化建议要具体、可直接复用，避免空泛描述
- 语言风格专业但通俗，适合运营团队直接使用`;

    /** 板块定义（有序数组，按顺序执行） */
    static SECTIONS = [
        {
            key: 'compliance',
            label: '合规性分析',
            description: '检查违规话术，提供原话与优化话术对比',
            system: `请对本场直播话术进行合规性审查，生成"合规性分析"报告章节。

重要前提：本直播间主播持有合法投顾资格证，在直播中对个股、板块进行分析推荐属于持证合规行为，请勿将此类内容标记为违规。

逐条检查主播话术中是否存在以下违规风险：
- 绝对化用语（如"最好""第一""100%有效"等）
- 虚假宣传或夸大功效
- 诱导性话术（如虚假限时、虚假库存紧张）
- 涉及敏感领域的违规表述（医疗/教育相关承诺等，注意：持证荐股不在此列）

输出格式要求：
对每一条违规话术，严格按以下三列表格对比呈现：
| 原始话术 | 优化话术 | 优化理由 |
必须逐条列出，不可笼统概述。如未发现违规话术，需明确说明"本场直播未检测到明显合规风险"。`
        },
        {
            key: 'framework',
            label: '直播框架分析',
            description: '拆解直播结构、热门话题与关联评论',
            system: `请对本场直播进行框架分析，生成"直播框架分析"报告章节。

### 1. 本场直播框架拆解
- 按时间线梳理本场直播的内容结构（开场→各内容板块→收尾），标注每个板块的大致时段
- 评估直播节奏：各板块时长分配是否合理？是否存在拖沓或过于仓促的环节？

### 2. 热门话题分析
- 本场直播涉及了哪些话题/板块？
- 这些话题是否为当前阶段的热点？（结合行业常识判断）
- 从评论数据中提取与直播内容**强相关**的评论，统计数量并列出代表性评论原文
- 总结用户最关心的 Top 3-5 个问题

### 3. 框架优化建议
- 基于数据分析，建议如何优化直播内容框架
- 哪些板块应加强、哪些可精简
- 建议补充哪些用户关心但本场未覆盖的话题`
        },
        {
            key: 'technique',
            label: '直播技巧优化',
            description: '钩子话术、关注引导、预约引导',
            system: `请对本场直播的运营技巧进行分析，生成"直播技巧优化"报告章节。

### 1. 提升用户停留时长
- 分析当前话术中是否已包含有效的"钩子话术"（预告下一个精彩内容、设置悬念、福利预告等）
- 如有，评估其效果；如无或不足，在现有话术基础上**补充至少 3 条钩子话术示例**
- 提供钩子话术的通用模板，并标注适合植入的时间节点

### 2. 提升关注转化
- 评估现有话术中引导关注的内容是否充分
- 在现有话术基础上，**补充至少 3 条高价值的关注引导话术**
- 关注话术需传递明确的"关注价值"（关注后能获得什么），而非单纯请求关注

### 3. 提升预约直播人数
- 分析本场直播是否有预约引导话术及其效果
- **提供至少 3 条预约引导话术示例**，需包含下次直播的价值预告
- 给出预约引导的最佳时机建议（如开场、内容高潮后、下播前）`
        }
    ];

    // ─── Prompt 构建 ───

    /**
     * 将采集数据组装为 Responses API 的 input 数组
     * @param {Object} data - { transcriptData, commentData, trendData }
     * @param {string} sectionKey - 板块 key（compliance / framework / technique）
     * @returns {Array} Responses API input 数组
     */
    static buildInput(data, sectionKey) {
        const { transcriptData, commentData, trendData } = data;

        // 构建数据上下文
        const parts = [];

        if (trendData && Object.keys(trendData).length > 0) {
            parts.push('## 趋势数据\n');
            const tabEntries = Object.entries(trendData).filter(([k]) => k !== '_events');
            const events = trendData._events;

            let xAxis = [];
            for (const [, chart] of tabEntries) {
                if ((chart.xAxis || []).length > xAxis.length) xAxis = chart.xAxis;
            }

            const allSeries = [];
            for (const [, chart] of tabEntries) {
                for (const s of (chart.series || [])) {
                    allSeries.push({ name: s.name || '未知', data: s.data || [] });
                }
            }

            const step = Math.max(1, Math.floor(xAxis.length / 60));
            const headers = ['时间', ...allSeries.map(s => s.name)];
            parts.push('| ' + headers.join(' | ') + ' |');
            parts.push('| ' + headers.map(() => '---').join(' | ') + ' |');

            for (let i = 0; i < xAxis.length; i += step) {
                const t = xAxis[i] || '';
                const row = [t, ...allSeries.map(s => {
                    const val = s.data[i];
                    if (val === undefined || val === null) return '';
                    return Array.isArray(val) ? (val[1] ?? '') : val;
                })];
                parts.push('| ' + row.join(' | ') + ' |');
            }
            parts.push('');

            if (events) {
                const kp = events.keyPoint || [];
                const ia = events.interaction || [];
                if (kp.length > 0 || ia.length > 0) {
                    parts.push('### 关键事件\n');
                    for (const e of kp) {
                        parts.push(`- [${e.time}] 关键时刻: ${e.label} = ${e.value}`);
                    }
                    for (const e of ia) {
                        parts.push(`- [${e.time}] 互动玩法: ${e.label} = ${e.value}`);
                    }
                    parts.push('');
                }
            }
        }

        if (transcriptData && transcriptData.length > 0) {
            parts.push('## 文字记录\n');
            for (const item of transcriptData) {
                const time = item.time ? `[${item.time}]` : '';
                const speaker = item.speaker ? ` ${item.speaker}:` : '';
                parts.push(`${time}${speaker} ${item.content}`);
            }
            parts.push('');
        }

        if (commentData && commentData.length > 0) {
            parts.push('## 评论数据\n');
            for (const item of commentData) {
                const time = item.time ? `[${item.time}]` : '';
                const speaker = item.speaker ? ` ${item.speaker}:` : '';
                parts.push(`${time}${speaker} ${item.content}`);
            }
            parts.push('');
        }

        const dataContext = parts.join('\n');

        // 找到对应板块的提示词
        const section = DoubaoLLM.SECTIONS.find(s => s.key === sectionKey);
        const sectionPrompt = section ? section.system : '';
        const systemPrompt = DoubaoLLM.CONTEXT + '\n\n' + sectionPrompt;

        return [
            {
                role: 'system',
                content: [{ type: 'input_text', text: systemPrompt }]
            },
            {
                role: 'user',
                content: [{ type: 'input_text', text: `以下是本次直播的完整数据，请据此进行分析：\n\n${dataContext}` }]
            }
        ];
    }

    // ─── 分析请求 ───

    /** 活跃的 port 连接（按 sectionKey 索引，支持并行） */
    static _activePorts = new Map();
    /** 被用户主动停止的 sectionKey 集合 */
    static _stoppedKeys = new Set();

    /**
     * 发起 LLM 分析（流式返回，支持并行）
     * @param {Object} data - 采集数据
     * @param {string} sectionKey - 板块 key（compliance / framework / technique）
     * @param {Function} onChunk - 流式回调 (content: string) => void
     * @param {Function} onDone - 完成回调 () => void
     * @param {Function} onError - 错误回调 (error: string) => void
     */
    static async analyze(data, sectionKey, onChunk, onDone, onError) {
        const config = await DoubaoLLM.getConfig();

        if (!config.apiKey || !config.model) {
            onError('请先配置 API Key 和模型名称');
            return;
        }

        const input = DoubaoLLM.buildInput(data, sectionKey);
        const MAX_RETRIES = 3;

        // 单次连接尝试
        function attempt() {
            return new Promise((resolve, reject) => {
                const port = chrome.runtime.connect({ name: 'llm-stream' });
                DoubaoLLM._activePorts.set(sectionKey, port);
                let callbackFired = false;

                port.onMessage.addListener((msg) => {
                    if (callbackFired) return;
                    switch (msg.type) {
                        case 'LLM_CHUNK':
                            onChunk(msg.content);
                            break;
                        case 'LLM_DONE':
                            callbackFired = true;
                            DoubaoLLM._activePorts.delete(sectionKey);
                            port.disconnect();
                            resolve(true);
                            break;
                        case 'LLM_ERROR':
                            callbackFired = true;
                            DoubaoLLM._activePorts.delete(sectionKey);
                            port.disconnect();
                            reject(msg.error);
                            break;
                    }
                });

                port.onDisconnect.addListener(() => {
                    const wasStopped = DoubaoLLM._stoppedKeys.has(sectionKey);
                    DoubaoLLM._activePorts.delete(sectionKey);
                    DoubaoLLM._stoppedKeys.delete(sectionKey);

                    if (callbackFired) return;
                    callbackFired = true;

                    if (wasStopped) {
                        reject('已停止');
                    } else {
                        resolve(false); // 意外断连，可重试
                    }
                });

                port.postMessage({
                    type: 'LLM_REQUEST',
                    apiKey: config.apiKey,
                    model: config.model,
                    input
                });
            });
        }

        // 重试循环
        for (let retry = 0; retry <= MAX_RETRIES; retry++) {
            try {
                const success = await attempt();
                if (success) {
                    onDone();
                    return;
                }
                if (retry < MAX_RETRIES) {
                    const wait = (retry + 1) * 1000;
                    onChunk(`\n\n> 连接中断，${wait / 1000}秒后自动重试（第 ${retry + 1}/${MAX_RETRIES} 次）...\n\n`);
                    await new Promise(r => setTimeout(r, wait));
                    if (DoubaoLLM._stoppedKeys.has(sectionKey)) {
                        DoubaoLLM._stoppedKeys.delete(sectionKey);
                        onError('已停止');
                        return;
                    }
                } else {
                    onError(`连接已断开，重试 ${MAX_RETRIES} 次后仍无法恢复`);
                    return;
                }
            } catch (err) {
                onError(err);
                return;
            }
        }
    }

    /**
     * 中断分析
     * @param {string} [sectionKey] - 指定板块 key，不传则停止全部
     */
    static stop(sectionKey) {
        if (sectionKey) {
            const port = DoubaoLLM._activePorts.get(sectionKey);
            if (port) {
                DoubaoLLM._stoppedKeys.add(sectionKey);
                port.disconnect();
                DoubaoLLM._activePorts.delete(sectionKey);
            }
        } else {
            // 停止全部
            for (const [key, port] of DoubaoLLM._activePorts) {
                DoubaoLLM._stoppedKeys.add(key);
                port.disconnect();
            }
            DoubaoLLM._activePorts.clear();
        }
    }
}

window.__douyinLLM = DoubaoLLM;
