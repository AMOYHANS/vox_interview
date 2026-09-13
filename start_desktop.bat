@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist node_modules (
  echo 首次运行，正在安装依赖（需要联网，约2分钟）...
  call npm install --no-audit --no-fund
)
echo 正在启动语音面试助手（桌面版 Electron）...
npx electron .
pause
