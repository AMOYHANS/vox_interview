#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
实时语音服务：浏览器/Node 持续推入 16kHz 音频 → Silero VAD + SmartTurn v3.2 判停
→ SenseVoice STT 转写 → 事件推送。参考 VoxEMW / huggingface speech-to-speech。

WebSocket 协议（Node 中继，localhost:8765）
  收 text   {"type":"session","language":"zh","enable_interim":false}
  收 text   {"type":"ping"}                       -> pong + 状态
  收 text   {"type":"tts_request","text":"...","voice":"..."}   -> 可选 VoxCPM
  收 text   {"type":"voxcpm_voices"}              -> 可选 VoxCPM 音色列表
  收 binary 512 个 float32 样本（2048 字节）        -> 送入 VAD
  发 text   {"type":"ready", 状态...}
  发 text   {"type":"speech_start"} / {"type":"speech_end"}
  发 text   {"type":"level","v":0..1}             (节流)
  发 text   {"type":"interim","text"}              (可选)
  发 text   {"type":"turn_complete","text"}
  发 text   {"type":"tts_response", "audio_b64":...} 或 {"error":...}
  发 text   {"type":"error","message"}
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import json
import logging
import os
import re
import sys
import time
from pathlib import Path

import numpy as np

BASE_DIR = Path(__file__).resolve().parent
SR = 16000
FRAME = 512  # 32ms @16k

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(str(BASE_DIR / "speech.log"), encoding="utf-8"),
    ],
)
log = logging.getLogger("speech")


# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------
DEFAULT_CONFIG = {
    "host": "127.0.0.1",
    "port": 8765,
    "vad": {
        "threshold": 0.5,          # Silero 语音概率阈值
        "min_silence_ms": 64,      # 判定说话的静音时长（越短反应越快）
        "speech_pad_ms": 250,      # 段前保留（补尾音）
        "min_speech_ms": 150,      # 小于此直接丢弃（噪点）
        "commit_short_ms": 450,    # 小于此不判 SmartTurn 直接提交（短答/语气词）
    },
    "smart_turn": {
        "enabled": True,
        "threshold": 0.6,          # 完成概率阈值，越高越不抢话
        "max_wait_ms": 2000,       # 未说完最多等多久
        "model_path": None,        # 可指定本地 onnx；None 走上游 HF 下载
        "repo_id": "pipecat-ai/smart-turn-v3",
        "filename": "smart-turn-v3.2-cpu.onnx",
    },
    "stt": {
        "backend": "sensevoice",   # sensevoice | none
        "model": "iic/SenseVoiceSmall",
        "device": "cpu",
        "language": "zh",
        "enable_interim": False,
    },
    "tts_voxcpm": {
        "enabled": False,          # 需另行安装 voxcpm + torch + 下载模型
        "model": "openbmb/VoxCPM2",  # 或 openbmb/VoxCPM-0.5B
        "device": "cpu",
        "voices_dir": str(BASE_DIR / "voices"),
        "ref_texts": {},           # voice -> 参考音频的原文（可选）
    },
    "probe": {                     # /probe 用合成音频自检
        "enable": True,
    },
}


def load_config() -> dict:
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))
    path = BASE_DIR / "config.json"
    if path.is_file():
        try:
            user = json.loads(path.read_text("utf-8"))
            _merge(cfg, user)
        except Exception as e:  # noqa: BLE001
            log.warning("config.json 解析失败: %s", e)
    # 打包版：用户可编辑的数据目录 config（userData/speech/config.json）优先级更高
    _d = os.environ.get("VOX_DATA_DIR")
    if _d:
        up = Path(_d) / "speech" / "config.json"
        if up.is_file():
            try:
                _merge(cfg, json.loads(up.read_text("utf-8")))
            except Exception as e:  # noqa: BLE001
                log.warning("数据目录 config 解析失败: %s", e)
    # 环境变量覆盖
    if os.environ.get("SMART_TURN_MODEL_PATH"):
        cfg["smart_turn"]["model_path"] = os.environ["SMART_TURN_MODEL_PATH"]
    for port in ("SPEECH_PORT",):
        if os.environ.get(port):
            cfg["port"] = int(os.environ[port])
    # 代理：供运行时下载模型用（requests/huggingface_hub 认 HTTP(S)_PROXY）
    proxy = cfg.get("proxy") or None
    if proxy and not os.environ.get("HTTPS_PROXY"):
        os.environ["HTTPS_PROXY"] = proxy
        os.environ["HTTP_PROXY"] = proxy
        os.environ["ALL_PROXY"] = proxy
    return cfg


