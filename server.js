'use strict';
/**
 * 语音面试助手 · 本地后端 (Node.js)
 *
 * 接口:
 *   POST /api/tts          文本转语音 (edge-tts 免费 / 第三方 / 本地 VoxCPM)
 *   POST /api/stt          语音转文字 (转发到 OpenAI 兼容 ASR, 手动模式)
 *   POST /api/chat         面试官回复 (LLM 或内置提问脚本)
 *   POST /api/summary      面试总结与建议 (LLM 或模板总结)
 *   GET  /api/records      记录列表 / POST 保存 / GET|DELETE :id
 *   GET  /api/speech/status   本地语音服务状态
 *   WS   /ws               实时语音中继 (浏览器 <-> speech/server.py)
 */
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const net = require('net');
const { spawn } = require('child_process');
const { WebSocket, WebSocketServer } = require('ws');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const mammoth = require('mammoth');

const app = express();
const PORT = process.env.PORT || 8000;
const STATIC_DIR = path.join(__dirname, 'static');
const RECORDS_DIR = path.join(__dirname, 'records');
const SPEECH_PORT = Number(process.env.SPEECH_PORT || 8765);
fs.mkdirSync(RECORDS_DIR, { recursive: true });

app.use(express.json({ limit: '20mb' }));
app.use('/static', express.static(STATIC_DIR));
app.get('/', (req, res) => res.sendFile(path.join(STATIC_DIR, 'index.html')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function cleanForSpeech(text) {
  return String(text)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')      // 链接 -> 文字
    .replace(/[#*_`>|~]/g, '')
    .replace(/```[\s\S]*?```/g, '。')
    .replace(/\n+/g, '。')
    .trim();
}

function nowStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function validId(rid) {
  return /^[A-Za-z0-9_-]{6,40}$/.test(rid || '');
}

function recordPath(rid) {
  if (!validId(rid)) return null;
  return path.join(RECORDS_DIR, rid + '.json');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 大模型常见错误的友好中文提示 */
function llmErrorHint(status, rawText) {
  const text = String(rawText || '').toLowerCase();
  if (status === 401 || status === 403 || /invalid api|unauthorized|auth/i.test(text)) return 'Token 无效或未授权，请检查 API Key';
  if (status === 402 || /insufficient balance|balance/i.test(text)) return '账户余额不足 / 欠费，请先充值';
  if (status === 404 || /model not found|no such model/i.test(text)) return '接口地址或模型名可能不对';
  if (status === 429) return '触发限流，请稍后重试';
  if (status === 400) return '请求参数不合法（可能模型名不支持当前消息格式）';
  return '';
}

/**
 * 剥掉推理模型（如 MiniMax-M3）拼进 content 里的思考过程，只保留最终回答：
 * 1) 带标记前缀: "thinking <…>" / "**thinking** …" / "思考：…" / ```thinking …``` / <thinking>…
 * 2) 无标记但整段是自述推理: "候选人说…我应该…\n\n<真正要说的对话>"
 */
function stripReasoning(content) {
  let text = String(content || '').trim();
  // 1) 带标记的思考块
  const m = text.match(
    /^(?:\*{0,3}thinking\*{0,3}|reasoning|思考过程\s*[:：]?|思考\s*[:：]?|```(?:thinking|reasoning)|<\s*thinking\s*>|<\|thinking\|>|##+\s*.*(?:thinking|思考)|\[thinking\])[\s\S]*?(?:\n[ \t]*\n|<\s*\/\s*thinking\s*>\s*\n|```\s*\n)/
  );
  if (m) {
    const rest = text.slice(m[0].length).trim();
    if (rest) text = rest;
  }
  // 2) 无标记的推理段落：前面的整段像模型自述/分析时，只保留最后一段对话
  const blocks = text.split(/\n[ \t]*\n+/).map((b) => b.trim()).filter(Boolean);
  if (blocks.length >= 2) {
    const head = blocks.slice(0, -1).join('\n');
    const last = blocks[blocks.length - 1];
    // 推理信号：第三人称分析候选人 / 心理猜测 / 流程自述等；排除"我理解你的意思了"这类正常衔接
    const reasoningRe = /(候选人|这位(?:求职者|朋友)|candidate|the user|the candidate|我应该|我应当|我需要|我打算|我准备|可能是在|似乎|看起来|推测|心理|紧张|测试连接|鼓励|引导|让候选人|让ta|根据(?:规则|要求)|首先(?:我|要|需要)|用(?:这种方式|这个思路)|这段(?:内容|回复))/i;
    if (head.length >= 25 && reasoningRe.test(head) && last.length <= 350) {
      text = last;
    }
  }
  return text.trim() || String(content || '').trim();
}

// ---------------------------------------------------------------------------
// 本地语音服务管理 (speech/server.py)
// ---------------------------------------------------------------------------
let speechProc = null;
let speechRuntime = null;
let speechDetail = '';

function loadSpeechRuntime() {
  try {
    speechRuntime = JSON.parse(fs.readFileSync(path.join(__dirname, 'speech', 'runtime.json'), 'utf8'));
  } catch (e) {
    speechRuntime = null;
  }
}

function speechEnv() {
  const env = { ...process.env };
  if (speechRuntime && speechRuntime.proxy && !env.HTTPS_PROXY) {
    env.HTTPS_PROXY = env.HTTP_PROXY = env.ALL_PROXY = speechRuntime.proxy;
  }
  return env;
}

function tcpUp(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    s.setTimeout(600);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(false));
  });
}

/** 确保语音服务在跑，返回 level: running|starting|not-installed|install-failed */
async function ensureSpeechService() {
  loadSpeechRuntime();
  if (!speechRuntime) return 'not-installed';
  if (await tcpUp(SPEECH_PORT)) return 'running';
  if (speechProc) return 'starting';
  speechDetail = '';
  const py = speechRuntime.python || 'python';
  const script = path.join(__dirname, 'speech', 'server.py');
  speechProc = spawn(py, [script], { cwd: __dirname, env: speechEnv(), stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let logBuf = '';
  speechProc.stderr.on('data', (d) => {
    logBuf += d.toString();
    if (process.env.DEBUG_SPEECH) process.stderr.write('[speech] ' + d);
  });
  speechProc.on('error', (err) => { speechDetail = '启动失败: ' + err.message; });
  speechProc.on('exit', (code) => {
    speechProc = null;
    if (code && code !== 0) speechDetail = '语音服务已退出 (code=' + code + ') ' + logBuf.slice(-300);
  });
  for (let i = 0; i < 120; i++) {
    if (await tcpUp(SPEECH_PORT)) return 'running';
    await sleep(500);
  }
  return 'starting';
}

/** 向语音服务发一次 ping，等 ready/pong (含模型状态) */
function speechPing(timeoutMs = 4000) {
  return new Promise((resolve) => {
    let settled = false;
    let w;
    try {
      w = new WebSocket('ws://127.0.0.1:' + SPEECH_PORT);
    } catch (e) {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => { try { w.close(); } catch {} done(null); }, timeoutMs);
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
      try { w.close(); } catch {}
    };
    w.on('open', () => { try { w.send(JSON.stringify({ type: 'ping' })); } catch {} });
    w.on('message', (d) => {
      try {
        const j = JSON.parse(d.toString());
        if (j.type === 'ready' || j.type === 'pong') done(j);
      } catch {}
    });
    w.on('error', () => done(null));
    w.on('close', () => done(null));
  });
}

async function speechServiceStatus() {
  let level;
  if (await tcpUp(SPEECH_PORT)) level = 'running';
  else if (speechRuntime && speechProc) level = 'starting';
  else if (speechRuntime) level = 'stopped';
  else level = 'not-installed';
  const ping = await speechPing(1200);
  return {
    level,
    installed: !!speechRuntime,
    python: speechRuntime ? (speechRuntime.python || 'python') : null,
    detail: speechDetail || '',
    service: ping,
  };
}

app.get('/api/speech/status', async (req, res) => {
  res.json(await speechServiceStatus());
});

// ---------------------------------------------------------------------------
// TTS
// ---------------------------------------------------------------------------
async function edgeTtsBuffer(text, voice, rate, pitch) {
  const tts = new MsEdgeTTS();
  try {
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
    const options = {};
    if (rate && rate !== '+0%') options.rate = rate === '0' ? 'default' : rate;
    if (pitch && pitch !== '+0Hz') options.pitch = pitch === '0' ? 'default' : pitch;
    const { audioStream } = tts.toStream(cleanForSpeech(text), options);
    const chunks = [];
    for await (const c of audioStream) chunks.push(c);
    return Buffer.concat(chunks);
  } finally {
    try { tts.close(); } catch (e) { /* ignore */ }
  }
}

async function thirdTtsBuffer(text, { baseUrl, apiKey, model, voice }) {
  if (!baseUrl || !apiKey) throw new Error('第三方 TTS 需要配置接口地址和 Token');
  const url = baseUrl.replace(/\/+$/, '') + '/audio/speech';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
    body: JSON.stringify({ model: model || 'tts-1', input: text, voice: voice || 'alloy', response_format: 'mp3' }),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`第三方 TTS 失败: HTTP ${res.status} ${detail}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** 本地 VoxCPM 克隆音色 TTS（走语音服务 WS） */
function voxcpmTtsBuffer(text, voice) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let w;
    try {
      w = new WebSocket('ws://127.0.0.1:' + SPEECH_PORT);
    } catch (e) {
      reject(new Error('语音服务不可达'));
      return;
    }
    const timer = setTimeout(() => { try { w.close(); } catch {} fail(new Error('VoxCPM 合成超时')); }, 300000);
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { w.close(); } catch {}
      reject(err);
    };
    w.on('open', () => {
      if (settled) return;
      w.send(JSON.stringify({ type: 'tts_request', text, voice: voice || '' }));
    });
    w.on('message', (d) => {
      let j;
      try { j = JSON.parse(d.toString()); } catch { return; }
      if (j.type !== 'tts_response') return;
      clearTimeout(timer);
      if (j.error) { fail(new Error(j.error)); return; }
      settled = true;
      try { w.close(); } catch {}
      resolve({ data: Buffer.from(j.audio_b64, 'base64'), mime: j.mime || 'audio/wav' });
    });
    w.on('error', () => fail(new Error('语音服务连接失败')));
    w.on('close', () => fail(new Error('语音服务连接关闭')));
  });
}

app.post('/api/tts', async (req, res) => {
  const body = req.body || {};
  let text = String(body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text 不能为空' });
  text = text.slice(0, 5000);

  try {
    let data; // { buffer, mime }
    if (body.provider === 'third') {
      data = {
        mime: 'audio/mpeg',
        data: await thirdTtsBuffer(text, {
          baseUrl: body.baseUrl, apiKey: body.apiKey, model: body.model, voice: body.voice3rd || body.voice,
        }),
      };
    } else if (body.provider === 'voxcpm') {
      data = await voxcpmTtsBuffer(text, body.voice);
      if (!data.data || data.data.length === 0) throw new Error('语音合成结果为空');
    } else {
      data = {
        mime: 'audio/mpeg',
        data: await edgeTtsBuffer(text, body.voice || 'zh-CN-XiaoxiaoNeural', body.rate || '+0%', body.pitch || '+0Hz'),
      };
    }
    if (!data.data || data.data.length === 0) {
      return res.status(502).json({ error: '语音生成结果为空，请检查音色 ID 是否正确' });
    }
    res.set('Content-Type', data.mime);
    res.set('Cache-Control', 'no-store');
    res.send(data.data);
  } catch (e) {
    res.status(502).json({ error: e.message || String(e) });
  }
});

// ---------------------------------------------------------------------------
// STT (第三方 ASR 转发; 实时模式用本地 SenseVoice)
// ---------------------------------------------------------------------------
app.post('/api/stt', upload.single('audio'), async (req, res) => {
  const baseUrl = String(req.body.baseUrl || '').trim();
  const apiKey = String(req.body.apiKey || '').trim();
  if (!baseUrl || !apiKey) return res.status(400).json({ error: '第三方 ASR 需要配置接口地址和 Token' });
  if (!req.file) return res.status(400).json({ error: '缺少音频文件' });

  const fd = new FormData();
  fd.append('model', String(req.body.model || 'whisper-1'));
  fd.append('language', String(req.body.language || 'zh'));
  fd.append('file', new Blob([new Uint8Array(req.file.buffer)], { type: req.file.mimetype || 'audio/webm' }),
    req.file.originalname || 'recording.webm');

  try {
    const r = await fetch(baseUrl.replace(/\/+$/, '') + '/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey },
      body: fd,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(502).json({ error: `第三方 ASR 失败: HTTP ${r.status} ${JSON.stringify(data).slice(0, 300)}` });
    }
    const txt = String(data.text || '').trim();
    if (!txt) return res.status(422).json({ error: '未能识别出文字（可尝试调整麦克风或稍后再试）' });
    res.json({ text: txt });
  } catch (e) {
    res.status(502).json({ error: '第三方 ASR 请求失败: ' + (e.message || String(e)) });
  }
});

// ---------------------------------------------------------------------------
// 实时语音中继: 浏览器 /ws  <->  speech/server.py
// ---------------------------------------------------------------------------
async function handleRealtimeWs(browserWs) {
  let py;
  const send = (obj) => { try { browserWs.readyState === 1 && browserWs.send(JSON.stringify(obj)); } catch (e) { /* ignore */ } };
  const closePy = () => { try { py && py.close(); } catch (e) { /* ignore */ } };

  // 先确保本地语音服务在跑（首次浏览器连接时自动拉起）
  const level = await ensureSpeechService();
  let up = await tcpUp(SPEECH_PORT);
  for (let i = 0; i < 40 && !up; i++) { await sleep(500); up = await tcpUp(SPEECH_PORT); }
  if (!up) {
    send({
      type: 'error',
      code: 'SPEECH_UNAVAILABLE',
      message: level === 'not-installed'
        ? '本地语音服务未安装，请先运行 setup_speech.bat（或用「手动模式」）'
        : '本地语音服务未就绪：' + (speechDetail || ''),
    });
    try { browserWs.close(); } catch (e) { /* ignore */ }
    return;
  }

  const onPyMessage = (d) => {
    if (browserWs.readyState !== 1) return;
    browserWs.send(d.toString()); // 原样转发 JSON 事件
  };
  const onPyClose = () => {
    send({ type: 'error', code: 'SPEECH_LINK_DOWN', message: '本地语音服务断开连接' });
    closePy();
  };

  try {
    py = new WebSocket('ws://127.0.0.1:' + SPEECH_PORT);
  } catch (e) {
    send({ type: 'error', code: 'SPEECH_UNAVAILABLE', message: '本地语音服务不可用' });
    browserWs.close();
    return;
  }
  py.on('message', onPyMessage);
  py.on('close', onPyClose);
  py.on('error', (e) => {
    send({ type: 'error', code: 'SPEECH_UNAVAILABLE', message: '本地语音服务连接失败: ' + (e.message || '') });
  });

  browserWs.on('message', (data, isBinary) => {
    if (isBinary) {
      if (py && py.readyState === 1 && Buffer.isBuffer(data)) py.send(data);
      return;
    }
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === 'ping') { send({ type: 'pong', service: 'ok' }); return; }
    if (py && py.readyState === 1) py.send(data.toString());
  });

  browserWs.on('close', closePy);
  browserWs.on('error', closePy);
}

// ---------------------------------------------------------------------------
// 面试官对话
// ---------------------------------------------------------------------------
function buildInterviewerSystem(profile = {}, job = {}, resume = '', reference = '') {
  const p = (v) => (v == null ? '' : String(v)).trim();
  const name = p(profile.name) || '面试官';
  const title = p(profile.title) || '面试官';
  const lines = [
    `你是${name}，身份：${title}，正在进行一场「${p(job.title) || '未知职位'}」的面试。`,
    `公司：${p(job.company) || '未知'}。`,
  ];
  if (p(profile.persona)) lines.push(`你的画像：${p(profile.persona)}`);
  if (p(profile.style)) lines.push(`你的沟通风格：${p(profile.style)}`);
  if (p(job.jd)) lines.push(`岗位要求：${p(job.jd)}`);
  if (p(job.focus)) lines.push(`本次面试考察重点：${p(job.focus)}`);
  if (p(resume)) {
    lines.push(
      `候选人简历（务必细读，据此提出针对性问题，不要问简历里已写明的基本信息）：\n${String(resume).slice(0, 2500)}`
    );
  }
  if (p(reference)) {
    lines.push(
      `面试参考资料（提问依据，请结合其内容向候选人提问或考察其对资料涉及领域的理解）：\n${String(reference).slice(0, 4000)}`
    );
  }
  lines.push(
    '面试规则：\n' +
    '1. 一次只问一个问题，追问要简短自然。\n' +
    '2. 先简短回应/认可候选人，再提出下一个问题或追问。\n' +
    '3. 全程用中文口语，每次回复控制在 2~3 句话以内，像真人面试官，不要长篇输出。\n' +
    '4. 开场时先做简短自我介绍并欢迎候选人，然后请候选人做自我介绍。\n' +
    '5. 提问要贴着候选人的简历、自我介绍和「面试参考资料」展开，追问其经历细节、项目难点与思考过程。\n' +
    '6. 大约第 6~8 轮问答后，询问候选人是否有想反问的问题。\n' +
    '7. 候选人明确表示没有问题时，礼貌收尾致谢。\n' +
    '8. 直接输出你要说的话，绝不要输出任何思考过程、推理、内部规则复盘或额外说明。\n'
  );
  return lines.join('\n');
}

app.post('/api/chat', async (req, res) => {
  const body = req.body || {};
  const profile = body.profile || {};
  const job = body.job || {};
  const llm = body.llm || {};
  const history = Array.isArray(body.history) ? body.history : [];
  const resume = body.resume || '';
  const reference = body.reference || '';

  if (llm.apiKey) return chatWithLlm(profile, job, llm, history, resume, reference, res);
  res.json({ reply: chatRule(profile, job, history), source: 'rule' });
});

async function chatWithLlm(profile, job, llm, history, resume, reference, res) {
  const baseUrl = (String(llm.baseUrl || 'https://api.openai.com/v1')).replace(/\/+$/, '');
  const model = llm.model || 'gpt-4o-mini';
  const messages = [{ role: 'system', content: buildInterviewerSystem(profile, job, resume, reference) }];
  for (const m of history) {
    if ((m.role === 'user' || m.role === 'assistant') && m.content) {
      messages.push({ role: m.role, content: String(m.content).slice(0, 2000) });
    }
  }
  const trimmed = messages.slice(-61);
  // 部分厂商（如 MiniMax）要求请求中至少有一条 user 消息，否则报 "chat content is empty"
  if (!trimmed.some((m) => m.role === 'user')) {
    trimmed.push({ role: 'user', content: '面试开始。' });
  }
  try {
    const r = await fetch(baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + llm.apiKey },
      body: JSON.stringify({
        model, messages: trimmed, temperature: 0.8, max_tokens: 400,
        ...(llm.disableThinking ? { thinking: { type: 'disabled' } } : {}),
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const hint = llmErrorHint(r.status, JSON.stringify(data));
      const detail = JSON.stringify(data).slice(0, 300);
      return res.status(502).json({ error: '大模型返回错误: HTTP ' + r.status + ' ' + detail + (hint ? '（' + hint + '）' : '') });
    }
    const reply = String((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '').trim();
    if (!reply) return res.status(502).json({ error: '大模型返回了空回复' });
    res.json({ reply: stripReasoning(reply), source: 'llm' });
  } catch (e) {
    res.status(502).json({ error: '请求大模型失败: ' + (e.message || String(e)) });
  }
}

function chatRule(profile = {}, job = {}, history = []) {
  const userMsgs = history.filter((m) => m.role === 'user');
  const n = userMsgs.length;
  const name = String(profile.name || '面试官').trim();
  const jobTitle = String(job.title || '这个岗位').trim();

  const bank = [
    `好的。可以详细讲一讲你最近负责的一个项目或工作吗？你在其中承担了什么角色？`,
    '在这个项目里，你遇到过最大的困难是什么？你是怎么解决的？',
    `我们聊聊岗位相关的：你觉得要做好${jobTitle}这份工作，最重要的能力是什么？为什么？`,
    '如果再给你一次机会重新做这个项目，你会改进哪些地方？',
    '设想你入职后需要快速上手我们的业务，你会怎么安排第一周？',
    '从你的角度看，你觉得自己还有哪些方面需要提升？',
  ];
  if (n === 0) {
    return `你好，我是${name}，欢迎参加本次面试。在开始之前，请你先做一个简单的自我介绍，包括你的教育背景、过往经历和应聘${jobTitle}的动机。`;
  }
  if (n === 1) return '谢谢你的介绍。' + bank[0];
  if (n <= bank.length + 1) return bank[n - 2];
  if (n === bank.length + 2) return '整体聊下来我对你的情况有了一定的了解。最后想问问你，有没有什么问题想了解公司或这个岗位的？';
  if (n === bank.length + 3) return '好的，也谢谢你的提问。今天的时间差不多了，非常感谢你的参与，我们会尽快给你反馈，祝你顺利！';
  return '嗯，我理解你的意思了。可以再展开讲讲吗？';
}

// ---------------------------------------------------------------------------
// 面试总结
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 简历解析
// ---------------------------------------------------------------------------
const RESUME_MAX_CHARS = 60000;

async function parseResumeBuffer(buffer, ext) {
  let text = '';
  const lower = String(ext || '').toLowerCase();
  if (lower === 'pdf') {
    const { extractText } = await import('unpdf');
    const r = await extractText(new Uint8Array(buffer));
    text = (Array.isArray(r.text) ? r.text : []).join('\n');
  } else if (lower === 'docx') {
    const r = await mammoth.extractRawText({ buffer });
    text = r.value || '';
  } else if (lower === 'txt' || lower === 'text' || lower === 'md') {
    const buf = Buffer.from(buffer);
    text = buf.toString('utf8');
    if (text.includes('\uFFFD')) {
      try { text = new TextDecoder('gb18030').decode(buf); } catch (e) { /* 保留原结果 */ }
    }
  } else {
    throw new Error(lower === 'doc'
      ? '暂不支持旧版 .doc，请用 Word 另存为 .docx 或导出为 .pdf 后再上传'
      : '不支持的文件格式：.' + (lower || '?') + '（支持 pdf / docx / txt / md）');
  }
  text = text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text) {
    throw new Error('未能从文件中解析出文本（扫描件 PDF 暂不支持 OCR，请上传文字版）');
  }
  return text.slice(0, RESUME_MAX_CHARS);
}

app.post('/api/resume', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '缺少文件' });
  const ext = (req.file.originalname || '').split('.').pop();
  try {
    const text = await parseResumeBuffer(req.file.buffer, ext);
    res.json({ ok: true, text, chars: text.length, ext });
  } catch (e) {
    res.status(422).json({ error: e.message || String(e) });
  }
});

// ---------------------------------------------------------------------------
// 大模型连通性测试
// ---------------------------------------------------------------------------
app.post('/api/llm/test', async (req, res) => {
  const body = req.body || {};
  const baseUrl = String(body.baseUrl || '').replace(/\/+$/, '');
  const apiKey = String(body.apiKey || '').trim();
  const model = String(body.model || '').trim();
  if (!baseUrl || !apiKey) return res.status(400).json({ ok: false, error: '请先填写接口地址和 Token' });

  const started = Date.now();
  try {
    const r = await fetch(baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({
        model: model || 'gpt-4o-mini',
        messages: [{ role: 'user', content: '请只回复两个字：正常' }],
        max_tokens: 16,
        ...(body.disableThinking ? { thinking: { type: 'disabled' } } : {}),
      }),
      signal: AbortSignal.timeout(20000),
    });
    const data = await r.json().catch(() => ({}));
    const latency = Date.now() - started;
    if (!r.ok) {
      const raw = String(data.error?.message || data.message || data.error || (`HTTP ${r.status} ${r.statusText}`)).slice(0, 300);
      let hint = '';
      if (r.status === 401 || r.status === 403) hint = '（Token 无效或未授权）';
      else if (r.status === 402) hint = '（账户余额不足 / 欠费，请充值后重试）';
      else if (r.status === 404) hint = '（接口地址或模型名可能不对）';
      else if (r.status === 429) hint = '（触发限流，稍后再试）';
      return res.json({ ok: false, latency, status: r.status, error: raw + hint });
    }
    const reply = String((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '').slice(0, 80);
    res.json({ ok: true, latency, model: String(data.model || model || ''), reply });
  } catch (e) {
    const latency = Date.now() - started;
    const m = String(e.message || e.name || '未知错误').slice(0, 300);
    let hint = '';
    if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(m)) hint = '（域名无法解析，检查接口地址或网络）';
    else if (/timeout|timed ?out/i.test(m)) hint = '（请求超时，检查网络/代理或接口地址）';
    else if (/fetch failed/i.test(m)) hint = '（网络连接失败，检查代理/防火墙/接口地址）';
    res.json({ ok: false, latency, error: m + hint });
  }
});

// ---------------------------------------------------------------------------
// 面试总结
// ---------------------------------------------------------------------------
app.post('/api/summary', async (req, res) => {
  const body = req.body || {};
  const profile = body.profile || {};
  const job = body.job || {};
  const llm = body.llm || {};
  const history = Array.isArray(body.history) ? body.history : [];
  const resume = body.resume || '';
  const reference = body.reference || '';

  if (llm.apiKey) {
    const result = await summaryWithLlm(profile, job, llm, history, resume, reference);
    if (result) return res.json(result);
  }
  res.json(summaryRule(profile, job, history));
});

async function summaryWithLlm(profile, job, llm, history, resume, reference) {
  const baseUrl = (String(llm.baseUrl || 'https://api.openai.com/v1')).replace(/\/+$/, '');
  const model = llm.model || 'gpt-4o-mini';
  const transcript = history
    .filter((m) => m.content)
    .map((m) => `${m.role === 'user' ? '候选人' : '面试官'}: ${String(m.content)}`)
    .join('\n')
    .slice(-8000);
  const prompt =
    '你是资深人力资源顾问。请根据以下面试记录，为候选人生成一份面试总结。\n' +
    '只输出一个 JSON 对象（不要用 markdown 代码块包裹），结构如下：\n' +
    '{"score": 0到10的数字, "overall": "总体评价(100字以内)", "strengths": ["优势1","优势2","优势3"], ' +
    '"weaknesses": ["不足1","不足2"], "advice": ["建议1","建议2","建议3"], "hire": "建议录用/待定/建议不录用"}\n' +
    `应聘职位：${job.title || '未知'}；公司：${job.company || '未知'}。\n` +
    `岗位要求：${String(job.jd || '').slice(0, 2000)}\n` +
    `考察重点：${String(job.focus || '').slice(0, 1000)}\n` +
    (resume ? `候选人简历：${String(resume).slice(0, 2500)}\n` : '') +
    (reference ? `面试参考资料：${String(reference).slice(0, 4000)}\n` : '') +
    `面试记录：\n${transcript}\n\n请输出 JSON：`;
  try {
    const r = await fetch(baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + llm.apiKey },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.4, max_tokens: 1200 }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return null;
    const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) return null;
    const m = String(content).match(/\{[\s\S]*\}/);
    if (!m) return null;
    const obj = JSON.parse(m[0]);
    return {
      summary: {
        score: Number(obj.score || 0),
        overall: String(obj.overall || ''),
        strengths: Array.isArray(obj.strengths) ? obj.strengths : [],
        weaknesses: Array.isArray(obj.weaknesses) ? obj.weaknesses : [],
        advice: Array.isArray(obj.advice) ? obj.advice : [],
        hire: String(obj.hire || '待定'),
      },
      source: 'llm',
    };
  } catch (e) {
    return null;
  }
}

function summaryRule(profile = {}, job = {}, history = []) {
  const n = history.filter((m) => m.role === 'user').length;
  const jd = String(job.jd || '') + String(job.focus || '');
  const keywords = ['项目', '团队', '沟通', '学习', '技术', '管理', '经验', '协作', '产品', '用户', '数据', '质量', '抗压'];
  const hit = keywords.filter((k) => jd.includes(k));

  const strengths = [];
  strengths.push(n >= 1 ? '能完整完成自我介绍与一轮以上的问答' : '已进入自我介绍环节');
  if (n >= 2) strengths.push(`共完成 ${n} 轮对话，配合度高`);
  if (n >= 4) strengths.push('对项目经历和岗位职责进行了较为充分的表达');
  const weaknesses = n < 4 ? ['回答深度有限，建议补充具体案例与数据'] : ['建议进一步追问技术细节与量化结果'];
  const advice = [
    '面试官注意围绕「考察重点」逐项追问，并结合候选人回答深挖细节',
    '可让候选人补充失败经历与复盘，了解真实项目中的角色分工',
  ];
  if (hit.length) advice.push(`建议针对 JD 关键词「${hit.slice(0, 4).join('、')}」设计追问`);
  else advice.push('建议在岗位 JD 中补充考察重点关键词，以得到更精准的追问');

  const score = Math.min(9.0, Math.round((4.5 + n * 0.6) * 10) / 10);
  const overall = `本次面试共进行 ${n} 轮问答${n ? '。' : '，尚未开始正式问答。'}当前为内置模板总结；配置大模型 Token 后可获得更深入的评估。`;
  return {
    summary: { score, overall, strengths, weaknesses, advice, hire: '待定' },
    source: 'rule',
  };
}

// ---------------------------------------------------------------------------
// 面试记录
// ---------------------------------------------------------------------------
app.get('/api/records', (req, res) => {
  const items = [];
  let files = [];
  try { files = fs.readdirSync(RECORDS_DIR); } catch (e) { /* ignore */ }
  for (const fn of files) {
    if (!fn.endsWith('.json')) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(RECORDS_DIR, fn), 'utf-8'));
      const meta = rec.meta || {};
      const summary = rec.summary || {};
      items.push({
        id: rec.id,
        created_at: rec.created_at || '',
        duration_min: rec.duration_min || 0,
        company: meta.company || '',
        job_title: meta.job_title || '',
        interviewer: meta.interviewer || '',
        rounds: (rec.history || []).filter((m) => m.role === 'user').length,
        llm_used: Boolean(meta.llm_used),
        score: summary.score != null ? summary.score : null,
        hire: summary.hire || '',
      });
    } catch (e) { /* skip broken files */ }
  }
  items.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  res.json(items);
});

app.post('/api/records', (req, res) => {
  const body = req.body || {};
  const rid = body.id || crypto.randomBytes(6).toString('hex');
  body.id = rid;
  body.created_at = body.created_at || new Date().toLocaleString('zh-CN', { hour12: false });
  const p = recordPath(rid);
  if (!p) return res.status(400).json({ error: '非法 ID' });
  fs.writeFileSync(p, JSON.stringify(body, null, 2), 'utf-8');
  res.json({ ok: true, id: rid });
});

app.get('/api/records/:rid', (req, res) => {
  const p = recordPath(req.params.rid);
  if (!p || !fs.existsSync(p)) return res.status(404).json({ error: '记录不存在' });
  res.json(JSON.parse(fs.readFileSync(p, 'utf-8')));
});

app.delete('/api/records/:rid', (req, res) => {
  const p = recordPath(req.params.rid);
  if (p && fs.existsSync(p)) fs.unlinkSync(p);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// 启动/停止（可被 Electron 内嵌，也可命令行直接运行）
// ---------------------------------------------------------------------------
let _httpServer = null;
let _wss = null;

function startServer(port = PORT) {
  return new Promise((resolve, reject) => {
    _httpServer = app.listen(port, '127.0.0.1', () => {
      const actual = _httpServer.address().port;
      _wss = new WebSocketServer({ server: _httpServer, path: '/ws' });
      _wss.on('connection', (ws) => handleRealtimeWs(ws));
      console.log('='.repeat(52));
      console.log('  语音面试助手已启动');
      console.log(`  请在浏览器中打开: http://127.0.0.1:${actual}`);
      console.log('  按 Ctrl+C 停止服务');
      console.log('='.repeat(52));
      // 尝试拉起本地语音服务（后台，不阻塞）
      ensureSpeechService().then((level) => {
        console.log(`[speech] 本地语音服务状态: ${level}`);
        if (level === 'not-installed') {
          console.log('[speech] 未检测到语音服务。实时语音模式需要先运行 setup_speech.bat 安装。');
          console.log('[speech] 不安装也能用「手动模式」（按键说话/打字）继续面试。');
        }
      });
      resolve(actual);
    });
    _httpServer.on('error', (err) => reject(err));
  });
}

function stopServer() {
  try { if (_wss) _wss.close(); } catch (e) { /* ignore */ }
  try { if (_httpServer) _httpServer.close(); } catch (e) { /* ignore */ }
  _wss = null;
  _httpServer = null;
}

function stopSpeechService() {
  try {
    if (speechProc && typeof speechProc.kill === 'function') speechProc.kill();
  } catch (e) { /* ignore */ }
  speechProc = null;
}

if (require.main === module) {
  startServer().catch((e) => {
    console.error('[server] 启动失败:', e.message);
    process.exit(1);
  });
}

module.exports = { app, startServer, stopServer, stopSpeechService };
