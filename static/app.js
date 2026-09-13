'use strict';

/* =========================================================
 * 语音面试助手 前端逻辑
 * ========================================================= */

// ---------- 音色库 (edge-tts 中文音色) ----------
const VOICES = [
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 女声 · 温暖亲切' },
  { id: 'zh-CN-XiaoyiNeural', label: '晓伊 · 女声 · 活泼元气' },
  { id: 'zh-CN-YunxiNeural', label: '云希 · 男声 · 阳光自然' },
  { id: 'zh-CN-YunjianNeural', label: '云健 · 男声 · 沉稳专业' },
  { id: 'zh-CN-YunyangNeural', label: '云扬 · 男声 · 新闻播报' },
  { id: 'zh-CN-XiaochenNeural', label: '晓辰 · 女声 · 温柔轻声' },
  { id: 'zh-CN-XiaohanNeural', label: '晓涵 · 女声 · 甜美' },
  { id: 'zh-CN-XiaomoNeural', label: '晓墨 · 女声 · 知性' },
  { id: 'zh-CN-XiaoruiNeural', label: '晓睿 · 女声 · 清亮' },
  { id: 'zh-CN-XiaoshuangNeural', label: '晓双 · 女声 · 童声' },
  { id: 'zh-CN-XiaoxuanNeural', label: '晓萱 · 女声 · 温柔' },
  { id: 'zh-CN-XiaoyanNeural', label: '晓颜 · 女声 · 典雅' },
  { id: 'zh-CN-XiaoyouNeural', label: '晓悠 · 女声 · 童年' },
  { id: 'zh-CN-XiaozhenNeural', label: '晓甄 · 女声 · 认真' },
  { id: 'zh-CN-YunfengNeural', label: '云枫 · 男声 · 磁性' },
  { id: 'zh-CN-YunhaoNeural', label: '云皓 · 男声 · 阳光' },
  { id: 'zh-CN-YunyeNeural', label: '云野 · 男声 · 清澈' },
  { id: 'zh-CN-liaoning-XiaobeiNeural', label: '晓北 · 女声 · 东北' },
  { id: 'zh-CN-shaanxi-XiaoniNeural', label: '晓妮 · 女声 · 陕西' },
];
const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';

const SNAP_KEY = 'vox_interview_snapshot';
const $ = (id) => document.getElementById(id);

// ---------- 全部状态 ----------
let state = {
  config: null,   // 冻结的配置快照 (开始后不可改)
  started: false,
  ended: false,
  history: [],    // [{role:'user'|'assistant', content, at}]
  summary: null,
  recordId: null,
  pending: false, // 正在等待面试官回复
};

let rec = null;          // SpeechRecognition 实例
let recFinal = '';
let recInterim = '';
let recSilenceTimer = null;
let recActive = false;

let mediaStream = null;
let mediaRec = null;
let mediaChunks = [];
let thirdActive = false;

let currentAudio = null;
let currentBubble = null;
let toastTimer = null;
let resumeParsed = '';   // 解析后的简历文本（面试配置面板）

// ---------- 实时语音模式状态 ----------
const rt = {
  ws: null,        // 浏览器 -> Node 的 WS
  ctx: null,       // AudioContext
  stream: null,    // 麦克风流
  node: null,      // AudioWorkletNode
  active: false,   // 实时引擎是否运行
  speaking: false, // 用户正在说话 (VAD)
  queue: [],       // 说话时待处理的续说文本 (LLM 忙时排队)
  service: null,   // /api/speech/status 缓存
};

// =========================================================
// 初始化
// =========================================================
function init() {
  fillVoices();
  bindEvents();
  bindResume();
  bindRef();
  setupTtsVisible();
  setupSttVisible();
  initLlmControls();
  initSpeechStatus();
  const snap = loadSnapshot();
  if (snap && snap.started && !snap.ended) {
    $('resumeBar').hidden = false;
  }
}

// ---------- 面试参考资料：上传 → 逐份解析 → 合并预览 ----------
let refParsed = '';   // 各份资料合并后的文本

function bindRef() {
  $('inRef').addEventListener('change', handleRefFiles);
  $('btnClearRef').addEventListener('click', () => {
    refParsed = '';
    $('inRef').value = '';
    $('refPreview').value = '';
    $('refStatus').textContent = '';
    $('refStatus').style.color = '';
    $('btnClearRef').hidden = true;
  });
  // 文本区默认可编辑：直接粘贴/输入即作为参考资料；上传解析则自动填充
  $('refPreview').addEventListener('input', () => {
    refParsed = $('refPreview').value;
  });
}

async function handleRefFiles() {
  const files = Array.from($('inRef').files || []);
  if (!files.length) return;
  const st = $('refStatus');
  const parts = [];
  let okCount = 0;
  for (const f of files) {
    st.textContent = '正在解析 ' + f.name + ' …';
    st.style.color = '';
    try {
      const fd = new FormData();
      fd.append('file', f);
      const r = await fetch('/api/resume', { method: 'POST', body: fd });
      const d = await r.json();
      if (!r.ok || !d.ok || d.text == null) {
        parts.push('【' + f.name + '】（解析失败：' + (d.error || '不支持该格式') + '）');
        continue;
      }
      okCount++;
      parts.push('【' + f.name + '】\n' + d.text);
    } catch (e) {
      parts.push('【' + f.name + '】（解析失败：' + e.message + '）');
    }
  }
  refParsed = parts.join('\n\n');
  $('refPreview').value = refParsed;
  $('btnClearRef').hidden = false;
  st.style.color = okCount === files.length ? 'var(--ok)' : 'var(--danger)';
  st.textContent = okCount
    ? '✅ 已解析 ' + okCount + '/' + files.length + ' 份资料，共 ' + refParsed.length + ' 字（可在下方预览 / 修正）'
    : '❌ 全部解析失败';
}

// ---------- 简历上传与解析 ----------
function bindResume() {
  $('inResume').addEventListener('change', handleResumeFile);
  $('btnClearResume').addEventListener('click', () => {
    resumeParsed = '';
    $('inResume').value = '';
    $('resumePreview').value = '';
    $('resumeStatus').textContent = '';
    $('resumeStatus').style.color = '';
    $('btnClearResume').hidden = true;
  });
  // 文本区默认可编辑：直接粘贴/输入即作为简历；上传解析则自动填充
  $('resumePreview').addEventListener('input', () => {
    resumeParsed = $('resumePreview').value;
  });
}

