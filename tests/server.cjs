const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const root = path.resolve(__dirname, '..');
const wav = Buffer.alloc(44 + 44100 * 2 * 30);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(44100, 24); wav.writeUInt32LE(88200, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
for (let i = 0; i < (wav.length - 44) / 2; i++) wav.writeInt16LE(Math.round(10000 * Math.sin(2 * Math.PI * 440 * i / 44100)), 44 + i * 2);
http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/tone.wav') {
    res.setHeader('Content-Type', 'audio/wav');
    const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    if (range) {
      const start = Number(range[1]), end = range[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1;
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${wav.length}`, 'Content-Length': end - start + 1 });
      res.end(wav.subarray(start, end + 1));
    } else { res.setHeader('Content-Length', wav.length); res.end(wav); }
    return;
  }
  const file = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!['index.html', 'sw.js', 'manifest.json'].includes(file)) { res.writeHead(404).end(); return; }
  res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : 'application/json');
  res.end(fs.readFileSync(path.join(root, file)));
}).listen(4173, '0.0.0.0');
