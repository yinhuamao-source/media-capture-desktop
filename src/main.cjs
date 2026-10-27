const { app, BrowserWindow, WebContentsView, session, ipcMain, protocol, dialog, shell, Menu } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { DownloadQueue } = require('./downloads.cjs');
const { PreviewManager } = require('./preview.cjs');
const network = require('./network.cjs');
const { remoteURL, headerValue, replayHeaders } = require('./media.cjs');

const smoke = !app.isPackaged && process.argv.includes('--smoke-test');
if (smoke) app.setPath('userData', path.join(__dirname, '..', 'test-output', 'profile'));
else if (!app.isPackaged && process.env.MEDIA_CATCH_PROFILE) app.setPath('userData', path.resolve(process.env.MEDIA_CATCH_PROFILE));
protocol.registerSchemesAsPrivileged([{ scheme: 'capture', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

const uiURL = 'capture://app/index.html';
let win, browser, queue, settings, configFile, browserSession, previews;
let previewOpen = false;
let closing = false, savingError = '', pageError = '', stateTimer, scanBusy = false;
const requestHeaders = new Map();
const requestPages = new Map();
let scanTimer;
let currentPageURL = '';

function readConfig() {
  configFile = path.join(app.getPath('userData'), 'settings.json');
  try { return JSON.parse(fs.readFileSync(configFile, 'utf8')); }
  catch { return {}; }
}
function persist() {
  try {
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(`${configFile}.tmp`, JSON.stringify({ settings, history: [...queue.history.values()] }, null, 2), { mode: 0o600 });
    fs.renameSync(`${configFile}.tmp`, configFile);
    savingError = '';
  } catch (error) { savingError = `设置保存失败：${error.message}`; }
}

function snapshot() {
  const wc = browser?.webContents;
  return {
    settings, enabled: queue.enabled, items: queue.snapshot(), history: queue.historySnapshot(), capacityReached: queue.capacityReached,
    ignoredFragments: [...queue.items.values()].filter(item => queue.currentIds.has(item.id) && item.status === 'fragment').length,
    page: {
      url: wc && !wc.isDestroyed() ? wc.getURL() : '', title: wc && !wc.isDestroyed() ? wc.getTitle() : '', generation: queue.generation,
      loading: wc && !wc.isDestroyed() && wc.isLoading(),
      canBack: wc && !wc.isDestroyed() && wc.navigationHistory.canGoBack(),
      canForward: wc && !wc.isDestroyed() && wc.navigationHistory.canGoForward(), error: pageError,
    },
    error: savingError, version: app.getVersion(),
  };
}
function publish() {
  if (stateTimer || closing) return;
  stateTimer = setTimeout(() => {
    stateTimer = null;
    if (win && !win.isDestroyed()) win.webContents.send('capture:state', snapshot());
  }, 100);
}

async function fetchMedia(url, { headers, signal, credentialOrigin }) {
  return network.fetchMedia(browserSession, url, { headers, signal, credentialOrigin });
}

const scanSource = `(() => {
  const result = [];
  for (const el of document.querySelectorAll('img, video')) {
    if (result.length >= 1500) break;
    if (el.tagName === 'IMG' && (!el.complete || !el.naturalWidth)) continue;
    if (el.tagName === 'VIDEO' && el.readyState === 0) continue;
    const url = el.currentSrc || el.src;
    if (!/^https?:/.test(url)) continue;
    result.push({ url, resourceType: el.tagName === 'IMG' ? 'image' : 'media',
      kind: el.tagName === 'IMG' ? { type: 'image', mode: 'file', ext: 'img' } : undefined });
  }
  return result;
})()`;

async function scanPage() {
  if (scanBusy || closing || !browser || browser.webContents.isDestroyed()) return;
  const wc = browser.webContents;
  const pageURL = remoteURL(wc.getURL());
  const generation = queue.generation;
  if (!pageURL || wc.isLoadingMainFrame()) return;
  scanBusy = true;
  try {
    const resources = await wc.executeJavaScriptInIsolatedWorld(1004, [{ code: scanSource }]);
    if (remoteURL(wc.getURL()) !== pageURL || generation !== queue.generation) return;
    for (const resource of resources || []) queue.discover({ ...resource, pageURL, generation, source: 'dom', headers: { referer: pageURL } });
  } catch { /* A navigation can destroy the frame while scanning. Network capture continues. */ }
  finally { scanBusy = false; }
}

function isBrowserRequest(details) { return details.webContentsId === browser?.webContents.id; }
function setupCapture() {
  browserSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    if (isBrowserRequest(details) && details.method === 'GET' && !requestPages.has(details.id)) {
      requestPages.set(details.id, { generation: queue.generation, pageURL: currentPageURL || browser.webContents.getURL() || details.referrer || details.url });
      if (requestPages.size > 4000) { const oldest = requestPages.keys().next().value; requestPages.delete(oldest); requestHeaders.delete(oldest); }
    }
    callback({});
  });
  browserSession.webRequest.onBeforeSendHeaders({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    if (isBrowserRequest(details) && details.method === 'GET') {
      requestHeaders.set(details.id, replayHeaders(details.requestHeaders));
      if (requestHeaders.size > 4000) {
        const oldest = requestHeaders.keys().next().value; requestHeaders.delete(oldest); requestPages.delete(oldest);
      }
    }
    callback({});
  });
  browserSession.webRequest.onResponseStarted({ urls: ['http://*/*', 'https://*/*'] }, details => {
    if (!isBrowserRequest(details) || details.method !== 'GET' || details.statusCode < 200 || details.statusCode >= 300) return;
    const context = requestPages.get(details.id);
    if (!context || context.generation !== queue.generation) return;
    const range = /\/(\d+)$/.exec(headerValue(details.responseHeaders, 'content-range'));
    queue.discover({
      url: details.url, mime: headerValue(details.responseHeaders, 'content-type'), resourceType: details.resourceType,
      size: Number(range?.[1] || headerValue(details.responseHeaders, 'content-length')) || 0,
      headers: requestHeaders.get(details.id) || { referer: details.referrer },
      pageURL: context.pageURL, generation: context.generation,
    });
  });
  const cleanup = details => { requestHeaders.delete(details.id); requestPages.delete(details.id); };
  browserSession.webRequest.onCompleted(cleanup);
  browserSession.webRequest.onErrorOccurred(cleanup);
  // Arbitrary remote pages do not gain native download or file access capabilities.
  browserSession.on('will-download', (event, item) => {
    const url = item.getURL(); const mime = item.getMimeType();
    event.preventDefault();
    queue.discover({ url, mime, pageURL: browser.webContents.getURL() });
  });
}

function navigate(value) {
  if (typeof value !== 'string' || value.length > 16000) throw new Error('请输入有效的网址');
  const trimmed = value.trim();
  const url = remoteURL(/^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
  if (!url) throw new Error('请输入 http:// 或 https:// 网页地址');
  pageError = '';
  browser.setVisible(!previewOpen);
  browser.webContents.loadURL(url).catch(error => {
    if (error.code !== 'ERR_ABORTED') { pageError = '网页加载失败，请检查地址、网络或网站是否允许内置浏览器访问'; publish(); }
  });
  publish();
}

function trusted(event) {
  return win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame && event.senderFrame.url === uiURL;
}

function setupIPC() {
  ipcMain.handle('capture:preview', async (event, id) => {
    if (!trusted(event)) throw new Error('此页面无权操作客户端');
    const item = queue.resource(id);
    if (!item || ['fragment', 'unsupported', 'duplicate'].includes(item.status)) throw new Error(item?.error || '资源不可预览');
    previewOpen = true; browser.setVisible(false);
    try {
      const result = await previews.prepare(item);
      if (typeof result.hasAudio === 'boolean') { item.hasAudio = result.hasAudio; publish(); }
      return result;
    }
    catch (error) {
      if (error.code === 'MEDIA_FRAGMENT') { item.status = 'fragment'; item.error = error.message; queue.fragments.add(item.id); publish(); }
      throw error;
    }
  });
  ipcMain.handle('capture:command', async (event, command, arg) => {
    if (!trusted(event)) throw new Error('此页面无权操作客户端');
    switch (command) {
      case 'state': return snapshot();
      case 'navigate': navigate(arg); break;
      case 'back': if (browser.webContents.navigationHistory.canGoBack()) browser.webContents.navigationHistory.goBack(); break;
      case 'forward': if (browser.webContents.navigationHistory.canGoForward()) browser.webContents.navigationHistory.goForward(); break;
      case 'reload': browser.webContents.reload(); break;
      case 'toggle':
        if (!queue.enabled) {
          await fsp.mkdir(settings.downloadDir, { recursive: true });
          await fsp.access(settings.downloadDir, fs.constants.W_OK);
        }
        queue.setEnabled(!queue.enabled); scanPage(); break;
      case 'type':
        if (!['image', 'video', 'both'].includes(arg)) throw new Error('下载类型无效');
        settings.type = arg; queue.updateSettings(settings); persist(); break;
      case 'minImageKB':
        if (!Number.isInteger(arg) || arg < 0 || arg > 102400) throw new Error('图片大小筛选值无效');
        settings.minImageKB = arg; queue.updateSettings(settings); persist(); break;
      case 'chooseDirectory': {
        const result = await dialog.showOpenDialog(win, { title: '选择媒体保存目录', defaultPath: settings.downloadDir, properties: ['openDirectory', 'createDirectory'] });
        if (!result.canceled && result.filePaths[0]) { settings.downloadDir = result.filePaths[0]; queue.updateSettings(settings); persist(); }
        break;
      }
      case 'openDirectory': {
        await fsp.mkdir(settings.downloadDir, { recursive: true });
        const error = await shell.openPath(settings.downloadDir);
        if (error) throw new Error(error);
        break;
      }
      case 'reveal': {
        const item = queue.resource(arg);
        if (!item?.filePath || item.status !== 'complete') throw new Error('文件尚未下载完成');
        await fsp.access(item.filePath); shell.showItemInFolder(item.filePath); break;
      }
      case 'closePreview':
        previewOpen = false;
        browser.setVisible(Boolean(remoteURL(browser.webContents.getURL())));
        await previews.close(); break;
      case 'savePreview': await previews.save(typeof arg === 'string' ? arg.replace(/^history:/, '') : arg, queue); break;
      case 'retry': queue.retry(typeof arg === 'string' ? arg.replace(/^history:/, '') : arg); break;
      case 'cancel': queue.cancel(typeof arg === 'string' ? arg.replace(/^history:/, '') : arg); break;
      case 'clear': queue.clear(); break;
      default: throw new Error('不支持此操作');
    }
    publish(); return snapshot();
  });
  ipcMain.on('capture:bounds', (event, bounds) => {
    if (!trusted(event) || !bounds || !['x', 'y', 'width', 'height'].every(k => Number.isFinite(bounds[k]))) return;
    const [w, h] = win.getContentSize();
    const x = Math.max(0, Math.min(w, Math.round(bounds.x)));
    const y = Math.max(0, Math.min(h, Math.round(bounds.y)));
    browser.setBounds({ x, y, width: Math.max(0, Math.min(w - x, Math.round(bounds.width))), height: Math.max(0, Math.min(h - y, Math.round(bounds.height))) });
  });
}

async function createWindow() {
  const config = readConfig();
  settings = {
    type: ['image', 'video', 'both'].includes(config.settings?.type) ? config.settings.type : 'both',
    minImageKB: Number.isInteger(config.settings?.minImageKB) ? Math.max(0, Math.min(102400, config.settings.minImageKB)) : 0,
    downloadDir: smoke ? path.join(__dirname, '..', 'test-output', 'downloads') :
      typeof config.settings?.downloadDir === 'string' && path.isAbsolute(config.settings.downloadDir) ? config.settings.downloadDir : path.join(app.getPath('downloads'), 'MediaCatch'),
  };
  browserSession = session.fromPartition('persist:media-browser');
  browserSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  browserSession.setPermissionCheckHandler(() => false);
  browserSession.setDevicePermissionHandler(() => false);
  const history = Array.isArray(config.history) ? config.history.flatMap(h => {
    if (typeof h?.id !== 'string' || typeof h.filePath !== 'string') return [];
    try { const stat = fs.statSync(h.filePath); return stat.isFile() ? [{ ...h, size: stat.size }] : []; } catch { return []; }
  }).slice(-5000) : [];
  queue = new DownloadQueue({ settings, history: smoke ? [] : history, fetcher: fetchMedia, historyChanged: persist });
  previews = new PreviewManager({ fetcher: fetchMedia, root: path.join(app.getPath('temp'), `mediacatch-preview-${process.pid}`), progress: value => {
    if (win && !win.isDestroyed()) win.webContents.send('capture:preview-progress', value);
  } });
  queue.on('change', publish);
  win = new BrowserWindow({
    width: 1380, height: 900, minWidth: 1000, minHeight: 680, title: '拾光 · MediaCatch',
    backgroundColor: '#f4f6fa', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  browser = new WebContentsView({ webPreferences: { session: browserSession, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
  win.contentView.addChildView(browser);
  browser.setVisible(false);
  browser.setBounds({ x: 340, y: 76, width: 1040, height: 760 });
  const wc = browser.webContents;
  wc.setWindowOpenHandler(({ url }) => { if (remoteURL(url)) navigate(url); return { action: 'deny' }; });
  wc.on('will-navigate', (event, url) => { if (!remoteURL(url)) event.preventDefault(); });
  wc.on('will-redirect', (event, url) => { if (!remoteURL(url)) event.preventDefault(); });
  wc.on('will-frame-navigate', (event, details) => {
    if (details && typeof details.url === 'string' && !/^(https?:|about:blank|about:srcdoc)/.test(details.url)) event.preventDefault();
  });
  for (const name of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated']) wc.on(name, publish);
  wc.on('did-start-navigation', (details, url, inPlace, isMainFrame) => {
    const mainFrame = details.isMainFrame ?? isMainFrame;
    const target = remoteURL(details.url || url) || '';
    const sameDocument = details.isSameDocument ?? inPlace;
    if (!mainFrame) return;
    if (!sameDocument || target !== currentPageURL) { currentPageURL = target; queue.beginPage(); }
    pageError = ''; publish();
  });
  wc.on('did-redirect-navigation', (details, url, _inPlace, isMainFrame) => {
    if (details.isMainFrame ?? isMainFrame) currentPageURL = remoteURL(details.url || url) || currentPageURL;
  });
  wc.on('did-navigate-in-page', (_event, _url, isMainFrame) => { if (isMainFrame) scanPage(); });
  wc.on('did-fail-load', (_e, code, description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) { pageError = `网页加载失败：${description}`; publish(); }
  });
  wc.on('render-process-gone', () => { pageError = '网页进程已退出，请点击刷新重新加载'; publish(); });
  wc.on('did-finish-load', scanPage);
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  setupCapture(); setupIPC();
  scanTimer = setInterval(scanPage, 2000);
  win.on('close', event => {
    if (closing) return;
    event.preventDefault(); closing = true; clearInterval(scanTimer);
    Promise.all([queue.shutdown(), previews.close()]).finally(() => {
      persist(); if (!wc.isDestroyed()) wc.close(); win.destroy(); app.quit();
    });
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'close' }] },
  ]));
  await win.loadURL(uiURL);
  await wc.loadURL('about:blank');
  win.show();
  publish();
  if (smoke) {
    try {
      await require('../test/smoke.cjs').run({ win, browser, queue, settings, navigate, snapshot, scanPage, fetchMedia, previews });
      console.log('SMOKE TEST PASSED');
      await queue.shutdown(); app.exit(0);
    } catch (error) { console.error(error); await queue.shutdown(); app.exit(1); }
  }
}

app.whenReady().then(async () => {
  const allowed = new Map([['/index.html', 'text/html'], ['/app.js', 'text/javascript'], ['/styles.css', 'text/css']]);
  protocol.handle('capture', async request => {
    const url = new URL(request.url);
    if (url.host === 'app' && url.pathname.startsWith('/preview/')) return previews?.response(request) || new Response('Not found', { status: 404 });
    if (url.host !== 'app' || !allowed.has(url.pathname)) return new Response('Not found', { status: 404 });
    return new Response(await fsp.readFile(path.join(__dirname, 'ui', url.pathname.slice(1))), { headers: { 'content-type': allowed.get(url.pathname) } });
  });
  await createWindow();
}).catch(error => { console.error(error); app.exit(1); });
app.on('window-all-closed', () => app.quit());