async function handleResumeFile() {
  const f = $('inResume').files[0];
  if (!f) return;
  const st = $('resumeStatus');
  st.textContent = '正在解析 ' + f.name + ' …';
  st.style.color = '';
  try {
    const fd = new FormData();
    fd.append('file', f);
    const r = await fetch('/api/resume', { method: 'POST', body: fd });
    const d = await r.json();
    if (!r.ok || !d.ok || d.text == null) {
      st.textContent = '❌ ' + (d.error || '解析失败，请换一种格式');
      st.style.color = 'var(--danger)';
      return;
    }
    resumeParsed = d.text;
    $('resumePreview').value = d.text;
    $('btnClearResume').hidden = false;
    st.textContent = '✅ 已解析 ' + f.name + '，共 ' + d.chars + ' 字（可在下方预览 / 修正）';
    st.style.color = 'var(--ok)';
  } catch (e) {
    st.textContent = '❌ 解析失败：' + e.message;
    st.style.color = 'var(--danger)';
  }
}

// ---------- 大模型接入 ----------
const LLM_PROVIDERS = {
  minimax:    { baseUrl: 'https://api.minimax.cn/v1', model: 'MiniMax-M3' },
  deepseek:   { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  openai:     { baseUrl: 'https://api.openai.com/v1',   model: 'gpt-4o-mini' },
  moonshot:   { baseUrl: 'https://api.moonshot.cn/v1',  model: 'moonshot-v1-8k' },
  qwen:       { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  siliconflow:{ baseUrl: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3' },
};

function initLlmControls() {
  $('selLlmProvider').addEventListener('change', () => {
    const p = LLM_PROVIDERS[$('selLlmProvider').value];
    if (p) {
      $('inLlmUrl').value = p.baseUrl;
      $('inLlmModel').value = p.model;
    }
    updateLlmStatus();
  });
  ['inLlmKey', 'inLlmUrl', 'inLlmModel'].forEach((id) => {
    $(id).addEventListener('input', updateLlmStatus);
  });
  $('inSens').addEventListener('input', () => {
    const v = Number($('inSens').value);
    $('valSens').textContent = v <= 3 ? '灵敏(' + v + ')' : (v <= 7 ? '中等(' + v + ')' : '保守(' + v + ')');
  });
  $('btnTestLlm').addEventListener('click', testLlmConnection);
  updateLlmStatus();
}

/** 测试大模型连通性（走本地后端代理请求，Key 不发给第三方以外的任何人） */
async function testLlmConnection() {
  const btn = $('btnTestLlm');
  const el = $('llmStatus');
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = '测试中…';
  el.textContent = '正在测试连接…';
  el.style.color = '';
  try {
    const r = await fetch('/api/llm/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseUrl: $('inLlmUrl').value.trim(),
        apiKey: $('inLlmKey').value.trim(),
        model: $('inLlmModel').value.trim(),
        disableThinking: $('inDisableThinking').checked,
      }),
    });
    const d = await r.json();
    if (d.ok) {
      el.textContent = '✅ 连接成功（' + d.latency + 'ms）· 模型回复：' + (d.reply || d.model || '正常');
      el.style.color = 'var(--ok)';
    } else {
      el.textContent = '❌ 连接失败（' + (d.latency ?? '?') + 'ms）：' + (d.error || '未知错误');
      el.style.color = 'var(--danger)';
    }
  } catch (e) {
    el.textContent = '❌ 测试失败：' + e.message;
    el.style.color = 'var(--danger)';
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

function updateLlmStatus() {
  const key = $('inLlmKey').value.trim();
  const el = $('llmStatus');
  if (key) {
    const name = $('selLlmProvider').value || ($('inLlmUrl').value.match(/\/([^/]+)\/?$/)?.[1] || '自定义');
    el.textContent = '当前：已接入大模型「' + name + '」（模型 ' + ($('inLlmModel').value || '未填') + '）';
    el.style.color = 'var(--ok)';
  } else {
    el.textContent = '当前：内置提问脚本（未配置 Token，填上 API Key 即自动接入 AI）';
    el.style.color = '';
  }
}

function llmLabel() {
  const key = state.config.llm.apiKey;
  if (!key) return '内置脚本';
  const name = $('selLlmProvider').value || 'LLM';
  return 'AI·' + name;
}

/** 查询本地语音服务状态，驱动「实时/手动」提示条 */
async function initSpeechStatus() {
  const banner = $('speechBanner');
  try {
    const st = await fetch('/api/speech/status').then((r) => r.json());
    rt.service = st;
    if (st.level === 'running' && st.service && st.service.vad) {
      banner.textContent = '✅ 实时语音服务已就绪（本地 VAD + SmartTurn 判停 + SenseVoice 识别）';
      banner.className = 'hint speech-banner show ok';
    } else if (st.level === 'not-installed') {
      banner.textContent = '⚠️ 未安装实时语音服务。选「实时语音」需先运行 setup_speech.bat（一键安装本地识别），否则请留在「手动模式」。';
      banner.className = 'hint speech-banner show';
    } else if (st.level === 'starting' || st.level === 'stopped') {
      banner.textContent = '⏳ 实时语音服务启动中…（首次会自动下载模型）';
      banner.className = 'hint speech-banner show';
    }
  } catch (e) { /* 服务端不可达则忽略 */ }
}

function fillVoices() {
  const sel = $('inVoice');
  VOICES.forEach((v) => {
    const o = document.createElement('option');
    o.value = v.id;
    o.textContent = v.label;
    sel.appendChild(o);
  });
  sel.value = DEFAULT_VOICE;
}

function bindEvents() {
  $('tabInterview').addEventListener('click', () => switchTab('interview'));
  $('tabRecords').addEventListener('click', () => switchTab('records'));

  $('btnStart').addEventListener('click', startInterview);
  $('btnEnd').addEventListener('click', endInterview);
  $('btnPreview').addEventListener('click', previewVoice);
  $('btnMic').addEventListener('click', toggleRecording);
  $('btnSend').addEventListener('click', onSendClick);
  $('txtInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSendClick(); }
  });
  $('inRate').addEventListener('input', () => { $('valRate').textContent = $('inRate').value + '%'; });
  $('inPitch').addEventListener('input', () => { $('valPitch').textContent = $('inPitch').value + 'Hz'; });

  $('selTts').addEventListener('change', setupTtsVisible);
  $('selStt').addEventListener('change', setupSttVisible);

  $('btnResume').addEventListener('click', resumeInterview);
  $('btnDiscard').addEventListener('click', discardSnapshot);
  $('btnRefreshRecords').addEventListener('click', refreshRecords);

  $('btnCloseSummary').addEventListener('click', closeSummary);
  $('btnCloseSummary2').addEventListener('click', closeSummary);
  $('btnExport').addEventListener('click', exportCurrentRecord);
  $('btnCloseDetail').addEventListener('click', () => { $('detailModal').hidden = true; });
}

// =========================================================
// 工具
// =========================================================
function now() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
}

