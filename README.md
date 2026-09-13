# 🎙️ 语音面试助手

一个本地运行的**实时语音面试** Web 应用。参考 [VoxEMW](https://github.com/emwstudio/VoxEMW) 的做法：
浏览器持续录音 → 本地 **Silero VAD + SmartTurn v3.2 判停**（你没说完绝对不抢答）→
**SenseVoice 本地转写** → 面试官（大模型）回复 → TTS 播报，**你开口即打断**。
面试记录自动保存，结束一键生成总结与建议。

## 快速开始（网页版）

需要 [Node.js 18+](https://nodejs.org/)。Windows 双击 **start.bat**，或手动：

```bash
npm install        # 前端依赖（只需一次）
npm start          # 启动后浏览器打开 http://127.0.0.1:8000
```

## 桌面版（Electron）

```bash
npm run app        # 以桌面应用运行（内嵌服务 + 窗口，自动端口，无浏览器标签页）
npm run dist       # 打包 Windows 便携版 exe（输出到 dist/）
```

- Electron 会内嵌启动 Express + 语音服务，退出时自动清理语音子进程；单实例运行。
- 实时语音模式在桌面端照常工作（AudioWorklet + 本地 VAD/SmartTurn/SenseVoice）。
- 注意：桌面端同样依赖已安装的本地语音服务（先跑 setup_speech.bat）。

**两种对话方式（页面配置面板可选）：**

| 方式 | 说明 | 依赖 |
|---|---|---|
| 🎙️ **实时语音** | 连续聆听，说一段话稍作停顿即自动转写，说完即答，开口打断面试官 | 需安装本地语音服务（见下） |
| ⌨️ **手动模式** | 按键说话（浏览器语音识别）或直接打字 | 无额外安装，开箱即用 |

### 安装实时语音服务（推荐，1 次即可）

```bash
setup_speech.bat            # 一键：建 venv → 装依赖 → 配代理
# 可选加参数：   --probe        装完自动下载模型并自检
#               --with-voxcpm   顺带安装本地克隆音色 TTS（较大，CPU 慢）
```

- 依赖下载默认走 `speech/config.json` 的 `proxy`（默认 `http://127.0.0.1:7890`，无代理可改成 `null`）。
- 首次启动会自动下载模型：Silero VAD（包内自带）、SmartTurn v3.2（~9MB）、SenseVoiceSmall（~900MB，ModelScope）。
- 装好后 `npm start`，页面提示条会显示「✅ 实时语音服务已就绪」。

## 架构

```
浏览器 (AudioWorklet 16kHz PCM)
   │  WebSocket /ws  Node (8000)
   ▼
Node server.js ── 中转音频 / 对话 / 总结 / 记录
   │  WebSocket (8765)
   ▼
speech/server.py 【本地语音服务】
   ├─ Silero VAD        语音起止检测（CPU，实时）
   ├─ SmartTurn v3.2   语义判停“说完没有”：Silero 检出静音后复核完成概率，
   │                   没说完最多压 2s 等续话，说完才转写（避免误切断）
   └─ SenseVoiceSmall   本地转写（funasr，CPU 约 10 倍实时）
   (可选) VoxCPM         克隆音色 TTS（需 --with-voxcpm + voices/ 样本）
```

判停策略（页面对齐 VoxEMW 的做法：激进 VAD + 语义复核 + **重开宽限**）：
- 页面「判停灵敏度」滑杆 1~10（默认 7，偏耐心）：越大越保守——加大静音时长、提高完成阈值、
  拉长等待、加大**重开宽限**（默认 ~650ms：VAD 判定停止后你接着说话会把前后并回同一个话轮，整段当一句话）；
- SmartTurn v3.2 对停顿做语义复核：没说完最多压几秒等你续话，说完才转写；短片段也先缓冲再提交；
- 每次决策记录在 `speech/speech.log`（prob=… -> commit/hold），`GET /api/speech/status` 可看运行状态与参数；
- 想一口气说很长的内容：保持默认或调大到 8~10，停顿 ~1 秒内都会自动接回同句。

## 功能说明

| 功能 | 说明 |
|---|---|
| 语音合成 TTS | 默认 Edge TTS（免费秒回）；可选「本地克隆音色 VoxCPM」（需安装+参考音频）；或第三方接口（配 Token）。音色/语速/音调可配 |
| 语音识别 STT | 实时模式用本地 SenseVoice；手动模式用浏览器语音识别或第三方 ASR；始终可打字 |
| 面试官画像 | 姓名/头衔/性格/风格/音色；**开始面试后全部锁定**，本场不可改 |
| 简历上传 | 可选上传 pdf / docx / txt / md，自动解析成文本，可在页面**预览并手动修正**；简历会注入面试官上下文，提问贴着你的经历来（扫描件 PDF 需文字版） |
| 面试参考资料 | 可选上传多份问题资料（同支持 pdf/docx/txt/md，可预览修正）；作为面试官**提问依据**，面试官会结合资料内容向你提问 |
| 职位信息 | 公司/职位/JD/考察重点（默认值已设为 AI Agent 通用岗），开始后锁定；刷新页面可恢复未结束的面试 |
| 实时体验 | VAD+SmartTurn 自动判停、说完即答、**开口打断播报**（可关）、语音电平条、可选实时字幕预览 |
| 面试记录 | 结束自动存 `records/`，历史页可查看/导出/删除；一键总结（评分/优劣势/建议/录用建议，LLM 或模板） |

## 大模型（面试官 AI）

面试官大脑用**任意 OpenAI 兼容接口**：页面配置面板「🧠 面试官大脑」里选常用服务
（DeepSeek/OpenAI/Moonshot/通义/SiliconFlow/MiniMax）或自定义，填 API Key + 地址 + 模型即可，
**填好即自动接入 AI**（状态会实时显示「已接入大模型…」），并可点「🔌 测试连通性」按钮
验证 Key/地址/模型是否可用（结果含延迟与错误原因）。不配置则使用内置提问脚本，
可完整走通流程。面试开始后配置锁定。

## 本地克隆音色（VoxCPM，可选）

```bash
setup_speech.bat --with-voxcpm
```

把面试官参考音频放到 `voices/`（如 `linyue.wav`），在 `speech/config.json` 里的
`tts_voxcpm` 写下音色与台词，页面「语音合成」选「本地克隆音色」。
> ⚠️ CPU 上 VoxCPM 合成很慢（一段话几十秒），日常实时面试建议保持 Edge TTS；
> 克隆音色适合 GPU 机器或对音色有强烈定制需求的场景。详见 `voices/README.md`。

## 常见问题

- **页面提示未安装语音服务** → 运行 `setup_speech.bat`；或用手动模式先面试。
- **TTS 没声音** → 检查联网（Edge TTS 需联网）；浏览器拦截自动播放时可点气泡「播放」。
- **打断不灵敏 / 回声** → 建议戴耳机；或在页面关掉「说话时自动打断面试官播报」。
- **模型下载慢/失败** → 设置代理（config.json 的 proxy）或重跑 setup_speech.bat。
- **端口占用** → 8000 被占用用 `PORT=9000 npm start`；8765 被占用用 `SPEECH_PORT=8865 npm start`（需同步改 speech/config.json）。

## 技术栈

- 后端：Node.js + Express（`server.js`）+ `ws`；语音服务 Python（`speech/server.py`，websockets）
- 前端：原生 HTML/CSS/JS + AudioWorklet（`static/`，免构建）
- 语音：Silero（silero-vad）、SmartTurn（pipecat-ai/smart-turn-v3 ONNX）、SenseVoiceSmall（funasr）、VoxCPM（可选）、Edge TTS
