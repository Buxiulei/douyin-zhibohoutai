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



    // ─── 通用背景 + 直播类型背景 ───

    /** 通用业务背景（所有板块共享，不含直播类型描述） */
    static CONTEXT_BASE = `你是一位资深的抖音直播运营分析专家和合规顾问。

业务背景须知：
- 抖音直播的"福袋"功能：主播在直播间发放福袋（普通福袋或钻石福袋），观众需要发送主播指定的口令评论才能参与领取。
- **如何判断是否发了福袋**：趋势数据的「关键事件」部分会记录互动玩法事件。如果存在标签为"福袋"或"钻石福袋"的互动玩法记录（如 "[时间] 互动玩法: 福袋 = 钻石福袋3个"），则说明该时间点发放了福袋。如果整场直播的互动玩法事件中没有任何福袋相关记录，则说明本场直播未使用福袋功能。
- **福袋口令评论的识别**：福袋发放后 1-3 分钟内，评论区会出现大量完全相同的短文本评论（即口令评论）。这些口令评论是正常运营行为，分析评论互动质量时必须识别并单独统计，不应计入有效互动评论。
- **识别口令的方法**：在福袋发放时间点附近，短时间内出现的高频重复评论（同一内容≥5条）即为口令评论。

输出要求：
- 使用 Markdown 格式
- 所有结论必须引用原始数据中的具体话术或数据作为依据
- 优化建议要具体、可直接复用，避免空泛描述
- 语言风格专业但通俗，适合运营团队直接使用`;

    /** 直播类型背景描述 */
    static LIVE_TYPE_CONTEXT = {
        advisory: '- 本直播间的主播持有中国证券业协会颁发的投资顾问（投顾）资格证书，在公域平台直播。',
        fund: '- 本直播间为基金公司（公募/私募基金管理人）官方直播间，主播为持牌基金从业人员，在公域平台进行投资者教育与基金产品介绍直播。'
    };

    /** 根据直播类型获取完整 CONTEXT */
    static getContext(liveType = 'advisory') {
        const typeContext = DoubaoLLM.LIVE_TYPE_CONTEXT[liveType] || DoubaoLLM.LIVE_TYPE_CONTEXT.advisory;
        return DoubaoLLM.CONTEXT_BASE.replace('业务背景须知：', `业务背景须知：\n${typeContext}`);
    }

    // ─── 合规提示词（按直播类型区分） ───

    static COMPLIANCE_PROMPTS = {
        /** 投顾版合规提示词 */
        advisory: `请对本场直播话术进行合规性审查，生成"合规性分析"报告章节。

背景：本直播间主播持有合法投顾资格证，在抖音公域平台直播。根据中国证监会和抖音平台规则，持证投顾可以围绕经济形势、市场变化、经济数据进行宏观层面的专业分析评论，但仍有严格的合规红线。请逐条审查以下五大维度：

一、证券类直播核心红线（最高优先级）：
1. **直播荐个股**：是否在直播中推荐、分析或预测具体个股的买卖价位、未来走势？（含直接点名股票代码/名称，以及通过暗示、谐音、缩写等方式间接推荐个股）
2. **讲解 K 线图**：是否对 K 线图中的具体数值、形态、走势进行讲解分析并据此给出投资建议？
3. **确定性收益承诺**：是否使用"稳赚""必涨""保本保收益""年化收益至少XX%""跟着我操作不会亏"等承诺收益的表述？
4. **诱导跟单/跟买**：是否使用"赶紧上车""今天不买就来不及了""我已经重仓了你们跟上""错过这波就没了"等诱导性话术？
5. **缺少风险提示**：在分析行情或板块时，是否缺少必要的风险提示语？（如"股市有风险，投资需谨慎""以上分析不构成投资建议"等）

二、引流与私域导流检查：
- 是否通过口播、弹幕引导等方式，引导用户添加微信、加入外部群组、点击外部链接等私域导流行为？
- 是否存在引导用户到直播间外进行证券咨询或交易的行为？

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
4. **改进建议小结**：给出 3-5 条可直接落地的合规改进建议`,

        /** 基金版合规提示词 */
        fund: `请对本场直播话术进行合规性审查，生成"合规性分析"报告章节。

背景：本直播间为基金公司（公募/私募基金管理人）官方直播间，主播为持牌基金从业人员，在抖音公域平台进行投资者教育与基金产品介绍直播。根据中国证监会《公开募集证券投资基金销售机构监督管理办法》《基金从业人员执业行为管理办法》和抖音平台规则，请逐条审查以下五大维度：

一、基金销售合规核心红线（最高优先级）：
1. **保本保收益承诺**：是否使用"保本""保收益""稳赚不赔""零风险""年化收益不低于XX%"等承诺性表述？（基金产品不得承诺保本保收益）
2. **夸大历史业绩**：是否片面宣传基金过往业绩？是否缺少"过往业绩不代表未来表现"的必要提示？是否仅展示短期高收益数据而隐瞒长期波动？
3. **诱导申购/定投**：是否使用"赶紧买入""现在不买就亏了""这只基金必涨""抓紧上车"等诱导性话术？
4. **投资者适当性缺失**：介绍基金产品时是否提示产品的风险等级（R1-R5）？是否提醒投资者评估自身风险承受能力？
5. **缺少法定风险提示**：宣传基金产品时是否缺少"基金有风险，投资需谨慎""基金的过往业绩不预示其未来表现"等法定提示语？

二、基金销售适当性与信息披露：
- 介绍具体基金产品时，是否披露基金名称全称、基金代码、基金管理人、托管人？
- 是否正确披露基金的风险等级和投资类型（股票型/混合型/债券型/货币型等）？
- 是否存在将不同风险等级基金混为一谈、模糊风险差异的表述？
- 是否有引导不适当投资者购买高风险产品的行为？

三、引流与私域导流检查：
- 是否通过口播、弹幕引导等方式，引导用户添加微信、加入外部群组进行基金销售？
- 是否存在引导用户到非法定渠道办理基金开户或申购的行为？
- 是否违规承诺通过私域渠道提供专属投资建议或内幕信息？

四、通用话术合规检查：
- **绝对化用语**：是否使用"最好的基金""第一名基金经理""全市场最优"等极限词？
- **虚假/夸大宣传**：是否虚构基金经理资历、夸大管理规模、伪造获奖记录？
- **虚假营销**：是否存在"限时申购""即将关闭"等未经基金公司确认的虚假限时话术？
- **敏感领域越界**：是否涉及个股推荐、期货交易等超出基金从业范围的表述？

五、观众互动合规：
- 当观众在评论区咨询具体基金是否值得买入时，主播是否正确应对？（应提示需根据个人风险承受能力判断，不构成投资建议）
- 当观众咨询个股时，主播是否明确说明基金直播不涉及个股推荐？
- 是否存在主播对观众的投资金额、持仓品种进行具体操作指导的情况？

输出格式要求：
1. 先给出整体合规评级及依据：🟢 低风险 / 🟡 中风险 / 🔴 高风险
2. 按维度分组，对每一条疑似违规话术，严格按以下表格呈现：

| 原始话术 | 违规维度 | 风险等级 | 合规优化建议 |

必须引用主播原话，逐条列出，不可笼统概述。

3. **合规亮点**：列出主播在合规方面做得好的地方（如主动进行风险提示、披露产品风险等级、提醒投资者适当性等）
4. **改进建议小结**：给出 3-5 条可直接落地的合规改进建议`
    };

    // ─── 四大板块提示词（分段生成，并行执行） ───

    /** 板块定义（有序数组） */
    static SECTIONS = [
        {
            key: 'compliance',
            label: '合规性分析',
            description: '检查违规话术，提供原话与优化话术对比',
            // system 提示词在 buildInput 时根据 liveType 动态注入
            system: null
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
- 建议补充哪些用户关心但本场未覆盖的话题

### 4. 内容重复度分析
对主播逐字稿进行话题语义聚类，识别被反复提及的内容模块、观点或论点。

按以下表格输出重复话题统计（仅列出出现 ≥2 次的话题）：

| 话题/内容模块 | 出现次数 | 涵盖时段 | 代表性原话摘录 | 重复类型 |

「重复类型」标注为以下三类之一：
- **主动强调**：有策略的核心观点反复强化，用于加深观众印象
- **无意识重复**：内容冗余，缺乏新增信息量，拖慢直播节奏
- **口头禅式重复**：习惯性的表达方式或填充语，非内容层面的重复

给出整体重复度评估：
- 有策略性内容强化 vs 无效内容冗余的数量对比
- 重复是否影响了直播节奏和观众体验（结合在线人数变化判断）
- 具体建议：哪些重复内容应精简或替换为新素材

### 5. 直播标题质量评估
根据本场直播的实际内容，对直播间标题进行多维度评估。如果数据中未提供直播标题信息，则跳过此节。

评分维度（每项满分 20 分，总分 100 分）：

| 维度 | 得分 | 评价 |
| --- | --- | --- |
| 关键词相关性 | XX/20 | 标题关键词与实际直播内容的匹配程度 |
| 吸引力与悬念感 | XX/20 | 是否能激发用户好奇心和点击欲望 |
| 简洁清晰度 | XX/20 | 字数是否精炼（建议≤20字）、主题是否一目了然 |
| 目标人群契合度 | XX/20 | 标题用词是否能精准触达目标受众群体 |
| 差异化竞争力 | XX/20 | 与同类型直播标题相比是否有辨识度和记忆点 |

- 给出标题总评分（XX/100）和综合评价
- 指出当前标题的优点和不足
- 提供 3 个优化版标题供参考，并逐条说明优化思路（如增加悬念、突出价值、结合热点等）`
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
        },
        {
            key: 'scoring',
            label: '直播质量评分',
            description: '多维度打分，量化直播质量',
            system: `请对本场直播进行多维度质量评分，生成"直播质量评分"报告章节。

你需要从以下 5 个维度对直播质量进行评估，每个维度满分 20 分，总分 100 分。请根据数据给出客观、量化的评分，并附上评分依据。

### 评分维度

#### 1. 互动活跃度（满分 20 分）
评估要素：
- 有效评论密度（排除福袋口令后，每分钟有效评论数）
- 评论内容质量（与直播内容相关的提问/讨论占比 vs 无意义灌水占比）
- 观众参与的多样性（不同用户参与评论的数量）
- 福袋运营分析：
  · 先通过趋势数据的互动玩法事件，判断本场直播是否发放了福袋，发放了几次，分别在什么时间
  · 如果发放了福袋：分析每次发放的时间点、福袋类型和数量，以及该时间段评论区的口令评论数量
  · 如果未发放福袋：明确指出本场直播未使用福袋功能，建议是否应在特定时段增加福袋以提升互动

#### 2. 内容节奏与结构（满分 20 分）
评估要素：
- 内容板块划分是否清晰合理
- 各板块时长分配是否均衡（是否有板块过于冗长或仓促）
- 开场是否快速切入主题（开场 3 分钟内是否建立价值感）
- 收尾是否有总结和预告（是否有效利用了下播前时段）
- 整体节奏是否流畅（话题切换是否自然、有过渡）

#### 3. 话术质量（满分 20 分）
评估要素：
- 专业性：内容表达是否准确专业、有深度
- 钩子话术数量和质量（是否有效设置悬念、引导继续观看）
- 互动引导频率（关注引导、评论引导、预约引导的次数和质量）
- 语言表达的流畅度和感染力
- 风险提示的规范程度

#### 4. 观众留存表现（满分 20 分）
评估要素（基于趋势数据分析）：
- 在线人数曲线整体走势（稳定/上升/下降趋势）
- 峰值在线人数与平均在线人数的比值（比值越小说明留存越稳定）
- 是否存在明显的观众流失节点（在线人数骤降的时段及原因分析）
- 直播后半段相比前半段的留存表现
- 福袋对留存的影响：如果发放了福袋，分析福袋发放前后在线人数的变化（是否有明显拉升、拉升持续多久、福袋结束后是否快速流失）；如果未发放福袋，分析是否有其他互动手段（如红包、投票等）起到了留存效果

#### 5. 评论互动深度分析（满分 20 分）
评估要素：

**A. 评论互动率量化**
- 计算公式：有效评论互动率 = 有效评论数（排除福袋口令后）÷ 平均在线人数 × 100%
- 行业参考基准：健康互动率 ≥ 20%（即每 5 个在线观众产出 1 条有效评论）
- 标注峰值互动时段和低谷互动时段，分析原因（主播话题切换、福袋发放、内容吸引力等）

**B. 评论回复对照分析**
从评论数据中筛选出有价值的用户提问和讨论类评论（排除口令评论、纯灌水、简单表情），逐条对照主播逐字稿（文字记录），分析主播是否在该评论出现后的 1-5 分钟内进行了口头回应。

输出以下表格（至少列出 10 条有代表性的有价值评论）：

| 评论时间 | 用户昵称 | 评论内容 | 评论类型 | 是否回复 | 主播回应内容摘要 | 回复时效 |

- 评论类型分为：专业提问 / 互动讨论 / 求助咨询 / 反馈建议
- 「是否回复」标注为：✅ 已回复 / ❌ 未回复 / ⚠️ 间接涉及
- 「回复时效」标注主播回应与评论之间的时间差

**C. 评论回复率汇总**

| 统计项 | 数值 |
| --- | --- |
| 有效评论总数（排除口令/灌水） | XX 条 |
| 已回复评论数 | XX 条 |
| 未回复评论数 | XX 条 |
| 评论回复率 | XX% |
| 平均回复时效 | 约 XX 分钟 |
| 评论互动率 | XX%（有效评论数÷平均在线人数） |

**D. 未回复重要评论清单**
列出主播未回复的高价值评论（专业提问、真诚求助等），并给出建议回复话术

### 输出格式要求

请按以下格式输出：

#### 📊 总评分：XX / 100 分

| 评分维度 | 得分 | 评级 |
| --- | --- | --- |
| 互动活跃度 | XX/20 | ⭐⭐⭐⭐⭐ |
| 内容节奏与结构 | XX/20 | ⭐⭐⭐⭐ |
| 话术质量 | XX/20 | ⭐⭐⭐⭐ |
| 观众留存表现 | XX/20 | ⭐⭐⭐ |
| 评论互动深度 | XX/20 | ⭐⭐⭐⭐ |

（⭐评级规则：18-20=⭐⭐⭐⭐⭐，15-17=⭐⭐⭐⭐，12-14=⭐⭐⭐，9-11=⭐⭐，0-8=⭐）

然后对每个维度展开详细分析：
1. **评分依据**：引用原始数据中的具体数据/话术作为评分依据
2. **亮点**：该维度做得好的地方
3. **扣分项**：该维度存在的问题
4. **提升建议**：具体可落地的改进方案`
        }
    ];

    // ─── 整体优化点汇总板块（前 4 板块完成后触发） ───

    static SUMMARY_SECTION = {
        key: 'summary',
        label: '整体优化建议',
        description: '综合分析，按重要性排序的优化清单',
        system: `你是一位资深的抖音直播运营总监。现在你已经收到了一份直播的完整分析报告，包括合规性分析、直播框架分析、直播技巧优化和直播质量评分四个板块的详细分析结果。

            请综合以上所有分析内容，生成一份"整体优化建议"汇总报告。

### 要求：

            1. ** 优化点提取与排序 **：从四个分析板块中提取所有优化建议和问题点，按以下优先级排序：
   - 🔴 ** 紧急（P0）**：涉及合规红线、法律风险的问题，必须立即整改
        - 🟠 ** 重要（P1）**：直接影响直播数据和商业表现的问题
        - 🟡 ** 建议（P2）**：有助于提升直播质量但非紧迫的优化项
        - 🟢 ** 锦上添花（P3）**：长期优化方向

2. ** 输出格式 **：

### 📋 整体优化清单（按优先级排序）

| 序号 | 优先级 | 优化项 | 来源板块 | 预期效果 |

        逐条列出，每条包含具体的优化内容描述。

        3. ** Top 3 关键行动 **：从所有优化点中挑选最关键的 3 条，给出详细的执行方案，包括：
        - 具体做什么
        - 怎么做（话术模板、操作步骤）
        - 预期效果

4. ** 本场直播总评 **：用 2 - 3 句话总结本场直播的整体表现，指出最大的亮点和最需要改进的地方。`
    };

    // ─── Prompt 构建 ───

    /**
     * 构建原始数据的文本上下文
     * @param {Object} data - { transcriptData, commentData, trendData }
     * @returns {string} 数据文本
     */
    static _buildDataContext(data) {
        const { transcriptData, commentData, trendData, liveMeta } = data;
        const parts = [];

        // 直播间元数据（标题、主播名等）
        if (liveMeta) {
            parts.push('## 直播间信息\n');
            if (liveMeta.title) parts.push(`- 直播标题: ${liveMeta.title}`);
            if (liveMeta.anchor) parts.push(`- 主播名称: ${liveMeta.anchor}`);
            parts.push('');
        }

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
                const speaker = item.speaker ? ` ${item.speaker}: ` : '';
                parts.push(`${time}${speaker} ${item.content} `);
            }
            parts.push('');
        }

        if (commentData && commentData.length > 0) {
            parts.push('## 评论数据\n');
            for (const item of commentData) {
                const time = item.time ? `[${item.time}]` : '';
                const speaker = item.speaker ? ` ${item.speaker}: ` : '';
                parts.push(`${time}${speaker} ${item.content} `);
            }
            parts.push('');
        }

        return parts.join('\n');
    }

    /**
     * 将采集数据组装为 Responses API 的 input 数组
     * @param {Object} data - { transcriptData, commentData, trendData }
     * @param {string} sectionKey - 板块 key（compliance / framework / technique / scoring / summary）
     * @param {Object} options - { liveType: 'advisory'|'fund', previousResults: {} }
     * @returns {Array} Responses API input 数组
     */
    static buildInput(data, sectionKey, { liveType = 'advisory', previousResults = {} } = {}) {
        // summary 板块：将前 4 个板块的结果作为输入
        if (sectionKey === 'summary') {
            const prevParts = [];
            DoubaoLLM.SECTIONS.forEach((sec, idx) => {
                if (previousResults[sec.key]) {
                    prevParts.push(`# ${idx + 1}. ${sec.label} \n\n${previousResults[sec.key]} `);
                }
            });
            const prevContext = prevParts.join('\n\n---\n\n');
            const summaryPrompt = DoubaoLLM.SUMMARY_SECTION.system;

            return [
                {
                    role: 'system',
                    content: [{ type: 'input_text', text: summaryPrompt }]
                },
                {
                    role: 'user',
                    content: [{ type: 'input_text', text: `以下是本场直播的完整分析报告（共 4 个板块），请综合分析并生成整体优化建议：\n\n${prevContext} ` }]
                }
            ];
        }

        // 常规板块：用采集的原始数据
        const dataContext = DoubaoLLM._buildDataContext(data);

        // 获取板块提示词（compliance 需要根据 liveType 动态选择）
        let sectionPrompt = '';
        if (sectionKey === 'compliance') {
            sectionPrompt = DoubaoLLM.COMPLIANCE_PROMPTS[liveType] || DoubaoLLM.COMPLIANCE_PROMPTS.advisory;
        } else {
            const section = DoubaoLLM.SECTIONS.find(s => s.key === sectionKey);
            sectionPrompt = section ? section.system : '';
        }

        const systemPrompt = DoubaoLLM.getContext(liveType) + '\n\n' + sectionPrompt;

        return [
            {
                role: 'system',
                content: [{ type: 'input_text', text: systemPrompt }]
            },
            {
                role: 'user',
                content: [{ type: 'input_text', text: `以下是本次直播的完整数据，请据此进行分析：\n\n${dataContext} ` }]
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
     * @param {string} sectionKey - 板块 key（compliance / framework / technique / scoring / summary）
     * @param {Function} onChunk - 流式回调 (content: string) => void
     * @param {Function} onDone - 完成回调 () => void
     * @param {Function} onError - 错误回调 (error: string) => void
     * @param {Object} options - { liveType, previousResults }
     */
    static async analyze(data, sectionKey, onChunk, onDone, onError, options = {}) {
        const config = await DoubaoLLM.getConfig();

        if (!config.apiKey || !config.model) {
            onError('请先配置 API Key 和模型名称');
            return;
        }

        const input = DoubaoLLM.buildInput(data, sectionKey, options);
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
                    onChunk(`\n\n > 连接中断，${wait / 1000} 秒后自动重试（第 ${retry + 1}/${MAX_RETRIES} 次）...\n\n`);
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
