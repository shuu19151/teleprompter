import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { remuxFragmentedMp4, remuxMp4Blob } from '../src/recording/mp4remux.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp4remux-'))
const summary = []

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', ...opts })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = `${result.stderr || ''}${result.stdout || ''}`.trim()
    throw new Error(`${cmd} ${args.join(' ')} failed (${result.status})\n${detail}`)
  }
  return result
}

function hasBin(name) {
  const result = spawnSync('bash', ['-lc', `command -v ${name}`], { encoding: 'utf8' })
  return result.status === 0
}

function readU32(bytes, offset) {
  return (
    bytes[offset] * 0x1000000 +
    ((bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3])
  ) >>> 0
}

function readU64(bytes, offset) {
  return readU32(bytes, offset) * 0x100000000 + readU32(bytes, offset + 4)
}

function readType(bytes, offset) {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3])
}

function walk(bytes, start, end, visit) {
  let offset = start
  while (offset + 8 <= end) {
    let size = readU32(bytes, offset)
    const type = readType(bytes, offset + 4)
    let header = 8
    if (size === 1) {
      size = readU64(bytes, offset + 8)
      header = 16
    } else if (size === 0) size = end - offset
    assert.ok(size >= header && offset + size <= end, `bad ${type} box`)
    const contentStart = offset + header
    const contentEnd = offset + size
    visit({ type, start: offset, header, contentStart, contentEnd, size })
    offset = contentEnd
  }
}

function nested(bytes, box, type) {
  const found = []
  const scan = (start, end) => {
    walk(bytes, start, end, (child) => {
      if (child.type === type) found.push(child)
      if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'dinf', 'edts'].includes(child.type)) {
        scan(child.contentStart, child.contentEnd)
      }
    })
  }
  scan(box.contentStart, box.contentEnd)
  return found
}

function packetMd5(file) {
  const result = run('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a', '-c', 'copy', '-f', 'md5', '-'])
  const text = `${result.stdout || ''}${result.stderr || ''}`
  const match = text.match(/MD5=([0-9a-fA-F]+)/)
  assert.ok(match, `no packet md5 for ${file}: ${text}`)
  return match[1].toLowerCase()
}

function probe(file) {
  const result = run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration:format_tags=major_brand,compatible_brands',
    '-show_entries',
    'stream=codec_name,codec_tag_string,duration,sample_rate,channels',
    '-of',
    'json',
    file,
  ])
  return JSON.parse(result.stdout)
}

function decodeClean(file) {
  const result = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal((result.stderr || '').trim(), '', result.stderr)
}

function ftypOf(bytes) {
  let found = null
  walk(bytes, 0, bytes.length, (box) => {
    if (!found && box.type === 'ftyp') found = box
  })
  assert.ok(found, 'missing ftyp')
  const major = readType(bytes, found.contentStart)
  const brands = []
  for (let offset = found.contentStart + 8; offset + 4 <= found.contentEnd; offset += 4) {
    brands.push(readType(bytes, offset))
  }
  return { major, brands }
}

function boxInventory(bytes) {
  const top = []
  const moof = []
  walk(bytes, 0, bytes.length, (box) => {
    top.push(box.type)
    if (box.type === 'moof') moof.push(box)
    if (box.type === 'moov') {
      for (const type of ['mvhd', 'trak', 'tkhd', 'mdia', 'mdhd', 'hdlr', 'minf', 'smhd', 'dinf', 'stbl', 'stsd', 'stts', 'stsz', 'stsc', 'stco', 'co64']) {
        const hits = nested(bytes, box, type)
        if (hits.length) top.push(type)
      }
    }
  })
  return { top, moofCount: moof.length }
}

function assertProgressive(bytes, { aac }) {
  const { top, moofCount } = boxInventory(bytes)
  assert.equal(moofCount, 0, `output still has ${moofCount} moof boxes`)
  assert.equal(top[0], 'ftyp')
  const moovAt = top.indexOf('moov')
  const mdatAt = top.indexOf('mdat')
  assert.ok(moovAt > 0 && mdatAt > moovAt, `box order ${top.join(',')}`)
  for (const type of ['mvhd', 'trak', 'tkhd', 'mdia', 'mdhd', 'hdlr', 'minf', 'smhd', 'dinf', 'stbl', 'stsd', 'stts', 'stsz', 'stsc']) {
    assert.ok(top.includes(type), `missing ${type}`)
  }
  assert.ok(top.includes('stco') || top.includes('co64'), 'missing chunk offsets')
  const brands = ftypOf(bytes)
  if (aac) {
    assert.equal(brands.major, 'M4A ')
    assert.deepEqual(brands.brands, ['M4A ', 'isom', 'iso2', 'mp41'])
  }
  return brands
}