def _merge(base: dict, over: dict) -> None:
    for k, v in over.items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            _merge(base[k], v)
        else:
            base[k] = v


# ---------------------------------------------------------------------------
# Silero VAD
# ---------------------------------------------------------------------------
class VADEngine:
    def __init__(self, cfg: dict):
        import torch  # noqa: F401  (silero-vad 包的 ONNXWrapper 依赖 torch)

        from silero_vad import VADIterator, load_silero_vad

        vcfg = cfg.get("vad", {})
        self.model = load_silero_vad(onnx=True)
        self.threshold = float(vcfg.get("threshold", 0.5))
        self.speech_pad_ms = int(vcfg.get("speech_pad_ms", 250))
        self.min_silence_ms = int(vcfg.get("min_silence_ms", 64))
        self._new_iterator()

    def _new_iterator(self):
        from silero_vad import VADIterator

        self.iter = VADIterator(
            self.model,
            threshold=self.threshold,
            sampling_rate=SR,
            min_silence_duration_ms=self.min_silence_ms,
            speech_pad_ms=self.speech_pad_ms,
        )

    def set_min_silence(self, ms: int):
        """运行期调整判停静音时长（重建轻量迭代器）。"""
        ms = int(max(60, min(1200, ms)))
        if ms != self.min_silence_ms:
            self.min_silence_ms = ms
            self._new_iterator()

    def reset(self):
        self.iter.reset_states()

    @staticmethod
    def frame_tensor(frame: np.ndarray):
        import torch

        return torch.from_numpy(np.asarray(frame, dtype=np.float32))

    def analyze(self, frame: np.ndarray):
        """返回 ('start',) / ('end',) 事件元组或 None。"""
        import torch

        try:
            ev = self.iter(self.frame_tensor(frame))
        except Exception as e:  # noqa: BLE001
            log.warning("VAD 异常: %s", e)
            return None
        if not ev:
            return None
        out = []
        for key in ("start", "end"):
            if key in ev:
                out.append(key)
        return tuple(out) if out else None


# ---------------------------------------------------------------------------
# SmartTurn v3.2 语义判停
# ---------------------------------------------------------------------------
class SmartTurn:
    MODEL_SR = 16000
    MAX_SECONDS = 8

    def __init__(self, cfg: dict):
        import onnxruntime as ort

        from transformers import WhisperFeatureExtractor

        st = cfg.get("smart_turn", {})
        self.threshold = float(st.get("threshold", 0.6))
        self.model_path = self._resolve_model(st)
        self.session = ort.InferenceSession(
            str(self.model_path),
            sess_options=_ort_session(n_threads=2),
            providers=["CPUExecutionProvider"],
        )
        self.input_name = self.session.get_inputs()[0].name
        self.feature_extractor = WhisperFeatureExtractor(chunk_length=self.MAX_SECONDS)

    @staticmethod
    def _resolve_model(st: dict) -> Path:
        path = st.get("model_path")
        if path and Path(path).is_file():
            return Path(path)
        from huggingface_hub import hf_hub_download

        return Path(
            hf_hub_download(
                repo_id=st.get("repo_id", "pipecat-ai/smart-turn-v3"),
                filename=st.get("filename", "smart-turn-v3.2-cpu.onnx"),
            )
        )

    def predict_prob(self, audio: np.ndarray) -> float:
        audio = np.asarray(audio, dtype=np.float32)
        if audio.ndim != 1:
            audio = audio.mean(axis=1)
        max_samples = self.MAX_SECONDS * self.MODEL_SR
        if audio.size > max_samples:
            audio = audio[-max_samples:]
        elif audio.size < max_samples:
            audio = np.pad(audio, (max_samples - audio.size, 0), mode="constant")
        feats = self.feature_extractor(
            audio,
            sampling_rate=self.MODEL_SR,
            return_tensors="np",
            padding="max_length",
            max_length=max_samples,
            truncation=True,
            do_normalize=True,
        )
        out = self.session.run(None, {self.input_name: np.asarray(feats.input_features, dtype=np.float32)})
        prob = float(np.asarray(out[0]).reshape(-1)[0])
        return max(0.0, min(1.0, prob)) if np.isfinite(prob) else 0.5