function scrollToBottom() {
  const log = $('chatLog');
  log.scrollTop = log.scrollHeight;
}

function switchTab(name) {
  const showInterview = name === 'interview';
  $('view-interview').hidden = !showInterview;
  $('view-records').hidden = showInterview;
  $('tabInterview').classList.toggle('active', showInterview);
  $('tabRecords').classList.toggle('active', !showInterview);
  if (!showInterview) refreshRecords();
}

function downloadJSON(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- 配置 ----------
function setupTtsVisible() {
  $('ttsThird').hidden = $('selTts').value !== 'third';
}
function setupSttVisible() {
  $('sttThird').hidden = $('selStt').value !== 'third';
}

function gatherConfig() {
  const voice = $('inVoiceCustom').value.trim() || $('inVoice').value;
  const tts = {
    provider: $('selTts').value,
    voice,
    voice3rd: $('inTtsVoice').value.trim() || 'alloy',
    rate: ($('inRate').value > 0 ? '+' : '') + $('inRate').value + '%',
    pitch: ($('inPitch').value > 0 ? '+' : '') + $('inPitch').value + 'Hz',
    baseUrl: $('inTtsUrl').value.trim(),
    apiKey: $('inTtsKey').value.trim(),
    model: $('inTtsModel').value.trim() || 'tts-1',
  };
  return {
    profile: {
      name: $('inName').value.trim() || '面试官',
      title: $('inTitle').value.trim() || '面试官',
      persona: $('inPersona').value.trim(),
      style: $('inStyle').value,
    },
    job: {
      company: $('inCompany').value.trim(),
      title: $('inJobTitle').value.trim(),
      jd: $('inJd').value.trim(),
      focus: $('inFocus').value.trim(),
    },
    llm: {
      baseUrl: $('inLlmUrl').value.trim(),
      apiKey: $('inLlmKey').value.trim(),
      model: $('inLlmModel').value.trim(),
      disableThinking: $('inDisableThinking').checked,
    },
    tts,
    stt: {
      mode: $('selStt').value,
      baseUrl: $('inSttUrl').value.trim(),
      apiKey: $('inSttKey').value.trim(),
      model: $('inSttModel').value.trim(),
    },
    mode: $('selMode').value,           // realtime | manual
    bargeIn: $('inBargeIn').checked,    // 说话时打断面试官播报
    enableInterim: $('inInterim').checked,
    sens: Number($('inSens').value),    // 判停灵敏度 1~10
    resumeText: resumeParsed.trim(),    // 简历（解析+手动修正后的文本）
    refText: refParsed.trim(),          // 面试参考资料（合并文本）
  };
}

/** 灵敏度(1~10) → 判停参数 */
function sensParams(s) {
  s = Math.max(1, Math.min(10, s || 7));
  return {
    vad_min_silence_ms: 100 + (s - 1) * 55,                  // 100 ~ 595
    smart_threshold: Math.min(0.9, 0.55 + (s - 1) * 0.04),   // 0.55 ~ 0.91
    smart_max_wait_ms: 1800 + (s - 1) * 400,                 // 1.8s ~ 5.4s
    short_wait_ms: 900 + (s - 1) * 120,                      // 0.9s ~ 2.0s
    grace_ms: 400 + (s - 1) * 90,                            // 0.4s ~ 1.2s (重开宽限)
  };
}

// ---------- 快照 (刷新恢复) ----------
function saveSnapshot() {
  if (!state.started) return;
  try { localStorage.setItem(SNAP_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
}

function loadSnapshot() {
  try {
    const raw = localStorage.getItem(SNAP_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

function clearSnapshot() {
  try { localStorage.removeItem(SNAP_KEY); } catch (e) { /* ignore */ }
}

function resumeInterview() {
  const snap = loadSnapshot();
  if (!snap) return;
  state = snap;
  state.pending = false;
  $('resumeBar').hidden = true;
  lockSetup();
  $('chatMeta').textContent = `面试官 ${state.config.profile.name} · ${state.config.job.company || ''} ${state.config.job.title} · 🧠 ${llmLabel()}${state.mode === 'realtime' ? ' · 实时语音' : ''}`;
  statusPill('live', '面试中');
  enableInputs(true);
  renderChat();
  saveSnapshot();
  if (state.mode === 'realtime') {
    setMicRealtime(true);
    startRealtime().catch((e) => {
      setMicRealtime(false);
      toast('实时语音未恢复，已切换到手动模式：' + e.message);
    });
  } else {
    setMicRealtime(false);
  }
}

function discardSnapshot() {
  clearSnapshot();
  $('resumeBar').hidden = true;
}

// =========================================================
// 面试流程
// =========================================================
function startInterview() {
  const cfg = gatherConfig();
  if (!cfg.job.title) { toast('请填写「职位名称」'); return; }
  stopAudio();
  state = {
    config: cfg,
    mode: cfg.mode,          // realtime | manual
    started: true,
    ended: false,
    history: [],
    summary: null,
    recordId: null,
    pending: false,
  };
  lockSetup();
  clearSnapshot();
  saveSnapshot();
  $('chatMeta').textContent = `面试官 ${cfg.profile.name} · ${cfg.job.company || ''} ${cfg.job.title} · 🧠 ${llmLabel()}${cfg.mode === 'realtime' ? ' · 实时语音' : ''}`;
  statusPill('live', '面试中');
  enableInputs(true);
  if (cfg.mode === 'realtime') {
    setMicRealtime(true);
    startRealtime().catch((e) => {
      setMicRealtime(false);
      state.mode = 'manual';
      toast('实时语音启动失败，已切换到手动模式（按键说话 / 打字）：' + e.message);
    });
  } else {
    setMicRealtime(false);
  }
  renderChat();
  requestReply(); // 开场白
}

// 配置锁定: 开始后不可更改
function lockSetup() {
  $('setupPanel').classList.add('locked');
  $('lockHint').textContent = '🔒 已锁定 · 本场不可更改';
  $('btnStart').hidden = true;
}

// 面试结束后解锁, 允许修改配置并发起新一轮
function unlockSetup() {
  $('setupPanel').classList.remove('locked');
  $('lockHint').textContent = '';
  $('btnStart').hidden = false;
}

function enableInputs(on) {
  $('btnMic').disabled = !on;
  $('txtInput').disabled = !on;
  $('btnSend').disabled = !on;
  $('btnEnd').disabled = !on;
}

function statusPill(cls, txt) {
  const p = $('statusPill');
  p.className = 'pill' + (cls ? ' ' + cls : '');
  p.textContent = txt;
}

function setPending(v) {
  state.pending = v;
  $('btnSend').disabled = v || state.ended;
  $('btnMic').disabled = v || state.ended;
  $('txtInput').disabled = v || state.ended;
}

// ---------- 对话 ----------
async function askInterviewer() {
  const body = {
    profile: state.config.profile,
    job: state.config.job,
    llm: state.config.llm,
    history: state.history.map((m) => ({ role: m.role, content: m.content })),
    resume: state.config.resumeText || '',
    reference: state.config.refText || '',
  };
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.reply) throw new Error(data.error || '获取面试官回复失败');
  return data.reply;
}

async function requestReply() {
  if (state.pending || state.ended) return;
  setPending(true);
  const tipEl = addTypingBubble();
  try {
    const reply = await askInterviewer();
    tipEl.remove();
    state.history.push({ role: 'assistant', content: reply, at: now() });
    const bubbleEl = addMessage(state.history[state.history.length - 1]);
    const isOpening = state.history.length === 1; // 开场白：第一条消息只展示不朗读
    if (!isOpening && (state.mode !== 'realtime' || !rt.speaking)) {
      speak(reply, bubbleEl);
    } else if (isOpening) {
      // 开场白直接展示，不自动播报（可点击气泡「播放」手动收听）
    } else {
      toast('您正在说话，面试官语音回复已暂停（可点击气泡播放）');
    }
  } catch (e) {
    tipEl.remove();
    addSystemError(e.message);
  } finally {
    setPending(false);
    saveSnapshot();
    // 处理排队中的用户话轮
    const next = rt.queue.shift();
    if (next) submitUserText(next, 'voice');
  }
}

/** 提交一句用户文本。面试官忙时先排队，忙完再依次处理（连续说话不丢话轮）。 */
function submitUserText(text, source) {
  if (!state.started || state.ended) return;
  text = (text || '').trim();
  if (!text) return;
  if (state.pending) { rt.queue.push(text); return; }
  state.history.push({ role: 'user', content: text, at: now() });
  addMessage(state.history[state.history.length - 1]);
  $('txtInput').value = '';
  scrollToBottom();
  saveSnapshot();
  requestReply();
}

function sendCandidate(text) {
  submitUserText(text, 'text');
}

function onSendClick() {
  sendCandidate($('txtInput').value);
}

// =========================================================
// 消息渲染
// =========================================================
function renderChat() {
  const log = $('chatLog');
  log.innerHTML = '';
  if (state.history.length === 0 && state.started && !state.ended) {
    addSystemLine('面试即将开始…');
  }
  state.history.forEach((m) => addMessage(m));
  scrollToBottom();
}

function addSystemLine(text) {
  const log = $('chatLog');
  const d = document.createElement('div');
  d.className = 'bubble-col system-line';
  d.style.cssText = 'align-items:center;';
  const b = document.createElement('div');
  b.style.cssText = 'color:var(--muted);font-size:12.5px;background:#f7f9fc;border-radius:10px;padding:5px 14px;';
  b.textContent = text;
  d.appendChild(b);
  log.appendChild(d);
  scrollToBottom();
}

function addMessage(m) {
  const log = $('chatLog');
  const isUser = m.role === 'user';

  const row = document.createElement('div');
  row.className = 'msg-row' + (isUser ? ' right' : '');

  const av = document.createElement('div');
  av.className = 'avatar';
  av.textContent = isUser ? '我' : (state.config.profile.name || '官').slice(0, 1);

  const col = document.createElement('div');
  col.className = 'bubble-col';

  const meta = document.createElement('div');
  meta.className = 'bubble-meta';
  meta.textContent = (isUser ? '你' : state.config.profile.name) + ' · ' + (m.at || '');

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = m.content;

  col.appendChild(meta);
  col.appendChild(bubble);

  if (!isUser) {
    const acts = document.createElement('div');
    acts.className = 'bubble-actions';
    const playBtn = document.createElement('button');
    playBtn.className = 'btn small';
    playBtn.textContent = '🔊 播放';
    playBtn.addEventListener('click', () => {
      if (currentBubble === bubble && currentAudio && !currentAudio.paused) stopAudio();
      else playMessage(m.content, bubble);
    });
    acts.appendChild(playBtn);
    col.appendChild(acts);
  }

  row.appendChild(av);
  row.appendChild(col);
  log.appendChild(row);
  scrollToBottom();
  return bubble;
}

function addTypingBubble() {
  const log = $('chatLog');
  const row = document.createElement('div');
  row.className = 'msg-row';
  const av = document.createElement('div');
  av.className = 'avatar';
  av.textContent = (state.config.profile.name || '官').slice(0, 1);
  const col = document.createElement('div');
  col.className = 'bubble-col';
  const bubble = document.createElement('div');
  bubble.className = 'bubble typing-bubble';
  for (let i = 0; i < 3; i++) bubble.appendChild(document.createElement('i'));
  col.appendChild(bubble);
  row.appendChild(av);
  row.appendChild(col);
  log.appendChild(row);
  scrollToBottom();
  return row; // 返回整行, 移除时连头像一起删掉
}

function addSystemError(msg) {
  const log = $('chatLog');
  const d = document.createElement('div');
  d.className = 'bubble-col';
  const b = document.createElement('div');
  b.className = 'bubble bubble-error';
  b.textContent = '⚠️ ' + msg;
  const retry = document.createElement('button');
  retry.className = 'btn small';
  retry.style.marginTop = '6px';
  retry.textContent = '🔄 重试';
  retry.addEventListener('click', () => { b.remove(); requestReply(); });
  d.appendChild(b);
  d.appendChild(retry);
  log.appendChild(d);
  scrollToBottom();
}

// =========================================================
// TTS 播放
// =========================================================
async function fetchTts(text, override) {
  const t = override || state.config.tts;
  const body = {
    text,
    provider: t.provider,
    voice: t.voice,
    voice3rd: t.voice3rd,
    rate: t.rate,
    pitch: t.pitch,
    baseUrl: t.baseUrl,
    apiKey: t.apiKey,
    model: t.model,
  };
  const res = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || '语音生成失败');
  }
  return URL.createObjectURL(await res.blob());
}

async function speak(text, bubbleEl, ttsOverride) {
  stopAudio();
  if (bubbleEl) {
    currentBubble = bubbleEl;
    bubbleEl.classList.add('speaking');
    addEq(bubbleEl);
  }
  try {
    const url = await fetchTts(text, ttsOverride);
    if (currentBubble && currentBubble !== bubbleEl) { URL.revokeObjectURL(url); return; }
    const audio = new Audio(url);
    currentAudio = audio;
    audio.onended = () => clearSpeaking();
    audio.onerror = () => { if (currentAudio === audio) { toast('语音播放失败'); clearSpeaking(); } };
    audio.play().catch(() => {
      toast('浏览器拦截了自动播放，请点击消息旁的「播放」按钮收听');
      clearSpeaking();
    });
  } catch (e) {
    toast(e.message + '（可正常阅读文字继续面试）');
    clearSpeaking();
  }
}

function addEq(bubble) {
  const eq = document.createElement('span');
  eq.className = 'speak-eq';
  for (let i = 0; i < 4; i++) eq.appendChild(document.createElement('i'));
  // 插到气泡文本前面
  bubble.prepend(eq);
  bubble._eq = eq;
}

function playMessage(content, bubbleEl) {
  speak(content, bubbleEl);
}

function stopAudio() {
  if (currentAudio) {
    try { currentAudio.pause(); } catch (e) { /* ignore */ }
    currentAudio = null;
  }
  clearSpeaking();
}

function clearSpeaking() {
  if (currentBubble) {
    currentBubble.classList.remove('speaking');
    if (currentBubble._eq) currentBubble._eq.remove();
    currentBubble._eq = null;
  }
  currentBubble = null;
}

function previewVoice() {
  const cfg = gatherConfig();
  speak('你好，我是本次面试的面试官，欢迎参加面试。', null, cfg.tts);
  toast('正在试听音色…');
}

// =========================================================
// 语音识别 (STT)
// =========================================================
function toggleRecording() {
  if (state.ended || state.pending) return;
  if (rt.active) return; // 实时模式下麦克风常开，无需按键
  if (state.config.stt.mode === 'third') {
    if (thirdActive) stopThirdRecording(); else startThirdRecording();
    return;
  }
  if (recActive) { stopBrowserRecording(); return; }
  startBrowserRecording();
}

function getRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const r = new SR();
  r.lang = 'zh-CN';
  r.continuous = true;
  r.interimResults = true;
  r.onresult = onRecResult;
  r.onend = onRecEnd;
  r.onerror = onRecError;
  return r;
}

function startBrowserRecording() {
  if (!(window.SpeechRecognition || window.webkitSpeechRecognition)) {
    toast('当前浏览器不支持语音识别，请使用文字输入，或在配置中改用第三方接口');
    return;
  }
  // 清掉可能还残留的底层会话（有的内核 stop() 不生效，导致 start() 报 already started）
  if (rec) { try { rec.abort(); } catch (e) { /* ignore */ } }
  rec = getRecognition();
  recFinal = '';
  recInterim = '';
  recActive = true;
  setMicRec(true);
  showLive('正在聆听…');
  try {
    rec.start();
  } catch (e) {
    // 极端情况下仍在运行：再清一次并新建重试
    try { rec.abort(); } catch (e2) { /* ignore */ }
    rec = getRecognition();
    try { rec.start(); } catch (e2) {
      recActive = false;
      setMicRec(false);
      hideLive();
      toast('语音识别启动失败: ' + (e2.message || e.message));
    }
  }
}

function onRecResult(e) {
  recInterim = '';
  let finalNow = '';
  for (let i = 0; i < e.results.length; i++) {
    const r = e.results[i];
    if (r.isFinal) { finalNow += r.transcript; recFinal += r.transcript; }
    else recInterim += r.transcript;
  }
  const shown = (recInterim + finalNow).trim();
  if (shown) showLive('正在聆听：' + shown);
  // 静音自动提交
  clearTimeout(recSilenceTimer);
  recSilenceTimer = setTimeout(() => {
    if (recActive) finalizeBrowserRecording();
  }, 4000);
}

function onRecEnd() {
  clearTimeout(recSilenceTimer);
  if (!recActive) return; // 已由结束流程处理
  finalizeBrowserRecording();
}

function onRecError(e) {
  if (e.error === 'no-speech') {
    // 有的内核只报 no-speech 而不触发 onEnd：按"没识别到"结束本轮
    finalizeBrowserRecording();
    return;
  }
  if (e.error === 'aborted' || e.error === 'canceled' || e.error === 'cancelled') {
    // 主动 abort 触发的正常回调，静默复位即可
    recActive = false;
    clearTimeout(recSilenceTimer);
    setMicRec(false);
    hideLive();
    return;
  }
  recActive = false;
  clearTimeout(recSilenceTimer);
  setMicRec(false);
  hideLive();
  toast('语音识别错误: ' + (e.error || e.message || '未知'));
}

/**
 * 统一的"结束本轮录音"：无论手动停止还是静音自动停止都走这里。
 * 不再依赖 onend：立即复位 UI，稍候提交已识别文本，最后再 abort()
 * 强制终止底层会话（保证下一次 start() 一定能再次启动）。
 */
function finalizeBrowserRecording() {
  if (!recActive) return;
  recActive = false;
  clearTimeout(recSilenceTimer);
  setMicRec(false);
  hideLive();
  setTimeout(() => {
    const text = (recFinal || '').trim();
    if (text) {
      showLive('识别完成，正在发送…');
      setTimeout(() => { hideLive(); submitUserText(text, 'voice'); }, 350);
    } else {
      hideLive();
      toast('没有识别到内容，请再试一次');
    }
    try { if (rec) rec.abort(); } catch (e) { /* ignore */ }
  }, 450);
}

function stopBrowserRecording() {
  finalizeBrowserRecording();
}

function setMicRec(on) {
  const btn = $('btnMic');
  btn.classList.toggle('rec', on);
  btn.textContent = on ? '⏹ 停止' : '🎤 说话';
}

function showLive(txt) {
  $('liveText').textContent = txt;
  $('liveBar').hidden = false;
}
function hideLive() {
  $('liveBar').hidden = true;
}

// ---------- 第三方 ASR ----------
async function startThirdRecording() {
  const cfg = state.config.stt;
  if (!cfg.baseUrl || !cfg.apiKey) { toast('请先在配置中填写第三方 ASR 的接口地址和 Token'); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast('当前浏览器不支持麦克风录音'); return; }
  if (currentAudio) stopAudio(); // 先停掉播报, 避免录到面试官声音
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    toast('无法访问麦克风: ' + (e.message || e.name));
    return;
  }
  mediaChunks = [];
  thirdActive = true;
  setMicRec(true);
  showLive('录音中… 说完请点「停止」');
  try {
    mediaRec = new MediaRecorder(mediaStream);
  } catch (e) {
    thirdActive = false;
    setMicRec(false);
    hideLive();
    mediaStream.getTracks().forEach((t) => t.stop());
    toast('当前浏览器不支持 MediaRecorder');
    return;
  }
  mediaRec.ondataavailable = (e) => { if (e.data.size) mediaChunks.push(e.data); };
  mediaRec.onstop = onThirdStop;
  mediaRec.start();
}

function stopThirdRecording() {
  if (mediaRec && mediaRec.state !== 'inactive') mediaRec.stop();
}

async function onThirdStop() {
  thirdActive = false;
  setMicRec(false);
  if (mediaStream) { mediaStream.getTracks().forEach((t) => t.stop()); mediaStream = null; }
  if (mediaChunks.length === 0) { hideLive(); toast('没有录制到音频'); return; }

  showLive('正在识别…');
  const blob = new Blob(mediaChunks, { type: mediaRec ? mediaRec.mimeType || 'audio/webm' : 'audio/webm' });
  const fd = new FormData();
  fd.append('audio', blob, 'recording.webm');
  fd.append('baseUrl', state.config.stt.baseUrl);
  fd.append('apiKey', state.config.stt.apiKey);
  fd.append('model', state.config.stt.model);
  fd.append('language', 'zh');
  try {
    const res = await fetch('/api/stt', { method: 'POST', body: fd });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.text) {
      showLive('识别完成，正在发送…');
      setTimeout(() => { hideLive(); sendCandidate(data.text); }, 400);
    } else {
      hideLive();
      toast(data.error || '识别失败, 请重试');
    }
  } catch (e) {
    hideLive();
    toast('识别请求失败: ' + e.message);
  }
}

