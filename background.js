/**
 * Background Service Worker — 代理 LLM API 请求
 *
 * Content Script 无法直接发起跨域请求，
 * 通过 background worker 代理解决 CORS 限制。
 * 使用 port 长连接实现流式数据回传。
 *
 * 适配豆包 Responses API（/api/v3/responses）
 */

chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'llm-stream') return;

    let abortController = null;

    // 前端 disconnect 时立即中断 fetch
    port.onDisconnect.addListener(() => {
        if (abortController) {
            abortController.abort();
            abortController = null;
        }
    });

    port.onMessage.addListener(async (msg) => {
        if (msg.type !== 'LLM_REQUEST') return;

        const { apiKey, model, input } = msg;
        abortController = new AbortController();

        try {
            const response = await fetch('https://ark.cn-beijing.volces.com/api/v3/responses', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify({
                    model,
                    input,
                    stream: true
                }),
                signal: abortController.signal
            });

            if (!response.ok) {
                const errorText = await response.text();
                let errorMsg = `API 请求失败 (${response.status})`;
                try {
                    const errorJson = JSON.parse(errorText);
                    errorMsg = errorJson.error?.message || errorJson.message || errorMsg;
                } catch (_) { /* 非 JSON 错误 */ }
                port.postMessage({ type: 'LLM_ERROR', error: errorMsg });
                return;
            }

            // 流式读取 SSE 响应
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    const trimmed = line.trim();

                    if (trimmed.startsWith('event: ')) continue;
                    if (!trimmed.startsWith('data: ')) continue;

                    const data = trimmed.slice(6);
                    if (data === '[DONE]') {
                        port.postMessage({ type: 'LLM_DONE' });
                        return;
                    }

                    try {
                        const parsed = JSON.parse(data);
                        const eventType = parsed.type;

                        if (eventType === 'response.output_text.delta') {
                            const delta = parsed.delta;
                            if (delta) {
                                port.postMessage({ type: 'LLM_CHUNK', content: delta });
                            }
                        } else if (eventType === 'response.completed') {
                            port.postMessage({ type: 'LLM_DONE' });
                            return;
                        } else if (eventType === 'response.failed') {
                            const errorMsg = parsed.response?.status_message || '分析请求失败';
                            port.postMessage({ type: 'LLM_ERROR', error: errorMsg });
                            return;
                        }
                    } catch (_) { /* 跳过解析失败的行 */ }
                }
            }

            port.postMessage({ type: 'LLM_DONE' });

        } catch (err) {
            if (err.name === 'AbortError') {
                // 用户主动停止，静默处理
                return;
            }
            try {
                port.postMessage({ type: 'LLM_ERROR', error: `网络错误: ${err.message}` });
            } catch (_) { /* port 已断开 */ }
        } finally {
            abortController = null;
        }
    });
});

// ─── Service Worker 保活机制 ───
// Content Script 建立 keep-alive port 连接并定时发送心跳，
// 只要有活跃的 port 连接，Chrome 就不会休眠 Service Worker。
chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'keep-alive') return;

    console.log('[抖音数据提取] 保活连接已建立');

    port.onMessage.addListener((msg) => {
        if (msg.type === 'PING') {
            port.postMessage({ type: 'PONG' });
        }
    });

    port.onDisconnect.addListener(() => {
        console.log('[抖音数据提取] 保活连接已断开');
    });
});

console.log('[抖音数据提取] Background Service Worker 已加载');
