const { test, expect, seedSongs } = require('./helpers.cjs');

const pixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG1sAAAAASUVORK5CYII=',
  'base64'
);

async function libraryState(page) {
  return page.evaluate(async () => ({
    memory: structuredClone(songs),
    stored: await dbAll('songs'),
    audioIds: await dbKeys('audioData'),
    imageIds: await dbKeys('imageData')
  }));
}

// Abort a real IndexedDB transaction; do not replace the app's DB helpers.
async function failStoreOperation(page, storeName, method = 'put') {
  await page.evaluate(({ storeName, method }) => {
    const original = IDBObjectStore.prototype[method];
    window.__storageFailureFired = false;
    window.__restoreStoreOperation = () => {
      IDBObjectStore.prototype[method] = original;
    };
    IDBObjectStore.prototype[method] = function (...args) {
      if (this.name === storeName && !window.__storageFailureFired) {
        window.__storageFailureFired = true;
        this.transaction.abort();
        throw new DOMException('Injected storage failure', 'QuotaExceededError');
      }
      return original.apply(this, args);
    };
  }, { storeName, method });
}

async function prepareLocalDraft(page, withImage = false) {
  await page.evaluate(() => openAddModal());
  await page.locator('#songTitle').fill('New local song');
  const response = await page.request.get('/tone.wav');
  expect(response.ok()).toBeTruthy();
  await page.locator('#audioFileInput').setInputFiles({
    name: 'new.wav', mimeType: 'audio/wav', buffer: await response.body()
  });
  await page.waitForFunction(() => pendingAudioBuf !== null);
  if (withImage) {
    await page.locator('#imageFileInput').setInputFiles({
      name: 'cover.png', mimeType: 'image/png', buffer: pixel
    });
    await page.waitForFunction(() => pendingImgBuf !== null);
  }
}