// =========================================================
// 实时语音模式（浏览器 → Node → 本地语音服务：VAD+SmartTurn+STT）
// =========================================================
function setMicRealtime(on) {
  const btn = $('btnMic');
  btn.disabled = on;
  btn.textContent = on ? '🎙️ 实时聆听' : '🎤 说话';
  btn.classList.toggle('rec', on);
  btn.title = on ? '实时模式：说一段话，稍作停顿即自动转写' : '';
}

function onRtEvent(ev) {
  let j;
  try { j = JSON.parse(ev.data); } catch (e) { return; }
  switch (j.type) {
    case 'level':
      if (state.started && !state.ended) {
        $('levelFill').style.width = Math.min(100, Math.max(2, j.v * 220)) + '%';
      }
      break;
    case 'speech_start':
      rt.speaking = true;
      showLive('正在聆听…');
      if (state.config.bargeIn) {
        stopAudio(); // 插话立即打断面试官播报
      }
      break;
    case 'speech_end':
      showLive('正在转写…');
      break;
    case 'interim':
      if (j.text) $('liveText').textContent = '（预览）' + j.text;
      break;
    case 'turn_complete': {
      hideLive();
      rt.speaking = false;
      const text = (j.text || '').trim();
      if (text) submitUserText(text, 'voice');
      break;
    }
    case 'error':
      hideLive();
      toast('实时语音：' + (j.message || '错误'));
      if (j.code === 'SPEECH_LINK_DOWN' || j.code === 'SPEECH_UNAVAILABLE') {
        stopRealtime();
        if (state.started && !state.ended) {
          setMicRealtime(false);
          toast('已回退到手动模式（按键说话 / 打字）');
        }
      }
      break;
  }
}

