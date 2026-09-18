const {test,expect,seedSongs}=require('./helpers.cjs');

// State and race tests should not depend on a CI runner's audio backend.
test.beforeEach(async({page})=>{
  await page.evaluate(()=>{
    const realInitAC=initAC,realStartSpectrum=startSpectrum;
    for(const el of [localAudio,urlAudio]){
      let paused=true,ended=false;
      Object.defineProperty(el,'paused',{configurable:true,get:()=>paused});
      Object.defineProperty(el,'ended',{configurable:true,get:()=>ended});
      el.play=async()=>{paused=false;ended=false};
      el.pause=()=>{
        const changed=!paused;paused=true;
        if(changed)el.dispatchEvent(new Event('pause'));
      };
      el.load=()=>{ended=false};
    }
    initAC=async()=>{};startSpectrum=()=>{};
    window.restoreRealMedia=()=>{
      for(const el of [localAudio,urlAudio]){
        for(const key of ['paused','ended','play','pause','load'])delete el[key];
      }
      initAC=realInitAC;startSpectrum=realStartSpectrum;
    };
  });
});

async function externalToneUrl(page){
  return page.evaluate(()=>{
    const url=new URL('/tone.wav',location.href);
    url.hostname=location.hostname==='localhost'?'127.0.0.1':'localhost';
    return url.href;
  });
}

async function holdLocalRead(page,id){
  await page.evaluate(songId=>{
    window.savedDbGet=dbGet;
    dbGet=async function(store,key){
      if(store==='audioData'&&key===songId){
        await new Promise(resolve=>{window.releaseLocalRead=resolve});
      }
      return window.savedDbGet(store,key);
    };
    window.pendingPlayback=playSong(songs.findIndex(song=>song.id===songId));
  },id);
  await expect.poll(()=>page.evaluate(()=>typeof window.releaseLocalRead)).toBe('function');
}

async function releaseLocalRead(page){
  await page.evaluate(async()=>{
    window.releaseLocalRead();
    await window.pendingPlayback;
    dbGet=window.savedDbGet;
  });
}

test('sorting retains the current song, source and next track',async({page})=>{
  await seedSongs(page,[
    {id:'z',title:'Z',lyrics:'Z lyric'},
    {id:'a',title:'A',lyrics:'A lyric'},
    {id:'m',title:'M',lyrics:'M lyric'}
  ]);
  const result=await page.evaluate(async()=>{
    await playSong(0);
    audio.pause();
    const source=audio.src;
    await sortSongs('title');
    return {
      current:songs[currentSongIndex].id,
      sourceUnchanged:source===audio.src,
      order:songs.map(song=>song.id),
      savedOrder:(await dbAll('songs')).sort((a,b)=>a.order-b.order).map(song=>song.id)
    };
  });
  expect(result).toEqual({current:'z',sourceUnchanged:true,order:['a','m','z'],savedOrder:['a','m','z']});
  await expect(page.locator('#nowPlayingTitle')).toHaveText('Z');
  await expect(page.locator('#lyricsContent')).toContainText('Z lyric');
  const nextId=await page.evaluate(async()=>{
    repeatMode='all';
    const original=playSong;
    let selected;
    playSong=async idx=>{selected=songs[idx]?.id};
    try{await nextSong()}finally{playSong=original}
    return selected;
  });
  expect(nextId).toBe('a');
});

test('a delayed local read cannot replace a newer URL selection',async({page})=>{
  const url=await externalToneUrl(page);
  await seedSongs(page,[{id:'a',title:'Local A'},{id:'b',title:'URL B',audioSource:'url',audioUrl:url}]);
  await holdLocalRead(page,'a');
  await page.evaluate(async()=>{
    await playSong(1);
    audio.loop=true;
    window.selectedAudio=audio;
  });
  await releaseLocalRead(page);
  expect(await page.evaluate(()=>({
    id:songs[currentSongIndex]?.id,
    sameAudio:audio===window.selectedAudio,
    src:audio.src,
    paused:audio.paused
  }))).toEqual({id:'b',sameAudio:true,src:url,paused:false});
  await expect(page.locator('#nowPlayingTitle')).toHaveText('URL B');
});

test('deleting a song invalidates its pending local playback',async({page})=>{
  await seedSongs(page,[{id:'a',title:'Pending A'},{id:'b',title:'B'}]);
  await holdLocalRead(page,'a');
  page.once('dialog',dialog=>dialog.accept());
  await page.evaluate(async()=>{await deleteSong('a')});
  await releaseLocalRead(page);
  expect(await page.evaluate(async()=>({
    ids:songs.map(song=>song.id),
    stored:!!await dbGet('songs','a'),
    selected:songs[currentSongIndex]?.id||null,
    paused:audio.paused,
    playing:isPlaying
  }))).toEqual({ids:['b'],stored:false,selected:null,paused:true,playing:false});
  await expect(page.locator('#playerBar')).not.toHaveClass(/visible/);
});