# ---------------------------------------------------------------------------
# SenseVoice STT
# ---------------------------------------------------------------------------
class SenseVoice:
    def __init__(self, cfg: dict):
        self.cfg = cfg.get("stt", {})
        self.model = None
        self.error = None

    def load(self):
        if self.model is not None or self.error:
            return
        try:
            from funasr import AutoModel
            from funasr.utils.postprocess_utils import rich_transcription_postprocess

            self._postprocess = rich_transcription_postprocess
            self.model = AutoModel(
                model=self.cfg.get("model", "iic/SenseVoiceSmall"),
                device=self.cfg.get("device", "cpu"),
                disable_update=True,
            )
        except Exception as e:  # noqa: BLE001
            self.error = str(e)
            log.error("SenseVoice 加载失败: %s", e)

    def transcribe(self, audio: np.ndarray) -> str:
        self.load()
        if self.model is None:
            raise RuntimeError(f"SenseVoice 不可用: {self.error or '未知错误'}")
        audio = np.asarray(audio, dtype=np.float32)
        if audio.ndim > 1:
            audio = audio.mean(axis=1)
        res = self.model.generate(
            input=audio,
            cache={},
            language=self.cfg.get("language", "zh"),
            use_itn=True,
            batch_size_s=60,
            merge_vad=True,
        )
        if not res or not res[0].get("text"):
            return ""
        text = self._postprocess(res[0]["text"]).strip()
        # 剥掉 SenseVoice 可能残留的元标记 emoji（🎼 等）与行首杂符号
        text = re.sub(r"^[^\u4e00-\u9fff\u3400-\u4dbf\w]+", "", text)
        return text.strip()


