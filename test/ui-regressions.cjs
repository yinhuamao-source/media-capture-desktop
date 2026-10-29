const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function run({ ui, queue, browser, previews, base, png, waitFor, output, win }) {
  await browser.webContents.loadURL('about:blank');
  await ui('document.querySelector("[data-type=both]").click(); document.querySelector("[data-filter=all]").click()');
  const item = queue.discover({ url: `${base}/image.png?recovery=1`, pageURL: base });
  await ui(`window.mediaCatch.command('retry', '${item.id}')`);
  await waitFor(() => item.status === 'complete' && !queue.active.size, 'recovery fixture saved');
  await waitFor(() => ui(`Boolean(document.querySelector('[data-id="${item.id}"] .resource-status.complete'))`), 'saved fixture rendered');
  await fs.unlink(item.filePath);
  await ui(`document.querySelector('[data-id="${item.id}"] .resource-title').click()`);
  await waitFor(() => ui('document.querySelector("#preview-message").textContent.includes("移动或删除")'), 'missing preview reports an actionable error');
  assert.equal(browser.getVisible(), false, 'native view cannot cover the missing-file dialog');
  await ui('document.querySelector("#close-preview").click()');
  await waitFor(() => ui('!document.querySelector("#preview-dialog").open'), 'missing-file dialog closes');
  const error = await ui(`window.mediaCatch.command('reveal', '${item.id}').then(() => '', error => error.message)`);
  assert.match(error, /移动或删除/);
  await waitFor(() => ui(`Boolean(document.querySelector('[data-id="${item.id}"] .resource-status.missing'))`), 'missing state rendered');
  await ui(`[...document.querySelectorAll('[data-id="${item.id}"] button')].find(b => b.textContent === '重新下载').click()`);
  await waitFor(() => item.status === 'complete' && !queue.active.size, 'missing file re-downloaded from UI');
  assert.deepEqual(await fs.readFile(item.filePath), png);

  queue.beginPage();
  await fs.unlink(item.filePath);
  await ui('document.querySelector("[data-collection=history]").click()');
  await waitFor(() => ui(`Boolean(document.querySelector('#history-list [data-id="${item.id}"] .resource-status.missing'))`), 'history detects missing file without a live URL');
  const missingCard = await ui(`({ text: document.querySelector('#history-list [data-id="${item.id}"]').textContent, buttons: [...document.querySelectorAll('#history-list [data-id="${item.id}"] button')].filter(b => !b.disabled).map(b => b.textContent) })`);
  assert.match(missingCard.text, /原网页/);
  assert(!missingCard.buttons.includes('重新下载'));
  await ui('document.querySelector("[data-collection=page]").click()');
  const rediscovered = queue.discover({ url: item.url, pageURL: base });
  await waitFor(() => rediscovered.status === 'missing', 'rediscovery checks file before deduplication');
  await ui(`window.mediaCatch.command('retry', '${item.id}')`);
  await waitFor(() => rediscovered.status === 'complete' && !queue.active.size, 'rediscovered missing file saved again');

  for (const mode of ['single', 'batch']) {
    const failed = queue.discover({ url: `${base}/failure-${mode}.png`, pageURL: base });
    await ui(`window.mediaCatch.command('retry', '${failed.id}')`);
    await waitFor(() => failed.status === 'failed' && !queue.active.size, 'failed task available for removal');
    if (mode === 'single') {
      await waitFor(() => ui(`Boolean(document.querySelector('[data-id="${failed.id}"] .resource-status.failed'))`), 'failed task rendered');
      await ui(`[...document.querySelectorAll('[data-id="${failed.id}"] button')].find(b => b.textContent === '移除').click()`);
    } else {
      await ui('document.querySelector("[data-collection=history]").click()');
      await waitFor(() => ui('!document.querySelector("#clear-failed").disabled'), 'batch removal enabled');
      await ui('document.querySelector("#clear-failed").click()');
    }
    await waitFor(() => !queue.items.has(failed.id), 'failed task removed through UI');
    assert.deepEqual(await fs.readFile(rediscovered.filePath), png, 'cleanup preserves saved files');
    await ui('document.querySelector("[data-collection=page]").click()');
  }

  const originalHistory = new Map(queue.history);
  try {
    queue.beginPage();
    const now = Date.now();
    for (let n = 0; n < 520; n++) {
      const resource = queue.discover({ url: `${base}/image.png?pagination=${n}`, pageURL: base });
      resource.createdAt = now + n;
      queue.history.set(resource.id, { id: resource.id, type: 'image', mode: 'file', filePath: path.join(__dirname, 'fixtures', 'image.png'), size: png.length, completedAt: now + n, host: 'pagination.test' });
    }
    queue.notify();
    const pageState = () => ui(`({ label: document.querySelector('#page-number').textContent, count: document.querySelectorAll('#resource-list .resource').length, previous: document.querySelector('#previous-page').disabled, next: document.querySelector('#next-page').disabled })`);
    await waitFor(async () => (await pageState()).label === '1 / 3 页 · 520 条', 'first 250 resources and pagination');
    assert.equal((await pageState()).count, 250);
    assert.equal((await pageState()).previous, true);
    await ui('document.querySelector("#next-page").click()');
    assert.equal((await pageState()).label, '2 / 3 页 · 520 条');
    const secondPageIDs = await ui('[...document.querySelectorAll("#resource-list .resource")].map(n => n.dataset.id)');
    await ui('window.mediaCatch.command("state").then(render)');
    assert.deepEqual(await ui('[...document.querySelectorAll("#resource-list .resource")].map(n => n.dataset.id)'), secondPageIDs, 'state updates preserve pagination');
    await ui('document.querySelector("#next-page").click()');
    assert.equal((await pageState()).count, 20);
    assert.equal((await pageState()).next, true);
    await fs.writeFile(path.join(output, 'pagination.png'), (await win.webContents.capturePage()).toPNG());
    await ui('document.querySelector("[data-collection=history]").click()');
    await waitFor(() => ui('document.querySelector("#page-number").textContent.startsWith("1 / 3")'), 'history has independent page index');
    await ui('document.querySelector("#next-page").click(); document.querySelector("#next-page").click()');
    assert.equal(await ui('document.querySelectorAll("#history-list .resource").length'), queue.history.size - 500);
    await ui('document.querySelector("#history-list .resource-title").click()');
    await waitFor(() => ui('Boolean(document.querySelector("#preview-media")?.naturalWidth)'), 'history beyond entry 500 remains previewable');
    await ui('document.querySelector("#close-preview").click()');
    await waitFor(() => !previews.current, 'pagination preview closed');
    await ui('document.querySelector("[data-collection=page]").click()');
    assert.equal((await pageState()).label, '3 / 3 页 · 520 条');
    await ui('document.querySelector("[data-type=video]").click()');
    await waitFor(() => ui('document.querySelector("#list-pagination").hidden && !document.querySelectorAll("#resource-list .resource").length'), 'type filter resets pages');
    await ui('document.querySelector("[data-type=both]").click()');
    await waitFor(async () => (await pageState()).label === '1 / 3 页 · 520 条', 'restored type starts at first page');
    await ui('document.querySelector("#next-page").click(); document.querySelector("[data-filter=complete]").click()');
    assert.equal(await ui('document.querySelector("#list-pagination").hidden'), true);
    await ui('document.querySelector("[data-filter=all]").click()');
    assert.equal((await pageState()).label, '1 / 3 页 · 520 条');
    await ui('document.querySelector("#next-page").click()');
    queue.beginPage(); queue.notify();
    await waitFor(() => ui('document.querySelector("#list-pagination").hidden'), 'navigation resets the paginator');
  } finally {
    queue.history = originalHistory;
    queue.beginPage(); queue.historyChanged([...queue.history.values()]); queue.notify();
  }
}

module.exports = { run };