test('manual next at the final song stops audio and updates the controls',async({page})=>{
  await seedSongs(page,[{id:'last',title:'Last'}]);
  const result=await page.evaluate(async()=>{
    repeatMode='off';shuffleMode=false;
    await playSong(0);
    audio.loop=true;
    const wasPlaying=!audio.paused;
    await nextSong();
    return {wasPlaying,paused:audio.paused,playing:isPlaying};
  });
  expect(result).toEqual({wasPlaying:true,paused:true,playing:false});
  await expect(page.locator('#playBtn')).toHaveText('▶');
  await expect(page.locator('#playBtn')).not.toHaveClass(/is-playing/);
});

test('manual next cancels a pending request for the final song',async({page})=>{
  await seedSongs(page,[{id:'pending',title:'Pending'}]);
  await holdLocalRead(page,'pending');
  await page.evaluate(async()=>{repeatMode='off';shuffleMode=false;await nextSong()});
  await releaseLocalRead(page);
  expect(await page.evaluate(()=>({paused:audio.paused,playing:isPlaying,loaded:loadedSongId})))
    .toEqual({paused:true,playing:false,loaded:null});
});

test('an ended event from the old song cannot skip a pending selection',async({page})=>{
  await seedSongs(page,[{id:'a',title:'A'},{id:'b',title:'B'},{id:'c',title:'C'}]);
  await page.evaluate(async()=>{await playSong(0);audio.pause();localAudio.loop=true});
  await holdLocalRead(page,'b');
  await page.evaluate(()=>localAudio.dispatchEvent(new Event('ended')));
  await releaseLocalRead(page);
  expect(await page.evaluate(()=>(
    {selected:songs[currentSongIndex]?.id,paused:audio.paused}
  ))).toEqual({selected:'b',paused:false});
});

test('a stale ended event cannot skip a loaded song on the reused audio element',async({page})=>{
  await seedSongs(page,[{id:'a',title:'A'},{id:'b',title:'B'},{id:'c',title:'C'}]);
  const result=await page.evaluate(async()=>{
    await playSong(0);audio.pause();
    await playSong(1);audio.pause();
    localAudio.dispatchEvent(new Event('ended'));
    return songs[currentSongIndex]?.id;
  });
  expect(result).toBe('b');
});

test('repeat one never restarts the previous source while the selected song is unavailable',async({page})=>{
  await seedSongs(page,[{id:'a',title:'A'},{id:'broken',title:'Broken'}]);
  const result=await page.evaluate(async()=>{
    await playSong(0);audio.pause();
    await dbDel('audioData','broken');
    repeatMode='one';
    await playSong(1);
    await nextSong();
    return {selected:songs[currentSongIndex].id,loaded:loadedSongId,paused:audio.paused,playing:isPlaying};
  });
  expect(result).toEqual({selected:'broken',loaded:null,paused:true,playing:false});
});

test('external audio bypasses WebAudio and source changes retain volume and events',async({page,browserName})=>{
  test.skip(browserName==='webkit','Playwright WebKit does not expose Web Audio');
  await page.evaluate(()=>window.restoreRealMedia());
  const url=await externalToneUrl(page);
  await seedSongs(page,[
    {id:'a',title:'Local A'},
    {id:'b',title:'URL B',audioSource:'url',audioUrl:url},
    {id:'c',title:'Local C'}
  ]);
  await page.evaluate(()=>{
    const Context=window.AudioContext||window.webkitAudioContext;
    const original=Context.prototype.createMediaElementSource;
    window.connectedAudio=[];
    Context.prototype.createMediaElementSource=function(element){
      window.connectedAudio.push(element);
      return original.call(this,element);
    };
  });
  expect(await page.evaluate(async()=>{
    await playSong(0);
    window.firstLocalAudio=audio;
    audio.volume=.37;
    await playSong(1);
    audio.loop=true;
    window.externalAudio=audio;
    return {
      distinct:audio!==window.firstLocalAudio,
      localConnected:window.connectedAudio.includes(window.firstLocalAudio),
      urlConnected:window.connectedAudio.includes(audio),
      previousPaused:window.firstLocalAudio.paused,
      volume:audio.volume,
      paused:audio.paused
    };
  })).toEqual({distinct:true,localConnected:true,urlConnected:false,previousPaused:true,volume:.37,paused:false});
  await expect.poll(()=>page.evaluate(()=>audio.currentTime)).toBeGreaterThan(.03);

  const progress=await page.evaluate(()=>{
    audio.pause();
    $('currentTime').textContent='not updated';
    $('progressFill').style.width='0%';
    audio.currentTime=Math.min(audio.duration/2,.2);
    audio.dispatchEvent(new Event('timeupdate'));
    return {time:$('currentTime').textContent,expected:fmtT(audio.currentTime),fill:parseFloat($('progressFill').style.width)};
  });
  expect(progress.time).toBe(progress.expected);
  expect(progress.fill).toBeGreaterThan(0);
  await page.evaluate(()=>{window.firstLocalAudio.dispatchEvent(new Event('ended'))});
  expect(await page.evaluate(()=>songs[currentSongIndex]?.id)).toBe('b');
  await page.evaluate(()=>{
    const active=audio;
    Object.defineProperty(active,'ended',{configurable:true,get:()=>true});
    active.dispatchEvent(new Event('ended'));
    delete active.ended;
  });
  await expect.poll(()=>page.evaluate(()=>songs[currentSongIndex]?.id)).toBe('c');
  await expect.poll(()=>page.evaluate(()=>!audio.paused)).toBe(true);
  expect(await page.evaluate(()=>({
    localReused:audio===window.firstLocalAudio,
    volume:audio.volume,
    externalPaused:window.externalAudio.paused,
    urlConnected:window.connectedAudio.includes(window.externalAudio)
  }))).toEqual({localReused:true,volume:.37,externalPaused:true,urlConnected:false});
});