# ---------------------------------------------------------------------------
# 话轮状态机：VAD 段 + SmartTurn 语义复核
# ---------------------------------------------------------------------------
class TurnEngine:
    def __init__(self, cfg: dict, stub) -> None:
        """stub: 拥有 emit() 方法的事件出口。"""
        self.cfg = cfg
        self.out = stub
        self.vcfg = cfg.get("vad", {})
        self.scfg = cfg.get("smart_turn", {})
        self.enable_interim = bool(cfg.get("stt", {}).get("enable_interim", False))
        self.min_speech = int(self.vcfg.get("min_speech_ms", 150)) * SR // 1000
        # 判停主参数（可在 session 里被前端覆盖）
        self.smart_threshold = float(self.scfg.get("threshold", 0.7))
        self.smart_max_wait_ms = int(self.scfg.get("max_wait_ms", 3000))
        self.short_wait_ms = int(self.scfg.get("short_wait_ms", 1000))  # 短段缓冲
        self.grace_ms = int(self.scfg.get("grace_ms", 650))  # 判"已说完"后仍压住的重开宽限
        self.commit_short = int(self.vcfg.get("commit_short_ms", 450)) * SR // 1000
        self.smart: SmartTurn | None = None
        self.stt: SenseVoice | None = None
        self.vad: VADEngine | None = None

        self.buffer: list[np.ndarray] = []
        self.speech_active = False
        self.pending = False
        self._pending_handle: asyncio.TimerHandle | None = None
        self._stt_lock = asyncio.Lock()
        self._last_interim_len = 0
        self._ready_flags = {}
        # 判停可观测统计
        self.stat = {"drops": 0, "smart_commits": 0, "smart_holds": 0, "short_holds": 0, "turn_completes": 0}
        self.last_decision = None  # 最近一次 SmartTurn 决策

    def apply_session(self, params: dict):
        """运行时调整判停参数（前端「灵敏度」滑杆等）。"""
        if not params:
            return
        if params.get("vad_min_silence_ms"):
            if self.vad:
                self.vad.set_min_silence(int(params["vad_min_silence_ms"]))
        if params.get("smart_threshold"):
            self.smart_threshold = float(min(0.95, max(0.40, params["smart_threshold"])))
            if self.smart:
                self.smart.threshold = self.smart_threshold
        if params.get("smart_max_wait_ms"):
            self.smart_max_wait_ms = int(min(8000, max(800, params["smart_max_wait_ms"])))
        if params.get("short_wait_ms"):
            self.short_wait_ms = int(min(4000, max(400, params["short_wait_ms"])))
        if params.get("grace_ms"):
            self.grace_ms = int(min(4000, max(250, params["grace_ms"])))
        if params.get("enable_interim") is not None:
            self.enable_interim = bool(params["enable_interim"])

    # ---- 装配 / 状态 ----
    @property
    def smart_ok(self) -> bool:
        stcfg = self.scfg
        return bool(self.smart) and bool(stcfg.get("enabled", True))

    @property
    def stt_ok(self) -> bool:
        return bool(self.stt) and (self.stt.model is not None or self.stt.error is None)

    def status(self) -> dict:
        return {
            "vad": bool(self.vad),
            "smartturn": self.smart_ok,
            "stt": self.stt_ok,
            "smartturn_error": getattr(self.smart, "init_error", None),
            "stt_error": self.stt.error if self.stt else None,
            "enable_interim": self.enable_interim,
            "params": {
                "min_silence_ms": getattr(self.vad, "min_silence_ms", None),
                "smart_threshold": self.smart_threshold,
                "smart_max_wait_ms": self.smart_max_wait_ms,
                "short_wait_ms": self.short_wait_ms,
                "grace_ms": self.grace_ms,
            },
            "stat": self.stat,
            "last_decision": self.last_decision,
        }

    # ---- 主入口 ----
    def feed(self, frame: np.ndarray):
        try:
            ev = self.vad.analyze(frame)
        except Exception as e:  # noqa: BLE001
            self.out.emit_error(f"VAD 错误: {e}")
            return

        if ev:
            if "start" in ev:
                if self.pending:
                    # 用户接着说：合并到“未说完”那一段里
                    self._cancel_pending()
                self.speech_active = True
                self.out.emit("speech_start")
            if "end" in ev:
                self.speech_active = False
                self.out.emit("speech_end")
                self._maybe_decide()

        if self.speech_active or self.pending:
            self.buffer.append(frame)
            self._maybe_interim()

    def _maybe_decide(self):
        if not self.buffer:
            return
        seg = np.concatenate(self.buffer)
        n = seg.size
        if n < self.min_speech:
            # 太短，当噪点丢弃
            self.buffer = []
            self.stat["drops"] += 1
            return
        # 规则 1：够长且有判停模型 → SmartTurn 语义复核
        if self.smart_ok and n >= self.commit_short:
            try:
                prob = self.smart.predict_prob(seg)
            except Exception as e:  # noqa: BLE001
                log.warning("SmartTurn 推理失败，改为短缓冲: %s", e)
                prob = None
            if prob is not None:
                self.last_decision = {
                    "at": int(time.time() * 1000),
                    "prob": round(prob, 3),
                    "segment_s": round(n / SR, 2),
                    "action": "commit" if prob >= self.smart.threshold else "hold",
                }
                log.info(
                    "SmartTurn 决策: prob=%.2f segment=%.2fs -> %s",
                    prob, n / SR, "commit" if prob >= self.smart_threshold else "hold",
                )
                if prob >= self.smart.threshold:
                    self.stat["smart_commits"] += 1
                    # 判"已说完"也先压一段重开宽限：期间接着说就并回同句（避免稍停即被打断）
                    self._hold(seg, self.grace_ms)
                    return
                self.stat["smart_holds"] += 1
                self._hold(seg, self.smart_max_wait_ms)
                return
        # 规则 2：短段 / 判停模型缺失 → 给一段缓冲确认没有续话再提交（避免说完第一个分句就抢答）
        self.stat["short_holds"] += 1
        self._hold(seg, self.short_wait_ms)

    def _hold(self, seg: np.ndarray, wait_ms: int):
        """压住等待：期间如继续说话则并入同段，超时未续则提交。"""
        self.pending = True
        loop = asyncio.get_event_loop()
        self._pending_handle = loop.call_later(
            max(wait_ms, 100) / 1000.0, lambda: asyncio.create_task(self._pending_timeout(seg_copy(seg)))
        )

    async def _pending_timeout(self, seg: np.ndarray):
        if not self.pending:
            return
        self.pending = False
        self.buffer = []
        await self._finalize(seg)

    def _commit_now(self, seg: np.ndarray):
        self.buffer = []
        asyncio.create_task(self._finalize(seg))

    async def _finalize(self, seg: np.ndarray):
        if self.stt is None:
            self.out.emit_error("STT 未就绪")
            return
        try:
            async with self._stt_lock:
                text = await asyncio.to_thread(self.stt.transcribe, seg)
        except Exception as e:  # noqa: BLE001
            log.warning("STT 失败: %s", e)
            self.out.emit_error(f"转写失败: {e}")
            return
        text = (text or "").strip()
        if text:
            self.stat["turn_completes"] += 1
            self.out.emit("turn_complete", {"text": text})

    def _maybe_interim(self):
        if not self.enable_interim or not self.speech_active:
            return
        # 每 ~1.2 秒出一次中间结果（累计），且不与上一轮 STT 打架
        if len(self.buffer) < self._last_interim_len + int(1.2 * SR / FRAME):
            return
        self._last_interim_len = len(self.buffer)
        seg = np.concatenate(self.buffer)
        if self.stt is None:
            return
        asyncio.create_task(self._interim_task(seg))

    async def _interim_task(self, seg: np.ndarray):
        try:
            async with self._stt_lock:
                text = await asyncio.to_thread(self.stt.transcribe, seg)
            text = (text or "").strip()
            if text:
                self.out.emit("interim", {"text": text})
        except Exception:  # noqa: BLE001
            pass

    def reset(self):
        self._cancel_pending()
        self.buffer = []
        self.speech_active = False
        self.pending = False
        if self.vad:
            self.vad.reset()

    def _cancel_pending(self):
        self.pending = False
        if self._pending_handle:
            try:
                self._pending_handle.cancel()
            except Exception:  # noqa: BLE001
                pass
            self._pending_handle = None


