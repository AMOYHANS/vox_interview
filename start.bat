@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist node_modules (
  echo 首次运行，正在安装前端依赖（需要联网，约1分钟）...
  call npm install --no-audit --no-fund
)
if not exist speech\.venv (
  echo.
  echo  [提示] 实时语音（自动判停+本地识别）需要先安装语音服务：
  echo         运行 setup_speech.bat 一键安装（首次约几分钟，含模型下载）
  echo         不安装也能正常使用「手动模式」（按键说话 / 打字）开始面试
  echo.
)
echo 正在启动语音面试助手...
start "" http://127.0.0.1:8000
node server.js
pause