async function startRealtime() {
  if (rt.active) return;
  // 1) 本地语音服务
  let st = rt.service;
  if (!st) st = await fetch('/api/speech/status').then((r) => r.json());
  rt.service = st;
  if (!st || st.level !== 'running') {
    throw new Error(st && st.level === 'not-installed'
      ? '本地语音服务未安装，请先运行 setup_speech.bat'
      : '本地语音服务未就绪，请稍候或运行 setup_speech.bat');
  }
  // 2) 麦克风 + AudioWorklet
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('浏览器不支持麦克风录音，请用 Chrome/Edge');
  }
  rt.stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
  });
  const AC = window.AudioContext || window.webkitAudioContext;
  rt.ctx = new AC();
  await rt.ctx.audioWorklet.addModule('/static/recorder-worklet.js');
  rt.node = new AudioWorkletNode(rt.ctx, 'recorder-worklet');
  rt.ctx.createMediaStreamSource(rt.stream).connect(rt.node);
  rt.node.port.onmessage = (e) => {
    if (rt.ws && rt.ws.readyState === 1) rt.ws.send(e.data.buffer);
  };
  // 3) WS 中继
  rt.ws = new WebSocket('ws://' + location.host + '/ws');
  rt.ws.binaryType = 'arraybuffer';
  await new Promise((resolve, reject) => {
    rt.ws.onopen = () => resolve();
    rt.ws.onerror = () => reject(new Error('与实时服务建立连接失败'));
  });
  rt.ws.onmessage = onRtEvent;
  rt.ws.send(JSON.stringify({
    type: 'session',
    language: 'zh',
    enable_interim: !!state.config.enableInterim,
    ...sensParams(state.config.sens),
  }));
  rt.node.port.start();
  rt.active = true;
  rt.speaking = false;
  showLive('实时待命，请开始说话…');
}