def seg_copy(seg: np.ndarray) -> np.ndarray:
    return np.array(seg, copy=True)


# ---------------------------------------------------------------------------
# 可选 VoxCPM TTS（声音克隆，CPU 慢，按需启用）
# ---------------------------------------------------------------------------
def _ort_session(n_threads: int = 2):
    import onnxruntime as ort

    so = ort.SessionOptions()
    so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    so.inter_op_num_threads = 1
    so.intra_op_num_threads = n_threads
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    return so


class VoxCPMTTS:
    def __init__(self, cfg: dict):
        self.cfg = cfg.get("tts_voxcpm", {})
        self.model = None
        self.error = None
        self.voices: dict = {}

    def _scan_voices(self):
        raw = self.cfg.get("voices_dir", "voices")
        d = Path(raw)
        if not d.is_absolute():
            d = BASE_DIR / d
        if not d.is_dir():
            return
        ref_texts = self.cfg.get("ref_texts", {}) or {}
        for wav in sorted(d.glob("*.wav")):
            name = wav.stem
            self.voices[name] = {
                "path": str(wav),
                "ref_text": ref_texts.get(name),
            }

    def load(self):
        if self.model is not None or self.error:
            return
        try:
            from voxcpm import VoxCPM

            self.model = VoxCPM.from_pretrained(
                self.cfg.get("model", "openbmb/VoxCPM2"),
                device=self.cfg.get("device", "cpu"),
            )
            self._scan_voices()
        except Exception as e:  # noqa: BLE001
            self.error = str(e)
            log.error("VoxCPM 加载失败: %s", e)

    def voices_list(self):
        self.load()
        return [{"name": k, "ref_text": v["ref_text"]} for k, v in self.voices.items()]

    def synth(self, text: str, voice: str, sample_rate: int = 16000) -> bytes:
        """返回 WAV 字节。参考 VoxEMW tts_voxcpm.py。"""
        self.load()
        if self.model is None:
            raise RuntimeError(f"VoxCPM 不可用: {self.error or ''}")
        if voice not in self.voices:
            if not self.voices:
                raise RuntimeError("voices 目录没有参考音频 (*.wav)，请先放入克隆样本")
            voice = next(iter(self.voices))
            log.info("音色 %s 不存在，回退 %s", voice, voice)
        ref = self.voices[voice]
        import io

        import torch
        import torchaudio

        tts = self.model
        try:
            cache = tts.build_prompt_cache(ref["path"], ref_text=ref["ref_text"])
            wav = tts.generate_with_prompt_cache(text, cache, streaming=False)
        except AttributeError:
            # 旧接口兼容
            wav = tts.generate(text, ref_audio=ref["path"], ref_text=ref["ref_text"], streaming=False)
        if torch.is_tensor(wav):
            wav = wav.squeeze(0).cpu()
        src_rate = getattr(tts, "sample_rate", 48000) or 48000
        if src_rate != sample_rate:
            wav = torchaudio.functional.resample(wav, src_rate, sample_rate)
        buf = io.BytesIO()
        torchaudio.save(buf, wav.unsqueeze(0), sample_rate, format="wav")
        return buf.getvalue()