async function dispatchFolder(page, entries) {
  await page.evaluate(async entries => {
    const tone = await (await fetch('/tone.wav')).arrayBuffer();
    const transfer = new DataTransfer();
    for (const entry of entries) {
      const file = new File([entry.audio ? tone : 'not audio'], entry.name, { type: entry.type });
      Object.defineProperty(file, 'webkitRelativePath', { value: `Album/${entry.name}` });
      transfer.items.add(file);
    }
    const input = document.getElementById('folderInput');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, entries);
}

for (const failedStore of ['audioData', 'imageData']) {
  test(`F1: adding a song rolls back all stores when ${failedStore} fails`, async ({ page }) => {
    await seedSongs(page, [{ id: 'existing', title: 'Existing' }]);
    const before = await libraryState(page);
    await prepareLocalDraft(page, true);
    await failStoreOperation(page, failedStore);

    await page.evaluate(() => saveSong());

    expect(await page.evaluate(() => window.__storageFailureFired)).toBe(true);
    expect(await libraryState(page)).toEqual(before);
    await expect(page.locator('#addModal')).toHaveClass(/open/);
    await expect(page.locator('#songTitle')).toHaveValue('New local song');
    await expect(page.locator('#toast')).toContainText('失敗');
    await page.evaluate(() => window.__restoreStoreOperation());
  });
}

test('F1: a failed folder import leaves no incomplete song and can be retried', async ({ page }) => {
  await seedSongs(page, []);
  await failStoreOperation(page, 'audioData');
  await dispatchFolder(page, [{ name: 'track.wav', type: 'audio/wav', audio: true }]);
  await expect(page.locator('#toast')).toContainText('0曲を追加しました');
  expect(await page.evaluate(() => window.__storageFailureFired)).toBe(true);
  expect(await libraryState(page)).toEqual({ memory: [], stored: [], audioIds: [], imageIds: [] });

  await page.evaluate(() => window.__restoreStoreOperation());
  await dispatchFolder(page, [{ name: 'track.wav', type: 'audio/wav', audio: true }]);
  await expect(page.locator('#toast')).toContainText('1曲を追加しました');
  const state = await libraryState(page);
  expect(state.stored).toHaveLength(1);
  expect(state.memory).toEqual(state.stored);
  expect(state.audioIds).toEqual([state.stored[0].id]);
});

test('F2: invalid image URL does not mutate the song or leak changes through sorting', async ({ page }) => {
  await seedSongs(page, [{ id: 'original', title: 'Original', artist: 'Artist', lyrics: 'Original lyrics' }]);
  const before = await libraryState(page);
  await page.evaluate(() => openEditModal('original'));
  await page.locator('#editTitle').fill('Unsaved title');
  await page.locator('#editArtist').fill('Unsaved artist');
  await page.locator('#editLyrics').fill('Unsaved lyrics');
  await page.locator('#editImageUrl').fill('invalid URL');
  await page.evaluate(() => updateSong());

  expect(await libraryState(page)).toEqual(before);
  await expect(page.locator('#editModal')).toHaveClass(/open/);
  await expect(page.locator('#editTitle')).toHaveValue('Unsaved title');
  await page.evaluate(async () => {
    closeModal('editModal');
    await sortSongs('title');
  });
  expect(await libraryState(page)).toEqual(before);
});

test('F2: failed metadata update rolls back its image and preserves the edit draft', async ({ page }) => {
  await seedSongs(page, [{ id: 'original', title: 'Original', lyrics: 'Original lyrics' }]);
  const before = await libraryState(page);
  await page.evaluate(() => openEditModal('original'));
  await page.locator('#editTitle').fill('Unsaved title');
  await page.locator('#editLyrics').fill('Unsaved lyrics');
  await page.locator('#editImageInput').setInputFiles({
    name: 'new-cover.png', mimeType: 'image/png', buffer: pixel
  });
  await page.waitForFunction(() => pendingImgBuf !== null);
  await failStoreOperation(page, 'songs');

  await page.evaluate(() => updateSong());

  expect(await page.evaluate(() => window.__storageFailureFired)).toBe(true);
  expect(await libraryState(page)).toEqual(before);
  await expect(page.locator('#editModal')).toHaveClass(/open/);
  await expect(page.locator('#editTitle')).toHaveValue('Unsaved title');
  await expect(page.locator('#editLyrics')).toHaveValue('Unsaved lyrics');
  await expect(page.locator('#toast')).toContainText('失敗');
  await page.evaluate(() => window.__restoreStoreOperation());
});

test('F3: folder import accepts known extensions with empty MIME and excludes unknown files', async ({ page }) => {
  await seedSongs(page, []);
  await dispatchFolder(page, [
    { name: 'track.wav', type: '', audio: true },
    { name: 'notes.xyz', type: '', audio: false },
    { name: 'readme.txt', type: 'text/plain', audio: false }
  ]);
  await expect(page.locator('#toast')).toContainText('1曲を追加しました');
  const state = await libraryState(page);
  expect(state.stored.map(song => song.title)).toEqual(['track']);
  expect(state.memory).toEqual(state.stored);
  expect(state.audioIds).toEqual([state.stored[0].id]);
});

test('deleting all songs cancels files that are still being read from a folder import', async ({ page }) => {
  await seedSongs(page, []);
  await page.evaluate(() => {
    const original = readBuf;
    let reads = 0;
    window.__restoreReadBuf = () => { readBuf = original; };
    readBuf = async file => {
      reads++;
      if (reads === 2) await new Promise(resolve => { window.__releaseFolderRead = resolve; });
      return original(file);
    };
  });
  await dispatchFolder(page, [
    { name: 'one.wav', type: 'audio/wav', audio: true },
    { name: 'two.wav', type: 'audio/wav', audio: true }
  ]);
  await expect.poll(() => page.evaluate(async () => ({
    count: (await dbAll('songs')).length,
    waiting: typeof window.__releaseFolderRead === 'function'
  }))).toEqual({ count: 1, waiting: true });

  await page.evaluate(async () => { window.confirm = () => true; await deleteAllSongs(); window.__releaseFolderRead(); });
  await expect.poll(() => page.evaluate(() => activeImports.size)).toBe(0);
  expect(await libraryState(page)).toEqual({ memory: [], stored: [], audioIds: [], imageIds: [] });
  await page.evaluate(() => window.__restoreReadBuf());
});

test('a failed delete-all lets an in-progress folder import continue', async ({ page }) => {
  await seedSongs(page, [{ id: 'existing', title: 'Existing' }]);
  await page.evaluate(() => {
    const original = readBuf;
    let reads = 0;
    window.__restoreReadBuf = () => { readBuf = original; };
    readBuf = async file => {
      reads++;
      if (reads === 2) await new Promise(resolve => { window.__releaseFolderRead = resolve; });
      return original(file);
    };
  });
  await dispatchFolder(page, [
    { name: 'one.wav', type: 'audio/wav', audio: true },
    { name: 'two.wav', type: 'audio/wav', audio: true }
  ]);
  await expect.poll(() => page.evaluate(async () => ({
    count: (await dbAll('songs')).length,
    waiting: typeof window.__releaseFolderRead === 'function'
  }))).toEqual({ count: 2, waiting: true });

  await failStoreOperation(page, 'songs', 'clear');
  await page.evaluate(async () => { window.confirm = () => true; await deleteAllSongs(); });
  expect(await page.evaluate(() => window.__storageFailureFired)).toBe(true);
  await expect(page.locator('#toast')).toContainText('削除に失敗');
  await page.evaluate(() => { window.__restoreStoreOperation(); window.__releaseFolderRead(); });

  await expect.poll(() => page.evaluate(() => activeImports.size)).toBe(0);
  const state = await libraryState(page);
  expect(state.memory.map(song => song.title)).toEqual(['Existing', 'one', 'two']);
  expect(state.stored.map(song => song.title).sort()).toEqual(['Existing', 'one', 'two']);
  expect(state.audioIds.sort()).toEqual(state.stored.map(song => song.id).sort());
  await page.evaluate(() => window.__restoreReadBuf());
});

test('failed deletion preserves the library and its audio data', async ({ page }) => {
  await seedSongs(page, [{ id: 'keep', title: 'Keep', audioSource: 'local' }]);
  const before = await libraryState(page);
  await failStoreOperation(page, 'audioData', 'delete');
  await page.evaluate(async () => {
    window.confirm = () => true;
    await deleteSong('keep');
  });

  expect(await page.evaluate(() => window.__storageFailureFired)).toBe(true);
  expect(await libraryState(page)).toEqual(before);
  await expect(page.locator('#toast')).toContainText('失敗');
  await page.evaluate(() => window.__restoreStoreOperation());
});

test('cleanup removes only orphaned blobs in one transaction', async ({ page }) => {
  await seedSongs(page, [{ id: 'keep', title: 'Keep', audioSource: 'local' }]);
  await page.evaluate(async () => {
    await dbPut('audioData', { id: 'orphan-audio', buffer: new ArrayBuffer(1), type: 'audio/wav' });
    await dbPut('imageData', { id: 'orphan-image', buffer: new ArrayBuffer(1), type: 'image/png' });
    await cleanupDB();
  });
  const state = await libraryState(page);
  expect(state.memory.map(song => song.id)).toEqual(['keep']);
  expect(state.stored.map(song => song.id)).toEqual(['keep']);
  expect(state.audioIds).toEqual(['keep']);
  expect(state.imageIds).toEqual([]);
});

test('failed cleanup rolls back every orphan deletion', async ({ page }) => {
  await seedSongs(page, [{ id: 'keep', title: 'Keep', audioSource: 'local' }]);
  await page.evaluate(async () => {
    await dbPut('audioData', { id: 'orphan-audio', buffer: new ArrayBuffer(1), type: 'audio/wav' });
    await dbPut('imageData', { id: 'orphan-image', buffer: new ArrayBuffer(1), type: 'image/png' });
  });
  await failStoreOperation(page, 'imageData', 'delete');
  await page.evaluate(() => cleanupDB());

  expect(await page.evaluate(() => window.__storageFailureFired)).toBe(true);
  const state = await libraryState(page);
  expect(state.memory.map(song => song.id)).toEqual(['keep']);
  expect(state.stored.map(song => song.id)).toEqual(['keep']);
  expect(state.audioIds.sort()).toEqual(['keep', 'orphan-audio']);
  expect(state.imageIds).toEqual(['orphan-image']);
  await expect(page.locator('#toast')).toContainText('ゴミ掃除に失敗');
  await page.evaluate(() => window.__restoreStoreOperation());
});

for (const operation of ['sort', 'edit']) {
  test(`deletion followed immediately by ${operation} cannot resurrect a song`, async ({ page }) => {
    await seedSongs(page, [
      { id: 'victim', title: 'A victim', audioSource: 'local' },
      { id: 'survivor', title: 'B survivor' }
    ]);
    if (operation === 'edit') {
      await page.evaluate(() => openEditModal('victim'));
      await page.locator('#editTitle').fill('Stale edit');
    }

    // Keep actual DB writes pending while both public operations are submitted.
    await page.evaluate(operation => {
      window.confirm = () => true;
      window.__releaseStorageBlocker = false;
      const tx = db.transaction(['songs', 'audioData', 'imageData'], 'readwrite');
      const keepAlive = () => {
        if (!window.__releaseStorageBlocker) {
          tx.objectStore('songs').get('__storage_test_hold__').onsuccess = keepAlive;
        }
      };
      keepAlive();
      window.__pendingStorageOperations = [deleteSong('victim')];
      window.__pendingStorageOperations.push(operation === 'sort' ? sortSongs('title') : updateSong());
    }, operation);
    await page.evaluate(async () => {
      window.__releaseStorageBlocker = true;
      await Promise.all(window.__pendingStorageOperations);
    });

    const state = await libraryState(page);
    expect(state.memory.map(song => song.id)).toEqual(['survivor']);
    expect(state.stored.map(song => song.id)).toEqual(['survivor']);
    expect(state.audioIds).not.toContain('victim');
    if (operation === 'edit') {
      await expect(page.locator('#editTitle')).toHaveValue('Stale edit');
    }
  });
}
