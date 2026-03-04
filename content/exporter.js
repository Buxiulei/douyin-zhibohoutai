/**
 * 数据导出模块 — 格式化并下载采集到的数据
 */
class Exporter {
    static exportPlainText(data, filename) {
        if (!data || data.length === 0) {
            alert('暂无数据可导出');
            return;
        }
        const text = data.map(item => item.content).join('\n\n');
        Exporter._download(text, `${filename}_纯文本.txt`);
    }

    static exportFullRecord(data, filename) {
        if (!data || data.length === 0) {
            alert('暂无数据可导出');
            return;
        }
        const text = data.map(item => {
            const timePart = item.time ? `[${item.time}]` : '';
            const speakerPart = item.speaker ? ` ${item.speaker}:` : '';
            return `${timePart}${speakerPart} ${item.content}`;
        }).join('\n\n');
        Exporter._download(text, `${filename}_完整记录.txt`);
    }

    /**
     * 导出趋势数据为 CSV（所有 tab + 事件合并为一张表）
     */
    static exportTrendCSV(trendData, filename) {
        if (!trendData || Object.keys(trendData).length === 0) {
            alert('暂无趋势数据可导出');
            return;
        }

        const tabEntries = Object.entries(trendData).filter(([k]) => k !== '_events');
        const events = trendData._events;

        let unifiedXAxis = [];
        for (const [, chartData] of tabEntries) {
            if ((chartData.xAxis || []).length > unifiedXAxis.length) {
                unifiedXAxis = chartData.xAxis;
            }
        }

        const allSeries = [];
        for (const [, chartData] of tabEntries) {
            for (const s of (chartData.series || [])) {
                allSeries.push({ header: s.name || '未知指标', data: s.data || [] });
            }
        }

        const { keyPointByTime, interactionByTime } = Exporter._buildEventIndex(events, unifiedXAxis);
        const hasKeyPoint = Object.keys(keyPointByTime).length > 0;
        const hasInteraction = Object.keys(interactionByTime).length > 0;

        const headers = ['时间', ...allSeries.map(s => s.header)];
        if (hasKeyPoint) headers.push('关键时刻');
        if (hasInteraction) headers.push('互动玩法');

        const lines = [headers.join(',')];

        for (let i = 0; i < unifiedXAxis.length; i++) {
            const t = unifiedXAxis[i] || '';
            const row = [
                t,
                ...allSeries.map(s => {
                    const val = s.data[i];
                    if (val === undefined || val === null) return '';
                    return Array.isArray(val) ? (val[1] ?? '') : val;
                })
            ];
            if (hasKeyPoint) {
                row.push(`"${(keyPointByTime[t] || []).join('; ').replace(/"/g, '""')}"`);
            }
            if (hasInteraction) {
                row.push(`"${(interactionByTime[t] || []).join('; ').replace(/"/g, '""')}"`);
            }
            lines.push(row.join(','));
        }

        Exporter._download(lines.join('\n'), `${filename}_趋势数据.csv`);
    }

    /**
     * 导出融合报告（Markdown 结构化文本，适合喂给 LLM 做分析）
     * format: 'md' | 'txt'
     */
    static exportFusion(transcriptData, commentData, trendData, filename, format = 'md') {
        const sections = [];

        sections.push('# 抖音直播数据报告');
        sections.push(`> 导出时间：${new Date().toLocaleString('zh-CN')}`);
        sections.push('');

        if (trendData && Object.keys(trendData).length > 0) {
            sections.push('## 趋势数据');
            sections.push('');

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

            const { keyPointByTime, interactionByTime } = Exporter._buildEventIndex(events, xAxis);
            const hasKP = Object.keys(keyPointByTime).length > 0;
            const hasIA = Object.keys(interactionByTime).length > 0;

            const headers = ['时间', ...allSeries.map(s => s.name)];
            if (hasKP) headers.push('关键时刻');
            if (hasIA) headers.push('互动玩法');

            sections.push('| ' + headers.join(' | ') + ' |');
            sections.push('| ' + headers.map(() => '---').join(' | ') + ' |');

            for (let i = 0; i < xAxis.length; i++) {
                const t = xAxis[i] || '';
                const row = [t, ...allSeries.map(s => {
                    const val = s.data[i];
                    if (val === undefined || val === null) return '';
                    return Array.isArray(val) ? (val[1] ?? '') : val;
                })];
                if (hasKP) row.push((keyPointByTime[t] || []).join('; '));
                if (hasIA) row.push((interactionByTime[t] || []).join('; '));
                sections.push('| ' + row.join(' | ') + ' |');
            }
            sections.push('');
        }

        if (transcriptData && transcriptData.length > 0) {
            sections.push('## 文字记录');
            sections.push('');
            for (const item of transcriptData) {
                const time = item.time ? `[${item.time}]` : '';
                const speaker = item.speaker ? ` **${item.speaker}**:` : '';
                sections.push(`${time}${speaker} ${item.content}`);
                sections.push('');
            }
        }

        if (commentData && commentData.length > 0) {
            sections.push('## 评论');
            sections.push('');
            for (const item of commentData) {
                const time = item.time ? `[${item.time}]` : '';
                const speaker = item.speaker ? ` **${item.speaker}**:` : '';
                sections.push(`${time}${speaker} ${item.content}`);
                sections.push('');
            }
        }

        if (sections.length <= 2) {
            alert('暂无数据可导出，请先采集');
            return;
        }

        Exporter._download(sections.join('\n'), `${filename}_融合报告.${format}`);
    }

    // ─── 事件数据处理 ───

    /**
     * 构建事件的时间索引
     * 新版 eventData 格式：{ keyPoint: [{time, label, value}], interaction: [{time, label, value}] }
     */
    static _buildEventIndex(events, xAxis) {
        const keyPointByTime = {};
        const interactionByTime = {};

        if (!events || events.error) return { keyPointByTime, interactionByTime };

        // 关键时刻
        for (const kp of (events.keyPoint || [])) {
            const t = kp.time;
            if (!t) continue;
            const text = `${kp.label}: ${kp.value}`;
            // 精确匹配时间点
            if (xAxis.includes(t)) {
                if (!keyPointByTime[t]) keyPointByTime[t] = [];
                keyPointByTime[t].push(text);
            }
        }

        // 互动玩法
        for (const ia of (events.interaction || [])) {
            const t = ia.time;
            if (!t) continue;
            const text = `${ia.label}: ${ia.value}`;
            if (xAxis.includes(t)) {
                if (!interactionByTime[t]) interactionByTime[t] = [];
                interactionByTime[t].push(text);
            }
        }

        return { keyPointByTime, interactionByTime };
    }

    static _download(content, filename) {
        const BOM = '\uFEFF';
        const safeName = filename
            .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '')
            .replace(/[\\/:*?"<>|]/g, '');

        const dataUrl = 'data:text/plain;charset=utf-8,' + encodeURIComponent(BOM + content);
        const a = document.createElement('a');
        a.href = dataUrl;
        a.download = safeName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }
}

window.__douyinExporter = Exporter;