function stopRealtime() {
  try { if (rt.node) rt.node.port.close(); } catch (e) { /* ignore */ }
  try { if (rt.ws) rt.ws.close(); } catch (e) { /* ignore */ }
  try { if (rt.stream) rt.stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ }
  try { if (rt.ctx) rt.ctx.close(); } catch (e) { /* ignore */ }
  rt.ws = rt.ctx = rt.stream = rt.node = null;
  rt.active = false;
  rt.speaking = false;
  rt.queue = [];
  hideLive();
  $('levelFill').style.width = '0%';
}

// =========================================================
// 结束面试 + 总结 + 保存
// =========================================================
async function endInterview() {
  if (state.ended) return;
  if (!window.confirm('确定结束面试并生成总结吗？结束后将锁定对话。')) return;
  if (recActive) stopBrowserRecording();
  if (thirdActive) stopThirdRecording();
  stopAudio();
  stopRealtime();
  setMicRealtime(false);

  state.ended = true;
  statusPill('done', '已结束');
  enableInputs(false);
  $('btnEnd').disabled = true;
  saveSnapshot();

  addSystemLine('面试结束，正在生成总结与建议…');
  try {
    const res = await fetch('/api/summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profile: state.config.profile,
        job: state.config.job,
        llm: state.config.llm,
        history: state.history.map((m) => ({ role: m.role, content: m.content })),
        resume: state.config.resumeText || '',
        reference: state.config.refText || '',
      }),
    });
    const data = await res.json().catch(() => ({}));
    state.summary = (data && data.summary) ? data.summary : null;
    if (!state.summary) toast('总结生成失败，可稍后重试');
  } catch (e) {
    toast('总结请求失败: ' + e.message);
  }

  try {
    await saveRecord();
    clearSnapshot();
    if (state.summary) openSummary();
    else addSystemLine('⚠️ 未能生成总结。可在「历史记录」中查看本次记录。');
  } finally {
    // 无论如何都要解锁配置区, 允许修改并发起新一轮面试
    unlockSetup();
    statusPill('', '待开始');
    addSystemLine('✅ 本次面试已结束。可在左侧修改配置，点击「开始面试」开启新的一轮。');
  }
}