function firstPayload(bytes, type) {
  let moov = null
  walk(bytes, 0, bytes.length, (box) => {
    if (!moov && box.type === 'moov') moov = box
  })
  if (!moov) return null
  const needle = type
  for (let offset = moov.start; offset + 8 <= moov.contentEnd; offset += 1) {
    if (readType(bytes, offset + 4) !== needle) continue
    const size = readU32(bytes, offset)
    if (size < 8 || offset + size > moov.contentEnd) continue
    return bytes.slice(offset + 8, offset + size)
  }
  return null
}

function assertRemux(inputFile, { requireAac = false } = {}) {
  const input = fs.readFileSync(inputFile)
  const output = remuxFragmentedMp4(input)
  const outputFile = `${inputFile}.remux.m4a`
  fs.writeFileSync(outputFile, output)
  const inputProbe = probe(inputFile)
  const outputProbe = probe(outputFile)
  const inputCodec = inputProbe.streams?.[0]?.codec_name
  const outputCodec = outputProbe.streams?.[0]?.codec_name
  const aac = inputCodec === 'aac'
  assert.equal(outputCodec, inputCodec, `codec changed from ${inputCodec} to ${outputCodec}`)
  if (requireAac) assert.equal(outputCodec, 'aac')
  const brands = assertProgressive(output, { aac })
  const inputDuration = Number(inputProbe.format?.duration)
  const outputDuration = Number(outputProbe.format?.duration)
  assert.ok(Number.isFinite(inputDuration) && inputDuration > 0, 'input duration missing')
  assert.ok(Number.isFinite(outputDuration) && outputDuration > 0, 'output duration missing')
  const deltaMs = Math.abs(outputDuration - inputDuration) * 1000
  assert.ok(deltaMs <= 50, `duration delta ${deltaMs.toFixed(3)} ms (in ${inputDuration}, out ${outputDuration})`)
  decodeClean(outputFile)
  const inputMd5 = packetMd5(inputFile)
  const outputMd5 = packetMd5(outputFile)
  assert.equal(outputMd5, inputMd5, 'audio packets are not bit-identical')
  const again = remuxFragmentedMp4(output)
  const againFile = `${inputFile}.again.m4a`
  fs.writeFileSync(againFile, again)
  assert.equal(packetMd5(againFile), outputMd5, 'remuxing the progressive file changed packets')
  if (aac) {
    const inputEsds = firstPayload(input, 'esds')
    const outputEsds = firstPayload(output, 'esds')
    assert.ok(inputEsds && outputEsds, 'esds missing')
    assert.equal(Buffer.from(outputEsds).toString('hex'), Buffer.from(inputEsds).toString('hex'), 'esds decoder config changed')
  }
  const line = {
    file: path.basename(inputFile),
    codec: outputCodec,
    brand: brands.major.trim(),
    compatible: brands.brands.map((brand) => brand.trim()).join(','),
    inputDuration,
    outputDuration,
    deltaMs: Number(deltaMs.toFixed(3)),
    md5: outputMd5,
    bytes: output.length,
  }
  summary.push(line)
  console.log(JSON.stringify(line))
  return line
}

before(() => {
  assert.ok(hasBin('ffmpeg'), 'ffmpeg is required')
  assert.ok(hasBin('ffprobe'), 'ffprobe is required')
})

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  if (summary.length) console.log(`summary ${JSON.stringify(summary, null, 2)}`)
})

test('garbage mp4 and webm fall back to the original blob', async () => {
  const junk = new Blob([Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])], { type: 'audio/mp4' })
  assert.equal(await remuxMp4Blob(junk), junk)
  const webm = new Blob([Uint8Array.from([1, 2, 3, 4])], { type: 'audio/webm;codecs=opus' })
  assert.equal(await remuxMp4Blob(webm), webm)
  const empty = new Blob([], { type: 'audio/mp4' })
  assert.equal(await remuxMp4Blob(empty), empty)
})

test('ffmpeg fragmented AAC, single fragment, exact lavfi command', () => {
  const file = path.join(tmp, 'frag-once.m4a')
  run('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=f=440:d=6',
    '-ac',
    '2',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-movflags',
    'frag_keyframe+empty_moov+default_base_moof',
    file,
  ])
  const input = fs.readFileSync(file)
  const inventory = boxInventory(input)
  assert.ok(inventory.moofCount >= 1, 'fixture is not fragmented')
  assertRemux(file, { requireAac: true })
})

test('ffmpeg fragmented AAC, repeated moof/mdat, isom brand', () => {
  const file = path.join(tmp, 'frag-slices.mp4')
  run('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=f=440:d=6',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-f',
    'mp4',
    '-brand',
    'isom',
    '-movflags',
    'frag_keyframe+empty_moov+default_base_moof',
    '-frag_duration',
    '1000000',
    file,
  ])
  const input = fs.readFileSync(file)
  const inventory = boxInventory(input)
  assert.ok(inventory.moofCount >= 2, `expected repeated moof boxes, found ${inventory.moofCount}`)
  const brands = ftypOf(input)
  assert.equal(brands.major, 'isom')
  assertRemux(file, { requireAac: true })
})

function chromeBinary() {
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    if (hasBin(name)) return name
  }
  return ''
}

