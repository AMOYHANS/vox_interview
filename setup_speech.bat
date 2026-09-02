@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================================
echo   语音面试助手 - 实时语音服务安装
echo   (VAD + SmartTurn 判停 + SenseVoice 本地识别)
echo ============================================================
echo.
echo   [可选] 加 --with-voxcpm 可顺带安装本地克隆音色 TTS
echo   [可选] 加 --probe 装完后自动下载模型并做全链路自检
echo   精确控制依赖下载时，请先设置代理（默认读取 speech/config.json 的 proxy）
echo.
python scripts\setup_speech.py %*
echo.
pause