function buildRecord() {
  const cfg = state.config;
  const llmInfo = cfg.llm.apiKey
    ? { baseUrl: cfg.llm.baseUrl, model: cfg.llm.model }
    : { used: false };
  return {
    id: state.recordId || undefined,
    created_at: new Date().toLocaleString('zh-CN', { hour12: false }),
    meta: {
      company: cfg.job.company,
      job_title: cfg.job.title,
      interviewer: cfg.profile.name,
      voice: cfg.tts.voice,
      tts_provider: cfg.tts.provider,
      stt_mode: cfg.stt.mode,
      llm_used: Boolean(cfg.llm.apiKey),
    },
    profile: cfg.profile,
    job: cfg.job,
    llm: llmInfo, // 不保存 apiKey
    resume: cfg.resumeText || null,
    reference: cfg.refText || null,
    history: state.history,
    summary: state.summary,
  };
}

async function saveRecord() {
  try {
    const rec = buildRecord();
    const res = await fetch('/api/records', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rec),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.id) {
      state.recordId = data.id;
      refreshRecords(true);
    } else {
      toast('记录保存失败: ' + (data.error || '未知错误'));
    }
  } catch (e) {
    toast('记录保存失败: ' + e.message);
  }
}

// =========================================================
// 总结弹窗
// =========================================================
function openSummary() {
  const s = state.summary;
  const body = $('summaryBody');
  body.innerHTML = '';

  const scoreRow = document.createElement('div');
  scoreRow.className = 'summary-score';
  const big = document.createElement('div');
  big.className = 'big-score';
  big.innerHTML = `<span>${s.score || 0}</span><small>10 分制</small>`;
  const info = document.createElement('div');
  info.style.flex = '1';
  const hire = s.hire || '待定';
  const hireBadge = document.createElement('span');
  hireBadge.className = 'hire-badge ' + (hire.includes('录用') ? 'yes' : (hire.includes('不录用') || hire.includes('不建议') ? 'no' : ''));
  hireBadge.textContent = hire;
  info.appendChild(hireBadge);
  scoreRow.appendChild(big);
  scoreRow.appendChild(info);

  const blocks = [
    ['📝 总体评价', s.overall, true],
    ['✅ 优势', s.strengths, false],
    ['⚠️ 可改进', s.weaknesses, false],
    ['💡 建议', s.advice, false],
    ['🤝 录用建议', [hire], false],
  ];
  body.appendChild(scoreRow);
  blocks.forEach(([title, content, isPara]) => {
    const div = document.createElement('div');
    div.className = 'sum-block';
    const h = document.createElement('h4');
    h.textContent = title;
    div.appendChild(h);
    if (isPara) {
      const p = document.createElement('p');
      p.textContent = content || '暂无';
      div.appendChild(p);
    } else {
      const ul = document.createElement('ul');
      (content && content.length ? content : ['暂无']).forEach((t) => {
        const li = document.createElement('li');
        li.textContent = t;
        ul.appendChild(li);
      });
      div.appendChild(ul);
    }
    body.appendChild(div);
  });

  if (!state.config.llm.apiKey) {
    const note = document.createElement('p');
    note.className = 'sum-note';
    note.textContent = '※ 本次未配置大模型 Token，总结由内置模板生成。配置 Token 后可获得更深入的评估。';
    body.appendChild(note);
  }
  $('summaryModal').hidden = false;
}

