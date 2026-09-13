# 🎙️ 语音面试助手

一个本地运行的**实时语音面试**应用（网页 / 桌面双形态）。参考 [VoxEMW](https://github.com/emwstudio/VoxEMW) 的做法：
浏览器/桌面持续录音 → 本地 **Silero VAD + SmartTurn v3.2 判停**（你没说完绝不抢答）→
**SenseVoice 本地转写** → 面试官（大模型）回复 → TTS 播报，**你开口即打断**。
面试记录自动保存，结束一键生成总结与建议。

---

## ⚙️ 硬件要求

| 项 | 要求 |
|---|---|
| CPU | **无需 GPU**。所有本地模型（VAD / SmartTurn / SenseVoice）均为 CPU 推理 |
| 内存 | 建议 **8GB 以上**（torch + SenseVoice 等模型常驻约 2GB） |
| 磁盘 | 首次安装与模型缓存约 **3GB**：Python 依赖(torch 等 ~800MB) + SenseVoice 模型 ~900MB + Electron ~200MB + 其余 |
| 麦克风 | 实时/手动语音必需；**建议戴耳机**（避免扬声器回声触发 VAD） |
| GPU | 仅在使用「本地克隆音色 TTS（VoxCPM）」时建议；CPU 上合成约 10 倍慢于实时 |

**CPU 实时性预算**：VAD 实时处理、SmartTurn 单次决策 ~10–80ms、SenseVoice 转写 RTF≈0.1（约 10 倍快于实时）。
一句话说完后约 0.5~1 秒出字；TTS 用 Edge 在线服务秒回。

---

## 📦 外部依赖（务必先了解）

### 1. 运行时软件

| 依赖 | 版本 | 用途 |
|---|---|---|
| **Node.js** | 18+ | 主服务（Express / 桌面版 Electron） |
| **Python** | 3.10 ~ 3.14 | 仅「实时语音」需要（本地语音服务） |

### 2. 本地模型（下载一次后可离线推理）

| 模型 | 大小 | 来源 | 用途 |
|---|---|---|---|
| Silero VAD | ~2MB | 随 `silero-vad` 包自带 | 说话起止检测 |
| SmartTurn v3.2 | ~9MB | HuggingFace `pipecat-ai/smart-turn-v3` | 语义判停“你说完了吗” |
| SenseVoiceSmall | ~900MB | ModelScope `iic/SenseVoiceSmall` | 本地语音转写（中文效果好） |
| VoxCPM2（可选） | ~1.5GB | HuggingFace `openbmb/VoxCPM2` | 克隆音色 TTS（未默认启用） |

> 模型首次使用自动下载（`--probe` 会预下载并按流程自检）。下载需联网，网络受限时可配置代理（见下）。

### 3. 在线服务（需联网）

| 服务 | 说明 |
|---|---|
| **Edge TTS**（微软）| 默认语音合成，**免费、无需 Key**；需联网 |
| **大模型 API**（DeepSeek / MiniMax / OpenAI / 通义 / Moonshot / SiliconFlow 等，OpenAI 兼容格式）| 面试官大脑与总结；**需各自 API Key 与可用余额**。不配置则用内置提问脚本 |
| （可选）第三方 TTS / ASR | 页面可切换，配 Token |

### 4. 网络与代理

- 模型下载、Edge TTS、大模型 API 都要**联网**。
- 国内网络建议设置代理：`speech/config.json` 的 `proxy`（默认 `http://127.0.0.1:7890`），无代理改为 `null`；也支持环境变量 `HTTP(S)_PROXY`。

### 5. 代码依赖

- Node：见 `package.json`（express / multer / ws / msedge-tts / mammoth / unpdf，桌面版 electron / electron-builder）
- Python：见 `speech/requirements.txt`（torch / onnxruntime / silero-vad / transformers / funasr / modelscope 等），由 `setup_speech.bat` 自动装入 `speech/.venv`

---

## 🚀 启动（网页版 / 桌面版二选一）

需要 [Node.js 18+](https://nodejs.org/)，实时语音额外需要 Python + 本地语音服务。

| 形态 | 命令 / 双击 | 效果 |
|---|---|---|
| 🌐 网页版 | `npm run web`（或 `npm start` / 双击 `start.bat`） | 浏览器打开 http://127.0.0.1:8000 |
| 🖥️ 桌面版 | `npm run desktop`（或 `npm run app` / 双击 `start_desktop.bat`） | 独立窗口，自动端口，无浏览器标签页 |

```bash
npm install        # 前端依赖（只需一次）
npm run web        # 网页版
npm run desktop    # 桌面版
npm run dist       # 打包 Windows 便携版 exe（输出到 dist/）
```

- 桌面版（Electron）内嵌 Express + 语音服务，退出时自动清理语音子进程、单实例运行。
- 两种形态可同时跑（桌面版自动端口，不与网页版 8000 冲突），共用同一个语音服务。

**新设备首次使用**：双击 `start.bat` / `start_desktop.bat` 启动时会先检测本地语音服务是否安装
（`--check`），**未安装则自动一键安装**（建 Python 虚拟环境 → 装依赖 → 下载语音模型 → 自检），
装完再启动应用；安装失败也会提示并允许先用「手动模式」。直接用 `npm run web` / `npm run desktop`
启动则需先手动运行 `setup_speech.bat`。

**页面内一键初始化**：配置面板「交互方式」下有 **⚙️ 初始化本地环境** 按钮——随时点击检查环境就绪度
（服务是否在跑、模型是否可用），未安装/未启动时自动补装或拉起，并实时回显安装日志（SSE）。

**两种对话方式（页面配置面板可选）：**

| 方式 | 说明 | 依赖 |
|---|---|---|
| 🎙️ **实时语音** | 连续聆听，说一段话稍作停顿即自动转写，说完即答，开口打断面试官 | 需安装本地语音服务（见下） |
| ⌨️ **手动模式** | 按键说话（浏览器/Chromium 语音识别，桌面版不一定可用则直接打字） | 无额外安装，开箱即用 |

### 安装实时语音服务（推荐，1 次即可）

```bash
setup_speech.bat            # 一键：建 venv → 装 Python 依赖 → 配代理
# 可选加参数：   --probe        装完自动下载模型并全链路自检
#               --with-voxcpm   顺带安装本地克隆音色 TTS（较大，CPU 慢）
```

装好后启动页面，提示条显示「✅ 实时语音服务已就绪」。

---

## 架构

```
浏览器/Electron (AudioWorklet 16kHz PCM)
   │  WebSocket /ws  Node (8000 或自动端口)
   ▼
Node server.js ── 中转音频 / 对话 / 总结 / 记录
   │  WebSocket (8765)
   ▼
speech/server.py 【本地语音服务】
   ├─ Silero VAD        语音起止检测（CPU，实时）
   ├─ SmartTurn v3.2   语义判停“说完没有”：Silero 检出静音后复核完成概率，
   │                   没说完最多压几秒等续话，说完才转写（避免误切断）
   └─ SenseVoiceSmall   本地转写（funasr，CPU 约 10 倍实时）
   (可选) VoxCPM         克隆音色 TTS（需 --with-voxcpm + voices/ 样本）
```

判停策略（对齐 VoxEMW：激进 VAD + 语义复核 + **重开宽限**）：
- 页面「判停灵敏度」滑杆 1~10（默认 7，偏耐心）：越大越保守——加大静音时长、提高完成阈值、
  拉长等待、加大**重开宽限**（默认 ~650ms：VAD 判定停止后你接着说话会把前后并回同一个话轮，整段当一句话）；
- 每次决策记录在 `speech/speech.log`（prob=… -> commit/hold），`GET /api/speech/status` 可看运行状态与参数；
- 想一口气说很长的内容：保持默认或调大到 8~10，停顿 ~1 秒内都会自动接回同句。

---

## 功能说明

| 功能 | 说明 |
|---|---|
| 语音合成 TTS | 默认 Edge TTS（免费秒回）；可选「本地克隆音色 VoxCPM」（需安装+参考音频）；或第三方接口（配 Token）。音色/语速/音调可配 |
| 语音识别 STT | 实时模式用本地 SenseVoice；手动模式用浏览器语音识别或第三方 ASR；始终可打字 |
| 面试官画像 | 姓名/头衔/性格/风格/音色；**开始面试后全部锁定**，本场不可改 |
| 简历上传 | 可选上传 pdf / docx / txt / md 自动解析；也**可直接粘贴/输入简历文本**。文本在页面可随时编辑修正，注入面试官上下文（扫描件 PDF 需文字版） |
| 面试参考资料 | 可选上传多份问题资料或**直接粘贴/输入文本**；作为面试官**提问依据** |
| 职位信息 | 公司/职位/JD/考察重点（默认 AI Agent 通用岗），开始后锁定；刷新可恢复未结束的面试 |
| 实时体验 | VAD+SmartTurn 自动判停、说完即答、**开口打断**（可关）、语音电平条、可选实时字幕预览 |
| 面试记录 | 结束自动存 `records/`，历史页查看/导出/删除；一键总结（评分/优劣势/建议/录用建议，LLM 或模板） |
| 桌面版 | Electron 独立窗口，自动端口，退出清理语音子进程，单实例 |

## 大模型（面试官 AI）

任意 **OpenAI 兼容接口**：页面「🧠 面试官大脑」选常用服务（DeepSeek/OpenAI/Moonshot/通义/SiliconFlow/MiniMax）或自定义，
填 API Key + 地址 + 模型，**填好即自动接入**（实时显示状态），可点「🔌 测试连通性」。
不配置则用内置提问脚本，可完整走通流程。面试开始后配置锁定。

## 本地克隆音色（VoxCPM，可选）

```bash
setup_speech.bat --with-voxcpm
```

把参考音频放到 `voices/`（如 `linyue.wav`），在 `speech/config.json` 的 `tts_voxcpm` 配台词，
页面「语音合成」选「本地克隆音色」。详见 `voices/README.md`。
> ⚠️ CPU 上合成很慢（一段话几十秒），日常实时面试建议保持 Edge TTS；适合 GPU 机器或强定制音色场景。

---

## 🗺️ 后续规划

- **发布完善**：Windows 安装包（NSIS）/ 代码签名 / 自动更新；macOS、Linux 打包
- **VoxCPM 正式接入**：把克隆音色 TTS 接入默认流程与打断体验（当前为可选/预留，CPU 慢）
- **OCR**：简历/参考资料扫描版 PDF 的文字识别
- **更自然的多轮**：流式 LLM 输出、模型思考期也能插话补正（对齐 VoxEMW 的续轮机制）
- **报告能力**：多维评分雷达图、HTML/PDF 面试报告导出
- **数字人形象**（参考 VoxEMW，可选）：AI 面试官虚拟形象 + 口型同步

---

## 常见问题

- **页面提示未安装语音服务** → 运行 `setup_speech.bat`；或用「手动模式」先面试。
- **TTS 没声音** → 检查联网（Edge TTS 需联网）；自动播放被拦截时点气泡「播放」。
- **打断不灵敏 / 回声** → 建议戴耳机；或关掉「说话时自动打断面试官播报」。
- **模型下载慢/失败** → 配置代理（config.json 的 proxy）或重跑 setup_speech.bat。
- **端口占用** → 8000 占用用 `PORT=9000 npm start`；8765 占用用 `SPEECH_PORT=8865 npm start`（同步改 speech/config.json）。
- **桌面版重装后实时语音不可用** → 目标机器需重新运行 setup_speech.bat（模型与 Python 依赖在本机）。

---

## 技术栈

- 后端：Node.js + Express（`server.js`）+ `ws`；语音服务 Python（`speech/server.py`，websockets）
- 桌面：Electron（`electron/main.js`，内嵌服务 + 窗口）；打包 electron-builder
- 前端：原生 HTML/CSS/JS + AudioWorklet（`static/`，免构建）
- 语音：Silero（silero-vad）、SmartTurn（pipecat-ai/smart-turn-v3 ONNX）、SenseVoiceSmall（funasr）、VoxCPM（可选）、Edge TTS
- 文档解析：mammoth（docx）、unpdf（pdf）
