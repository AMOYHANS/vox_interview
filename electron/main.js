'use strict';
/**
 * 语音面试助手 · Electron 主进程
 *
 * 启动时内嵌启动 Express 服务（自动端口）+ 自动拉起本地语音服务，
 * 然后开一个窗口加载页面；退出时清理服务与语音子进程。
 * 网页模式（node server.js）不受影响。
 */
const { app, BrowserWindow, Menu, dialog } = require('electron');
const { startServer, stopServer, stopSpeechService } = require('../server');

let mainWin = null;
let activePort = null;
let quitting = false;

function cleanup() {
  if (quitting) return;
  quitting = true;
  stopServer();
  stopSpeechService();
}

// 单实例：重复启动时聚焦已有窗口，避免多开占用两份模型内存
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWin) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.focus();
    }
  });

  async function createWindow(url) {
    mainWin = new BrowserWindow({
      width: 1380,
      height: 880,
      minWidth: 1000,
      minHeight: 680,
      title: '语音面试助手',
      autoHideMenuBar: true,
      backgroundColor: '#eef2f8',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    // 页面作为普通 Web 页面运行，不允许弹出新窗口/离开本地服务
    mainWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    mainWin.webContents.on('will-navigate', (e, url) => {
      if (!url.startsWith('http://127.0.0.1:')) e.preventDefault();
    });
    await mainWin.loadURL(url);
  }

  async function boot() {
    try {
      activePort = await startServer(0); // 自动端口，避免占用冲突
    } catch (e) {
      dialog.showErrorBox('启动失败', '本地服务启动失败：' + (e && e.message));
      app.quit();
      return;
    }
    console.log('[electron] 内嵌服务端口 =', activePort);
    try {
      await createWindow('http://127.0.0.1:' + activePort);
    } catch (e) {
      dialog.showErrorBox('启动失败', '窗口加载失败：' + (e && e.message));
      cleanup();
      app.quit();
    }
  }

  app.whenReady().then(boot);

  // 菜单栏保持最简（保留复制粘贴等系统默认能力）
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '文件', submenu: [{ role: 'quit', label: '退出' }] },
    { label: '编辑', submenu: [
      { role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' },
      { type: 'separator' },
      { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' },
      { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' },
    ]},
    { label: '视图', submenu: [{ role: 'togglefullscreen', label: '全屏' }, { role: 'reload', label: '刷新' }] },
    { label: '帮助', submenu: [{ role: 'toggledevtools', label: '开发者工具' }] },
  ]));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && activePort) {
      createWindow('http://127.0.0.1:' + activePort);
    }
  });

  app.on('window-all-closed', () => {
    cleanup();
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('will-quit', cleanup);
}