function closeSummary() {
  $('summaryModal').hidden = true;
}

function exportCurrentRecord() {
  if (!state.summary) { toast('暂无可导出的总结'); return; }
  const rec = buildRecord();
  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  downloadJSON(rec, `面试总结_${state.config.job.company || ''}_${state.config.job.title || '面试'}_${ts}.json`);
}

// =========================================================
// 历史记录
// =========================================================
async function refreshRecords(silent) {
  const list = $('recordList');
  if (!silent) list.innerHTML = '<div class="empty">加载中…</div>';
  try {
    const res = await fetch('/api/records');
    const items = await res.json();
    renderRecords(items);
  } catch (e) {
    if (!silent) list.innerHTML = '<div class="empty">加载失败: ' + e.message + '</div>';
  }
}

function renderRecords(items) {
  const list = $('recordList');
  list.innerHTML = '';
  if (!items || items.length === 0) {
    list.innerHTML = '<div class="empty">暂无记录。完成一场面试后会自动保存到这里。</div>';
    return;
  }
  items.forEach((it) => {
    const card = document.createElement('div');
    card.className = 'record-card';

    const main = document.createElement('div');
    main.className = 'record-main';
    const title = document.createElement('div');
    title.className = 'record-title';
    title.textContent = `${it.company || ''} · ${it.job_title || '未知职位'}`;
    const sub = document.createElement('div');
    sub.className = 'record-sub';
    sub.textContent = `面试官 ${it.interviewer || '—'} · ${it.created_at} · ${it.rounds ?? 0} 轮问答` + (it.llm_used ? ' · 大模型' : ' · 内置脚本');
    main.appendChild(title);
    main.appendChild(sub);

    const score = document.createElement('div');
    score.className = 'record-score';
    score.innerHTML = it.score != null ? `${it.score}<small>${it.hire || '分'}</small>` : '—<small>无总结</small>';

    const actions = document.createElement('div');
    actions.className = 'record-actions';
    const btnView = document.createElement('button');
    btnView.className = 'btn small';
    btnView.textContent = '查看';
    btnView.addEventListener('click', () => openDetail(it.id));
    const btnExport = document.createElement('button');
    btnExport.className = 'btn small';
    btnExport.textContent = '导出';
    btnExport.addEventListener('click', () => exportRecord(it.id));
    const btnDel = document.createElement('button');
    btnDel.className = 'btn small';
    btnDel.style.color = 'var(--danger)';
    btnDel.textContent = '删除';
    btnDel.addEventListener('click', () => deleteRecord(it.id));
    actions.appendChild(btnView);
    actions.appendChild(btnExport);
    actions.appendChild(btnDel);

    card.appendChild(main);
    card.appendChild(score);
    card.appendChild(actions);
    list.appendChild(card);
  });
}

async function openDetail(rid) {
  try {
    const res = await fetch('/api/records/' + rid);
    if (!res.ok) { toast('记录不存在'); return; }
    const rec = await res.json();
    renderDetail(rec);
    $('detailModal').hidden = false;
  } catch (e) {
    toast('加载记录失败: ' + e.message);
  }
}

function renderDetail(rec) {
  const body = $('detailBody');
  body.innerHTML = '';
  const meta = document.createElement('div');
  meta.className = 'detail-meta';
  const m = rec.meta || {};
  meta.textContent = `${m.company || '—'} · ${m.job_title || '—'}\n面试官：${m.interviewer || '—'} · 音色：${m.voice || '—'} · 时间：${rec.created_at || '—'}`;
  body.appendChild(meta);

  if (rec.summary) {
    const sumTitle = document.createElement('h4');
    sumTitle.textContent = `📋 总结（评分 ${rec.summary.score ?? '—'} / ${rec.summary.hire || ''}）`;
    body.appendChild(sumTitle);
    const p = document.createElement('p');
    p.style.cssText = 'font-size:13px;line-height:1.8;';
    p.textContent = rec.summary.overall || '';
    body.appendChild(p);
  }

  const h = document.createElement('h4');
  h.textContent = '💬 对话记录';
  body.appendChild(h);
  (rec.history || []).forEach((msg) => {
    const div = document.createElement('div');
    div.className = 'detail-q';
    const who = msg.role === 'user' ? '候选人' : '面试官';
    const label = document.createElement('div');
    label.className = 'q';
    label.textContent = `${who}（${msg.at || ''}）：`;
    const content = document.createElement('div');
    content.className = 'a';
    content.textContent = msg.content;
    div.appendChild(label);
    div.appendChild(content);
    body.appendChild(div);
  });
}

async function deleteRecord(rid) {
  if (!window.confirm('确定删除这条记录吗？此操作不可恢复。')) return;
  try {
    await fetch('/api/records/' + rid, { method: 'DELETE' });
    refreshRecords(true);
    toast('已删除');
  } catch (e) {
    toast('删除失败: ' + e.message);
  }
}

async function exportRecord(rid) {
  try {
    const res = await fetch('/api/records/' + rid);
    if (!res.ok) { toast('记录不存在'); return; }
    const rec = await res.json();
    const m = rec.meta || {};
    downloadJSON(rec, `面试记录_${m.company || ''}_${m.job_title || '面试'}_${rid}.json`);
  } catch (e) {
    toast('导出失败: ' + e.message);
  }
}

// =========================================================
document.addEventListener('DOMContentLoaded', init);