# ---------------------------------------------------------------------------
# 服务：事件出口 + WS
# ---------------------------------------------------------------------------
class SpeechService:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.engine = TurnEngine(cfg, self)
        self.tts_voxcpm: VoxCPMTTS | None = None
        self._ws = None
        self._level_last = 0.0

    # ---- 装配（可能抛异常，交由上层决定退出还是降级） ----
    def init_vad(self):
        self.engine.vad = VADEngine(self.cfg)

    def init_smart_turn(self):
        if not self.cfg.get("smart_turn", {}).get("enabled", True):
            return
        try:
            self.engine.smart = SmartTurn(self.cfg)
        except Exception as e:  # noqa: BLE001
            self.engine.smart = None
            self.engine.smart_init_error = str(e)
            log.warning("SmartTurn 不可用（将退化为纯 VAD）: %s", e)

    def init_stt(self):
        if self.cfg.get("stt", {}).get("backend") == "none":
            return
        try:
            self.engine.stt = SenseVoice(self.cfg)
            self.engine.stt.load()  # 启动即预热（下载模型）
        except Exception as e:  # noqa: BLE001
            log.warning("STT 初始化失败: %s", e)

    def init_voxcpm(self):
        if self.cfg.get("tts_voxcpm", {}).get("enabled"):
            self.tts_voxcpm = VoxCPMTTS(self.cfg)
            try:
                self.tts_voxcpm.load()
            except Exception as e:  # noqa: BLE001
                log.warning("VoxCPM 不可用: %s", e)
                self.tts_voxcpm = None

    # ---- 事件出口 ----
    def emit(self, kind: str, payload: dict | None = None):
        msg = {"type": kind}
        if payload:
            msg.update(payload)
        if self._ws is not None:
            asyncio.ensure_future(self._safe_send(msg))

    def emit_audio_level(self, level: float):
        # 节流 ~10Hz
        now = time.monotonic()
        if now - self._level_last < 0.1:
            return
        self._level_last = now
        self.emit("level", {"v": round(level, 3)})

    def emit_error(self, message: str):
        self.emit("error", {"message": message})

    async def _safe_send(self, msg: dict):
        try:
            await self._ws.send(json.dumps(msg, ensure_ascii=False))
        except Exception:  # noqa: BLE001
            pass

    def status(self) -> dict:
        return {
            "ok": bool(self.engine.vad),
            **self.engine.status(),
            "tts_voxcpm": bool(self.tts_voxcpm),
            "tts_voxcpm_voices": self.tts_voxcpm.voices_list() if self.tts_voxcpm else [],
            "port": self.cfg["port"],
        }

    async def handler(self, ws):
        self._ws = ws
        self.engine.reset()
        buf = bytearray()
        await self._safe_send({"type": "ready", **self.status()})
        try:
            async for raw in ws:
                if isinstance(raw, bytes):
                    buf.extend(raw)
                    # 每 2048 字节一个 512 采样帧
                    n = len(buf) // (FRAME * 4)
                    if n:
                        arr = np.frombuffer(bytes(buf[: n * FRAME * 4]), dtype=np.float32)
                        del buf[: n * FRAME * 4]
                        for i in range(n):
                            frame = arr[i * FRAME : (i + 1) * FRAME]
                            self.emit_audio_level(float(np.sqrt(np.mean(frame * frame) + 1e-9)))
                            self.engine.feed(frame)
                else:
                    try:
                        msg = json.loads(raw)
                    except Exception:  # noqa: BLE001
                        continue
                    await self._on_text(ws, msg)
        finally:
            self.engine.reset()
            self._ws = None

    async def _on_text(self, ws, msg: dict):
        t = msg.get("type")
        if t == "session":
            self.engine.apply_session({
                "vad_min_silence_ms": msg.get("vad_min_silence_ms"),
                "smart_threshold": msg.get("smart_threshold"),
                "smart_max_wait_ms": msg.get("smart_max_wait_ms"),
                "short_wait_ms": msg.get("short_wait_ms"),
                "enable_interim": msg.get("enable_interim"),
            })
            await self._safe_send({"type": "session_ok", "params": self.engine.status().get("params")})
        elif t == "ping":
            await self._safe_send({"type": "pong", **self.status()})
        elif t == "tts_request":
            await self._tts(ws, msg)
        elif t == "voxcpm_voices":
            await self._safe_send(
                {"type": "voxcpm_voices",
                 "voices": self.tts_voxcpm.voices_list() if self.tts_voxcpm else []}
            )
        elif t == "probe":
            # 合成一段拟语音音频, 验证 VAD/STT 全链路
            await self._probe(ws)

    async def _tts(self, ws, msg: dict):
        if not self.tts_voxcpm:
            await self._safe_send({"type": "tts_response", "error": "VoxCPM 未启用或不可用，请改用 Edge TTS"})
            return
        text = (msg.get("text") or "").strip()
        if not text:
            await self._safe_send({"type": "tts_response", "error": "text 为空"})
            return
        try:
            wav = await asyncio.to_thread(self.tts_voxcpm.synth, text, msg.get("voice") or "")
        except Exception as e:  # noqa: BLE001
            await self._safe_send({"type": "tts_response", "error": f"VoxCPM 合成失败: {e}"})
            return
        await self._safe_send({
            "type": "tts_response",
            "audio_b64": base64.b64encode(wav).decode("ascii"),
            "mime": "audio/wav",
            "sample_rate": 16000,
        })

    async def _probe(self, ws):
        """自检：合成拟语音 → 走一遍 VAD + SmartTurn + STT。"""
        sr = SR
        t = np.arange(int(1.5 * sr)) / sr
        syll = np.zeros_like(t)
        for start in np.arange(0, 1.5, 0.25):
            k, n = int(start * sr), int(0.22 * sr)
            if k + n < len(t):
                env = np.hanning(n)
                seg = sum((1 / (h + 1)) * np.sin(2 * np.pi * (130 * (h + 1)) * t[k : k + n]) for h in range(8))
                syll[k : k + n] += env * seg
        audio = np.concatenate(
            [np.zeros(int(1.0 * sr), np.float32), (0.6 * syll).astype(np.float32), np.zeros(int(1.0 * sr), np.float32)]
        )
        result = {"vad_fired": False}
        self.engine.reset()
        for i in range(0, len(audio) - (FRAME - 1), FRAME):
            frame = audio[i : i + FRAME]
            if frame.size < FRAME:
                break
            ev = self.engine.vad.analyze(frame)
            if ev:
                result["vad_fired"] = True
                self.engine.speech_active = True
            if self.engine.speech_active:
                self.engine.buffer.append(frame)
        seg = np.concatenate(self.engine.buffer) if self.engine.buffer else None
        if seg is not None:
            try:
                result["smartturn_prob"] = round(self.engine.smart.predict_prob(seg), 3) if self.engine.smart_ok else None
            except Exception as e:  # noqa: BLE001
                result["smartturn_error"] = str(e)
            try:
                result["stt_text"] = await asyncio.to_thread(self.engine.stt.transcribe, seg) if self.engine.stt else None
            except Exception as e:  # noqa: BLE001
                result["stt_error"] = str(e)
        self.engine.reset()
        await self._safe_send({"type": "probe_result", **result})