test('timing drafts stay bound to their song when playback changes',async({page})=>{
  await seedSongs(page,[
    {id:'a',title:'A',lyrics:'A one\nA two',lyricsTimings:[1,2]},
    {id:'b',title:'B',lyrics:'B one\nB two',lyricsTimings:[3,4]}
  ]);
  const draft=await page.evaluate(async()=>{
    await playSong(0);audio.pause();
    openLyricsTimingModal();
    timingData[0].time=7;timingData[1].time=8;
    await playSong(1);audio.pause();
    setTL(0);
    return timingData.map(line=>line.time);
  });
  expect(draft).toEqual([7,8]);
  await page.evaluate(async()=>{await saveTimings()});
  expect(await page.evaluate(async()=>({
    a:(await dbGet('songs','a')).lyricsTimings,
    b:(await dbGet('songs','b')).lyricsTimings
  }))).toEqual({a:[7,8],b:[3,4]});
});

test('a queued timing save keeps its snapshot and does not close a newer draft',async({page})=>{
  await seedSongs(page,[
    {id:'a',title:'A',lyrics:'A one\nA two',lyricsTimings:[1,2]},
    {id:'b',title:'B',lyrics:'B one\nB two',lyricsTimings:[3,4]}
  ]);
  const result=await page.evaluate(async()=>{
    currentSongIndex=0;loadedSongId='a';openLyricsTimingModal();timingData[0].time=7;timingData[1].time=8;
    let release;const blocker=mutateLibrary(()=>new Promise(resolve=>{release=resolve}));
    await new Promise(resolve=>setTimeout(resolve));
    const pending=saveTimings();
    currentSongIndex=1;loadedSongId='b';openLyricsTimingModal();timingData[0].time=30;
    release();await blocker;await pending;
    return {
      a:(await dbGet('songs','a')).lyricsTimings,
      b:(await dbGet('songs','b')).lyricsTimings,
      draftSong:timingSongId,draft:timingData.map(line=>line.time),modal:$('timingModal').classList.contains('open')
    };
  });
  expect(result).toEqual({a:[7,8],b:[3,4],draftSong:'b',draft:[30,4],modal:true});
});

test('a changed lyric rejects an obsolete timing draft without erasing it',async({page})=>{
  await seedSongs(page,[{id:'a',title:'A',lyrics:'old one\nold two',lyricsTimings:[1,2]}]);
  const result=await page.evaluate(async()=>{
    await playSong(0);audio.pause();
    openLyricsTimingModal();
    timingData[0].time=7;
    openEditModal('a');
    $('editLyrics').value='new one\nnew two\nnew three';
    await updateSong();
    const before=(await dbGet('songs','a')).lyricsTimings;
    await saveTimings();
    return {before,after:(await dbGet('songs','a')).lyricsTimings,draft:timingData.map(line=>line.time)};
  });
  expect(result.after).toEqual(result.before);
  expect(result.draft).toEqual([7,2]);
});

test('seeking before the first lyric clears a later active line',async({page})=>{
  await seedSongs(page,[{id:'a',title:'A',lyrics:'first line\nsecond line',lyricsTimings:[10,20]}]);
  const result=await page.evaluate(()=>{
    currentSongIndex=0;renderLyrics();
    const initial=document.querySelector('.lrc-curr').textContent;
    highlightLyrics(25);
    const later=document.querySelector('.lrc-curr').textContent;
    highlightLyrics(0);
    return {initial,later,rewound:document.querySelector('.lrc-curr').textContent};
  });
  expect(result.later).toBe('second line');
  expect(result.rewound).toBe(result.initial);
  expect(result.rewound).not.toBe('second line');
});
