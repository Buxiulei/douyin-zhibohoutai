# 🎯 抖音直播数据提取 — Chrome 插件

> 从抖音直播后台（`anchor.douyin.com`）一键提取直播数据，并调用豆包大模型自动生成 AI 分析报告。

![版本](https://img.shields.io/badge/版本-v2.2.0-800020)
![平台](https://img.shields.io/badge/平台-Chrome_Extension-4285F4)
![API](https://img.shields.io/badge/AI-豆包大模型-FF6A00)

## ✨ 核心功能

### 📊 数据采集
- **文字记录** — 自动滚动抓取直播全程话术文本，含时间戳与发言人
- **评论数据** — 批量提取直播间评论，含用户昵称与时间
- **趋势数据** — 自动拦截后台 ECharts 图表，提取在线人数、评论数、互动量等趋势曲线与关键事件
- **一键全部采集** — 三类数据同步采集，进度条实时显示
- 可随时 **停止** 中断采集

### 🤖 AI 智能分析（豆包大模型）
配置 API Key 后，可自动生成三大板块分析报告：

| 板块 | 内容 |
|------|------|
| **合规性分析** | 逐条检查违规话术，提供原话 vs 优化话术对比表 |
| **直播框架分析** | 拆解直播时间线结构、热门话题、用户关注焦点 |
| **直播技巧优化** | 钩子话术、关注引导、预约引导的具体话术建议 |

- 支持 **一键生成综合报告** 或单独生成某一板块
- 生成完成后可下载 **精美 HTML 报告** 或纯文本 TXT

### 📤 数据导出
- **纯文本导出** — 仅内容，适合快速阅读
- **完整记录导出** — 含时间戳、发言人，适合存档
- **融合报告导出** — 趋势+话术+评论多维度 Markdown 报告

## 🚀 安装

1. 下载或 `git clone` 本仓库
2. 打开 Chrome，访问 `chrome://extensions/`
3. 开启右上角 **「开发者模式」**
4. 点击 **「加载已解压的扩展程序」**，选择本项目文件夹

## 📖 使用方法

### 1. 进入直播复盘页面
访问抖音直播后台：`https://anchor.douyin.com/anchor/review?type=0&roomId=...`

### 2. 采集数据
页面右下角出现 **「直播数据提取」** 悬浮窗：
- 点击 **「▶ 一键全部采集」** 自动采集文字记录 + 评论 + 趋势数据
- 也可单独采集某一类数据

### 3. AI 分析
- 展开 **API 设置**，填入豆包 API Key 和模型名称
- 点击 **「🤖 一键生成综合报告」**
- 等待三大板块自动生成完毕，下载 HTML 报告

## 🏗 项目结构

```
├── manifest.json          # 插件配置（Manifest V3）
├── background.js          # Service Worker（LLM 请求代理）
├── content/
│   ├── content.js         # 主控制器（悬浮窗 UI + 事件绑定）
│   ├── content.css        # 悬浮窗样式（Modern Cozy 风格）
│   ├── scraper.js         # 数据采集引擎（文字/评论/趋势）
│   ├── exporter.js        # 数据导出模块
│   ├── llm.js             # LLM 服务（提示词 + API 调用）
│   ├── llm-ui.js          # AI 分析面板 UI
│   └── page-bridge.js     # 页面上下文桥接（拦截 ECharts）
└── icons/                 # 插件图标
```

## ⚙️ 技术栈

- **Chrome Extension Manifest V3**
- **原生 JavaScript**（零依赖框架）
- **豆包大模型 Responses API**（流式输出）
- **CSS 设计语言**：Apple Spatial Design 风格（磨砂玻璃、弥散阴影）

## 📋 注意事项

- 插件仅在 `anchor.douyin.com` 域名下激活
- 采集过程中请勿手动滚动数据区域
- AI 分析需要有效的豆包 API Key（[获取地址](https://console.volcengine.com/ark)）
- 采集时间取决于数据总量，大量数据可能需要数分钟

## 📄 许可证

MIT License
