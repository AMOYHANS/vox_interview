@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist node_modules (
  echo 首次运行，正在安装依赖（需要联网，约2分钟）...
  call npm install --no-audit --no-fund
)

echo.
echo [检查] 本地语音服务是否已安装...
python scripts\setup_speech.py --check >nul 2>&1
if errorlevel 1 (
  echo [首次使用] 未检测到本地语音服务，正在自动安装：
  echo           建虚拟环境 → 安装 Python 依赖 → 下载语音模型（约几分钟，请耐心等待）
  echo.
  python scripts\setup_speech.py --probe
  if errorlevel 1 (
    echo.
    echo [警告] 语音服务安装未完成。可手动重试：setup_speech.bat，或先用「手动模式」面试。
    echo.
  ) else (
    echo [完成] 本地语音服务已安装就绪。
  )
) else (
  echo [OK] 本地语音服务已安装。
)

echo.
echo 正在启动语音面试助手（桌面版 Electron）...
npx electron .
pause
