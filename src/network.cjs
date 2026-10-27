const { net } = require('electron');
const { Readable } = require('node:stream');
const { remoteURL, requestHeadersForURL } = require('./media.cjs');

function requestOnce(browserSession, url, headers, signal) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const request = net.request({ url, session: browserSession, method: 'GET', headers, credentials: 'include', redirect: 'manual', referrerPolicy: 'strict-origin-when-cross-origin' });
    let incoming;
    const abort = () => {
      const error = new Error('下载已中断');
      incoming?.destroy(error);
      request.abort(); reject(error);
    };
    const timer = setTimeout(() => {
      request.abort(); reject(new Error('连接服务器超时，请重试'));
      signal.removeEventListener('abort', abort);
    }, 30000);
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
    signal.addEventListener('abort', abort, { once: true });
    // ClientRequest.close can precede the streaming response; retain cancellation
    // until the response itself ends, errors or closes.
    request.on('error', error => { cleanup(); reject(error); });
    request.on('login', (_auth, callback) => callback());
    request.on('redirect', (_status, _method, redirectURL) => {
      // Resolve before aborting: Electron fetch's redirect:"manual" rejects instead of
      // returning a 3xx Response. A fresh request lets us strip credentials per origin.
      cleanup(); resolve({ redirectURL }); request.abort();
    });
    request.on('response', response => {
      clearTimeout(timer); incoming = response;
      response.once('end', cleanup);
      response.once('error', cleanup);
      response.once('close', cleanup);
      response.once('aborted', () => response.destroy(new Error('下载连接已中断')));
      const responseHeaders = new Headers();
      for (const [key, values] of Object.entries(response.headers)) {
        for (const value of Array.isArray(values) ? values : [values]) responseHeaders.append(key, value);
      }
      try {
        const body = [204, 205, 304].includes(response.statusCode) ? null : Readable.toWeb(response, {
          strategy: { highWaterMark: 256 * 1024, size: chunk => chunk.byteLength },
        });
        resolve({ response: new Response(body, { status: response.statusCode, headers: responseHeaders }), finalURL: url });
      } catch (error) { request.abort(); reject(error); }
    });
    request.end();
  });
}

async function fetchMedia(browserSession, url, { headers, signal, credentialOrigin }) {
  let current = remoteURL(url);
  if (!current) throw new Error('不支持此资源地址');
  let outgoing = { ...headers };
  for (let hop = 0; hop < 8; hop++) {
    outgoing = requestHeadersForURL(outgoing, current);
    if (new URL(current).origin !== credentialOrigin) delete outgoing.authorization;
    const result = await requestOnce(browserSession, current, outgoing, signal);
    if (!result.redirectURL) return result;
    const next = remoteURL(result.redirectURL);
    if (!next) throw new Error('下载重定向地址无效');
    current = next;
  }
  throw new Error('下载重定向次数过多');
}
module.exports = { fetchMedia };