# ---------------------------------------------------------------------------
async def main():
    ap = argparse.ArgumentParser(description="实时语音服务")
    ap.add_argument("--config", default=None)
    ap.add_argument("--probe", action="store_true", help="跑自检后退出")
    args = ap.parse_args()

    cfg = load_config()
    if args.config:
        _merge(cfg, json.loads(Path(args.config).read_text("utf-8")))

    svc = SpeechService(cfg)
    log.info("初始化 VAD…")
    svc.init_vad()
    log.info("初始化 SmartTurn…")
    svc.init_smart_turn()
    log.info("初始化 STT (SenseVoice)…（懒加载，首次使用才下载模型）")
    svc.init_stt()
    svc.init_voxcpm()

    st = svc.status()
    log.info(
        "状态: VAD=%s SmartTurn=%s STT=%s VoxCPM=%s",
        st["vad"], st["smartturn"], st["stt"], st.get("tts_voxcpm"),
    )

    if args.probe:
        # 简单离线路测（不依赖 Node）：合成拟语音 → VAD → SmartTurn → STT
        svc._ws = None  # type: ignore[assignment]  # 不自检时往上游发事件
        seg = _probe_audio()
        result = {"vad_fired": False}
        svc.engine.reset()
        for i in range(0, len(seg) - (FRAME - 1), FRAME):
            frame = seg[i : i + FRAME]
            ev = svc.engine.vad.analyze(frame)
            if ev:
                svc.engine.speech_active = True
                result["vad_fired"] = True
            if svc.engine.speech_active:
                svc.engine.buffer.append(frame)
        buf = np.concatenate(svc.engine.buffer) if svc.engine.buffer else None
        if buf is not None:
            if svc.engine.smart_ok:
                result["smartturn_prob"] = round(svc.engine.smart.predict_prob(buf), 3)
            if svc.engine.stt:
                result["stt_text"] = await asyncio.to_thread(svc.engine.stt.transcribe, buf)
        print(json.dumps(result, ensure_ascii=False))
        return

    from websockets.asyncio.server import serve

    log.info("实时语音服务监听 ws://%s:%s", cfg["host"], cfg["port"])
    async with serve(svc.handler, cfg["host"], cfg["port"]):
        # 服务先上线，随后台预热 SenseVoice（首次会先下载模型，不阻塞端口）
        if svc.engine.stt and svc.engine.stt.model is None and not svc.engine.stt.error:
            log.info("后台加载 SenseVoice…")
            await asyncio.to_thread(svc.engine.stt.load)
            log.info("SenseVoice 就绪")
        await asyncio.Future()  # run forever


def _probe_audio() -> np.ndarray:
    sr = SR
    t = np.arange(int(1.5 * sr)) / sr
    syll = np.zeros_like(t)
    for start in np.arange(0, 1.5, 0.25):
        k, n = int(start * sr), int(0.22 * sr)
        if k + n < len(t):
            env = np.hanning(n)
            seg = sum((1 / (h + 1)) * np.sin(2 * np.pi * (130 * (h + 1)) * t[k : k + n]) for h in range(8))
            syll[k : k + n] += env * seg
    return np.concatenate(
        [np.zeros(int(1.0 * sr), np.float32), (0.6 * syll).astype(np.float32), np.zeros(int(1.0 * sr), np.float32)]
    )


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