function recordWithChrome(outFile) {
  const chrome = chromeBinary()
  if (!chrome) return null
  const html = `<!doctype html>
<meta charset="utf-8">
<pre id="log"></pre>
<script>
async function main() {
  const logEl = document.getElementById('log')
  const log = (line) => { logEl.textContent += line + '\\n' }
  const types = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4;codecs=aac', 'audio/mp4', 'audio/webm;codecs=opus']
  let chosen = ''
  for (const type of types) {
    let ok = false
    try { ok = MediaRecorder.isTypeSupported(type) } catch (error) { ok = false }
    log(type + ' ' + ok)
    if (!chosen && ok && type.includes('mp4')) chosen = type
  }
  if (!chosen) {
    await fetch('/fail', { method: 'POST', body: logEl.textContent || 'no mp4' })
    return
  }
  const ctx = new AudioContext({ sampleRate: 48000 })
  if (ctx.state === 'suspended') await ctx.resume()
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  gain.gain.value = 0.2
  const dest = ctx.createMediaStreamDestination()
  osc.frequency.value = 440
  osc.connect(gain)
  gain.connect(dest)
  osc.start()
  const rec = new MediaRecorder(dest.stream, { mimeType: chosen, audioBitsPerSecond: 192000 })
  const chunks = []
  rec.addEventListener('dataavailable', (event) => {
    if (event.data && event.data.size) chunks.push(event.data)
  })
  const stopped = new Promise((resolve) => rec.addEventListener('stop', resolve, { once: true }))
  rec.start(400)
  await new Promise((resolve) => setTimeout(resolve, 2200))
  rec.stop()
  await stopped
  osc.stop()
  await ctx.close()
  const blob = new Blob(chunks, { type: rec.mimeType || chosen })
  log('recorded ' + blob.type + ' ' + blob.size)
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const q = new URLSearchParams({ mime: blob.type || chosen, log: logEl.textContent.slice(0, 400) })
  const saved = await fetch('/save?' + q.toString(), { method: 'POST', body: bytes })
  log('saved ' + saved.status)
  document.title = 'DONE'
}
main().catch(async (error) => {
  const message = String(error && error.stack || error)
  document.getElementById('log').textContent += message
  try { await fetch('/fail', { method: 'POST', body: message }) } catch { /* page is going away */ }
  document.title = 'FAIL'
})
</script>`
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      server.close()
      if (chromeProc) chromeProc.kill('SIGKILL')
      if (error) reject(error)
      else resolve(value)
    }
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      if (req.method === 'POST' && (url.pathname === '/save' || url.pathname === '/fail')) {
        const chunks = []
        req.on('data', (chunk) => chunks.push(chunk))
        req.on('end', () => {
          const body = Buffer.concat(chunks)
          res.writeHead(200)
          res.end('ok')
          if (url.pathname === '/fail') {
            finish(new Error(`chrome recording failed: ${body.toString('utf8').slice(0, 800)}`))
            return
          }
          fs.writeFileSync(outFile, body)
          fs.writeFileSync(`${outFile}.mime`, url.searchParams.get('mime') || '')
          fs.writeFileSync(`${outFile}.log`, url.searchParams.get('log') || '')
          finish(null, { mime: url.searchParams.get('mime') || '', log: url.searchParams.get('log') || '' })
        })
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(html)
    })
    let chromeProc = null
    const timer = setTimeout(() => finish(new Error('chrome recording timed out')), 25000)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      chromeProc = spawn(
        chrome,
        [
          '--headless=new',
          '--disable-gpu',
          '--no-sandbox',
          '--autoplay-policy=no-user-gesture-required',
          '--use-fake-ui-for-media-stream',
          '--no-first-run',
          `--user-data-dir=${path.join(tmp, 'chrome-profile')}`,
          `http://127.0.0.1:${port}/`,
        ],
        { stdio: 'ignore' },
      )
      chromeProc.on('exit', (code) => {
        if (!settled) finish(new Error(`chrome exited early (${code})`))
      })
    })
  })
}

test('MediaRecorder fragmented audio from headless Chrome', async (t) => {
  if (!chromeBinary()) {
    t.skip('headless Chrome is not installed')
    return
  }
  const file = path.join(tmp, 'chrome-mediarecorder.mp4')
  const recorded = await recordWithChrome(file)
  assert.ok(recorded, 'chrome did not record')
  console.log(`chrome mime ${recorded.mime}`)
  console.log(`chrome log ${recorded.log}`)
  const input = fs.readFileSync(file)
  assert.ok(input.length > 32, 'chrome recording is empty')
  const inventory = boxInventory(input)
  assert.ok(inventory.moofCount >= 2, `MediaRecorder file has ${inventory.moofCount} moof boxes`)
  const inputBrands = ftypOf(input)
  assert.equal(inputBrands.major, 'isom')
  const result = assertRemux(file, { requireAac: false })
  if (result.codec === 'aac') assert.equal(result.brand, 'M4A')
})
