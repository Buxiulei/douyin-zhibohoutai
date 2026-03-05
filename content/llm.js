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
- 本直播间的主播持有中国证券业协会颁发的投资顾问（投顾）资格证书，在公域平台直播。
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

背景：本直播间主播持有合法投顾资格证，在抖音公域平台直播。根据中国证监会和抖音平台规则，持证投顾可以围绕经济形势、市场变化、经济数据进行宏观层面的专业分析评论，但仍有严格的合规红线。请逐条审查以下五大维度：

一、证券类直播核心红线（最高优先级）：
1. **直播荐个股**：是否在直播中推荐、分析或预测具体个股的买卖价位、未来走势？（含直接点名股票代码/名称，以及通过暗示、谐音、缩写等方式间接推荐个股）
2. **讲解 K 线图**：是否对 K 线图中的具体数值、形态、走势进行讲解分析并据此给出投资建议？
3. **确定性收益承诺**：是否使用"稳赚""必涨""保本保收益""年化收益至少XX%""跟着我操作不会亏"等承诺收益的表述？
4. **诱导跟单/跟买**：是否使用"赶紧上车""今天不买就来不及了""我已经重仓了你们跟上""错过这波就没了"等诱导性话术？
5. **缺少风险提示**：在分析行情或板块时，是否缺少必要的风险提示语？（如"股市有风险，投资需谨慎""以上分析不构成投资建议"等）

二、引流与私域导流检查：
- 是否通过口播、弹幕引导等方式，引导用户添加微信、加入外部群组、点击外部链接等私域导流行为？
- 是否存在引导用户到直播间外进行株股咨询或交易的行为？

三、通用话术合规检查：
- **绝对化用语**：是否使用"最好""第一""全网最X""国家级""央视推荐"等极限词？（须有官方认证文件支撑）
- **虚假/夸大宣传**：是否夸大产品功效、虚构资历或战绩？
- **虚假营销**：是否存在"最后一天特价""马上恢复原价""再不抢就没了"等未明确活动时间的虚假限时话术？
- **敏感领域越界**：是否涉及医疗、教育等非持牌领域的承诺性表述？

四、主播形象与信息披露：
- 是否存在营造"股神""常胜将军"等虚假人设的表述？（如"我推荐的票从来没亏过""跟着我的都赚了"）
- 直播间是否按规范展示主播真实姓名、从业编号、所属公司信息？（此项基于话术内容判断，如话术中提及则检查；如话术无法判断则标注"无法确认"）

五、观众互动合规：
- 当观众在评论区提及具体个股代码或名称时，主播是否正确应对？（应提醒观众不要在弹幕讨论个股、平台禁止公开荐股）
- 是否存在主播对观众个股提问进行正面回答或暗示的情况？

输出格式要求：
1. 先给出整体合规评级及依据：🟢 低风险 / 🟡 中风险 / 🔴 高风险
2. 按维度分组，对每一条疑似违规话术，严格按以下表格呈现：

| 原始话术 | 违规维度 | 风险等级 | 合规优化建议 |

必须引用主播原话，逐条列出，不可笼统概述。

3. **合规亮点**：列出主播在合规方面做得好的地方（如主动进行风险提示、婉拒观众个股提问、强调"不构成投资建议"等）
4. **改进建议小结**：给出 3-5 条可直接落地的合规改进建议`
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
