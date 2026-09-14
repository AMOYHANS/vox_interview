#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
语音服务一键安装/自检脚本（跨平台）。
由 setup_speech.bat 调用，也可直接: python scripts/setup_speech.py

要点:
  - 在 speech/.venv 创建独立虚拟环境（避免污染系统 Python）
  - 用 speech/config.json 的 proxy 字段（或环境变量）加速依赖下载
  - 写 speech/runtime.json 供 Node 启动服务时读取（python 路径 + 代理）
  - 可选 --with-voxcpm 安装本地克隆音色 TTS
  - --probe 下载模型后做一次全链路自检
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import venv
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
SPEECH_DIR = BASE_DIR / "speech"
REQ = SPEECH_DIR / "requirements.txt"

# 可写数据目录：打包版指向 Electron userData（便携版临时目录每次启动会清空），开发态即项目目录
DATA_DIR = Path(os.environ.get("VOX_DATA_DIR") or BASE_DIR)
WORK_SPEECH = DATA_DIR / "speech"
VENV_DIR = WORK_SPEECH / ".venv"
RUNTIME = WORK_SPEECH / "runtime.json"
# config：优先读可编辑副本（打包版用户可改代理等），没有则回退打包内置的
CFG_USER = WORK_SPEECH / "config.json"
CONFIG = CFG_USER if CFG_USER.is_file() else SPEECH_DIR / "config.json"

WINDOWS = os.name == "nt"


def log(msg: str) -> None:
    print(msg, flush=True)


def resolve_proxy() -> str | None:
    """代理优先级: 环境变量 > config.json > None"""
    for key in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"):
        if os.environ.get(key):
            return os.environ[key]
    try:
        cfg = json.loads(CONFIG.read_text("utf-8"))
        p = cfg.get("proxy")
        return p if p else None
    except Exception:
        return None


def check_python(py: str) -> tuple[bool, str]:
    try:
        ver = subprocess.run(
            [py, "-c", "import sys; print('.'.join(map(str, sys.version_info[:2])))"],
            capture_output=True, text=True, timeout=30,
        )
        v = ver.stdout.strip()
        major, minor = v.split(".")
        if int(major) != 3 or not (10 <= int(minor) <= 14):
            return False, v
        return True, v
    except Exception:
        return False, "?"


def find_python() -> str:
    # 优先本脚本的解释器
    ok, ver = check_python(sys.executable)
    if ok:
        log(f"使用解释器: {sys.executable} (Python {ver})")
        return sys.executable

    candidates: list[str] = ["python"]
    if WINDOWS:
        import shutil

        launcher = shutil.which("py")
        if launcher:
            candidates = (
                [f"{launcher} -3.14", f"{launcher} -3.13", f"{launcher} -3.12",
                 f"{launcher} -3.11", f"{launcher} -3.10"] + candidates
            )
    for cand in candidates:
        ok, ver = check_python(cand)
        if ok:
            log(f"使用解释器: {cand} (Python {ver})")
            return cand
    log("未找到可用的 Python 3.10~3.14，请先安装 Python 3.12：https://www.python.org/downloads/")
    sys.exit(1)


def run_py(py: str, args: list[str], env: dict | None = None, check: bool = True) -> None:
    cmd = py.split() + args
    log(f"$ {cmd}")
    e = dict(os.environ)
    if env:
        e.update(env)
    r = subprocess.run(cmd, cwd=str(SPEECH_DIR), env=e)
    if check and r.returncode != 0:
        sys.exit(r.returncode)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--with-voxcpm", action="store_true", help="一并安装 VoxCPM 克隆音色 TTS（较大）")
    ap.add_argument("--probe", action="store_true", help="装完后下载模型并做全链路自检")
    ap.add_argument("--system", action="store_true", help="不建 venv，直接装到当前 Python")
    ap.add_argument("--check", action="store_true", help="检测本地语音服务是否已安装（退出码 0/1）")
    args = ap.parse_args()

    if args.check:
        import json as _json

        try:
            rt = _json.loads(RUNTIME.read_text("utf-8"))
            py = rt.get("python")
            if py and Path(py).exists():
                log(f"已安装: {py}")
                sys.exit(0)
            log(f"runtime.json 存在但 python 不可用: {py}")
        except Exception:
            log("未检测到本地语音服务（缺少 speech/runtime.json）")
        sys.exit(1)

    # 初始化数据目录：首次使用（尤其打包版）从内置复制一份可编辑的 config.json（可改代理等）
    WORK_SPEECH.mkdir(parents=True, exist_ok=True)
    try:
        bundled_cfg = SPEECH_DIR / "config.json"
        if not CFG_USER.exists() and bundled_cfg.exists():
            shutil.copy2(bundled_cfg, CFG_USER)
    except Exception as e:  # noqa: BLE001
        log(f"提示：未能写入可编辑 config（{e}）")

    py = find_python()
    proxy = resolve_proxy()
    if proxy:
        log(f"检测到代理: {proxy}（用于下载依赖与模型）")
    env = dict(os.environ)
    if proxy and not env.get("HTTPS_PROXY"):
        env.update({"HTTPS_PROXY": proxy, "HTTP_PROXY": proxy, "ALL_PROXY": proxy})

    # 1) venv
    if args.system:
        vpython = py
    else:
        vpython = str(VENV_DIR / ("Scripts/python.exe" if WINDOWS else "bin/python"))
        if VENV_DIR.exists():
            log(f"复用已有虚拟环境: {VENV_DIR}")
        else:
            log("创建虚拟环境 speech/.venv …")
            venv.EnvBuilder(with_pip=True).create(VENV_DIR)
            VENV_DIR.mkdir(parents=True, exist_ok=True)

    # 2) 依赖
    log("安装依赖（torch / funasr 等，首次需几分钟）…")
    run_py(vpython, ["-m", "pip", "install", "--upgrade", "pip"], env=env)
    run_py(vpython, ["-m", "pip", "install", "-r", str(REQ), "--no-input"], env=env)
    if args.with_voxcpm:
        run_py(vpython, ["-m", "pip", "install", "voxcpm", "--no-input"], env=env)

    # 3) runtime.json（Node 读取）
    RUNTIME.write_text(
        json.dumps({"python": vpython, "venv": not args.system, "proxy": proxy, "voxcpm": args.with_voxcpm}, ensure_ascii=False, indent=2),
        "utf-8",
    )
    log(f"已写 {RUNTIME}")

    # 4) 自检
    if args.probe:
        log("运行全链路自检（首次会下载 SenseVoice/SmartTurn 模型）…")
        run_py(vpython, [str(SPEECH_DIR / "server.py"), "--probe"], env=env)

    log("完成！启动方式：npm start  （Node 会自动拉起语音服务）")


if __name__ == "__main__":
    main()
