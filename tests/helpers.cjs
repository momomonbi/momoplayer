const { test, expect } = require('@playwright/test');

test.beforeEach(async ({ page }) => {
  await page.route(/fonts\.googleapis\.com/, route => route.abort());
  await page.goto('/');
  await page.waitForFunction(() => db && document.querySelectorAll('.theme-chip').length);
});

async function seedSongs(page, records) {
  return page.evaluate(async records => {
    audio.pause();
    const tx = db.transaction(['songs', 'audioData', 'imageData'], 'readwrite');
    for (const name of ['songs', 'audioData', 'imageData']) tx.objectStore(name).clear();
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); });
    const buffer = await (await fetch('/tone.wav')).arrayBuffer();
    songs = records.map((s, i) => ({
      id: `song-${i}`, title: `曲${i}`, artist: '', lyrics: '', lyricsTimings: [],
      audioSource: 'local', audioUrl: '', audioType: 'audio/wav',
      imageSource: 'none', imageUrl: '', imageType: '', addedAt: i, order: i, ...s
    }));
    for (const song of songs) {
      await dbPut('songs', song);
      if (song.audioSource === 'local') await dbPut('audioData', { id: song.id, buffer, type: 'audio/wav' });
    }
    currentSongIndex = -1; isPlaying = false; renderSongList();
    return songs.map(s => s.id);
  }, records);
}

module.exports = { test, expect, seedSongs };
