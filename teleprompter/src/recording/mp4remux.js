/**
 * Remux a fragmented MP4 audio recording into one progressive file.
 *
 * MediaRecorder (and WebView2, which uses the same muxer) writes
 * ftyp + moov + repeated moof/mdat pairs. The major brand is `isom`,
 * with no M4A brand. Desktop players accept that. Meta Messenger rejects
 * it as a voice-note upload. The file Messenger accepts is a single
 * non-fragmented MP4: ftyp major brand `M4A `, moov with full sample
 * tables, then one mdat. Sample bytes are copied; nothing is re-encoded.
 *
 * `remuxFragmentedMp4` throws when the file cannot be remuxed.
 * `remuxMp4Blob` catches that and returns the original blob.
 */

const AAC_BRANDS = ['M4A ', 'isom', 'iso2', 'mp41']
const ISOM_BRANDS = ['isom', 'iso2', 'mp41']
const MAX_SAMPLES = 0x1000000
const MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000]

function toBytes(input) {
  if (input instanceof Uint8Array) return input
  if (input instanceof ArrayBuffer) return new Uint8Array(input)
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
  }
  throw new Error('mp4 input must be bytes')
}

function readU32(bytes, offset) {
  return (
    bytes[offset] * 0x1000000 +
    ((bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3])
  ) >>> 0
}

function readI32(bytes, offset) {
  const value = readU32(bytes, offset)
  return value > 0x7fffffff ? value - 0x100000000 : value
}

function readU16(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1]
}

function readI16(bytes, offset) {
  const value = readU16(bytes, offset)
  return value > 0x7fff ? value - 0x10000 : value
}

function readU64(bytes, offset) {
  return readU32(bytes, offset) * 0x100000000 + readU32(bytes, offset + 4)
}

function readType(bytes, offset) {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3])
}

function readBox(bytes, offset, end) {
  if (offset + 8 > end) return null
  let size = readU32(bytes, offset)
  const type = readType(bytes, offset + 4)
  let header = 8
  if (size === 1) {
    if (offset + 16 > end) throw new Error(`truncated ${type}`)
    size = readU64(bytes, offset + 8)
    header = 16
  } else if (size === 0) {
    size = end - offset
  }
  if (type === 'uuid') header += 16
  if (!Number.isFinite(size) || size < header || offset + size > end) {
    throw new Error(`truncated ${type}`)
  }
  return {
    type,
    start: offset,
    size,
    header,
    contentStart: offset + header,
    contentEnd: offset + size,
  }
}

function childBoxes(bytes, start, end) {
  const boxes = []
  let offset = start
  while (offset + 8 <= end) {
    const box = readBox(bytes, offset, end)
    if (!box) break
    boxes.push(box)
    offset = box.contentEnd
  }
  return boxes
}

function children(bytes, box) {
  return childBoxes(bytes, box.contentStart, box.contentEnd)
}

function fullBox(bytes, box) {
  const start = box.contentStart
  if (start + 4 > box.contentEnd) throw new Error(`truncated ${box.type}`)
  const version = bytes[start]
  const flags = (bytes[start + 1] << 16) | (bytes[start + 2] << 8) | bytes[start + 3]
  return { version, flags, pos: start + 4 }
}

function parseMvhd(bytes, box) {
  const header = fullBox(bytes, box)
  const { version, pos } = header
  let cursor = pos
  let creation = 0
  let modification = 0
  let timescale = 0
  if (version === 1) {
    creation = readU64(bytes, cursor)
    modification = readU64(bytes, cursor + 8)
    timescale = readU32(bytes, cursor + 16)
    cursor += 28
  } else {
    creation = readU32(bytes, cursor)
    modification = readU32(bytes, cursor + 4)
    timescale = readU32(bytes, cursor + 8)
    cursor += 16
  }
  const nextTrackId = readU32(bytes, box.contentEnd - 4)
  return {
    creation,
    modification,
    timescale: timescale || 1000,
    nextTrackId,
  }
}

function parseTkhd(bytes, box) {
  const { version, flags, pos } = fullBox(bytes, box)
  let creation = 0
  let modification = 0
  let trackId = 0
  if (version === 1) {
    creation = readU64(bytes, pos)
    modification = readU64(bytes, pos + 8)
    trackId = readU32(bytes, pos + 16)
  } else {
    creation = readU32(bytes, pos)
    modification = readU32(bytes, pos + 4)
    trackId = readU32(bytes, pos + 8)
  }
  if (!trackId) throw new Error('audio track has no id')
  return { creation, modification, trackId, flags }
}

function parseMdhd(bytes, box) {
  const { version, pos } = fullBox(bytes, box)
  let creation = 0
  let modification = 0
  let timescale = 0
  let language = 0x55c4
  if (version === 1) {
    creation = readU64(bytes, pos)
    modification = readU64(bytes, pos + 8)
    timescale = readU32(bytes, pos + 16)
    language = readU16(bytes, pos + 28)
  } else {
    creation = readU32(bytes, pos)
    modification = readU32(bytes, pos + 4)
    timescale = readU32(bytes, pos + 8)
    language = readU16(bytes, pos + 16)
  }
  if (!timescale) throw new Error('audio track has no timescale')
  return { creation, modification, timescale, language }
}

function parseHdlr(bytes, box) {
  const { pos } = fullBox(bytes, box)
  if (pos + 20 > box.contentEnd) throw new Error('truncated hdlr')
  const handler = readType(bytes, pos + 4)
  let name = ''
  const nameStart = pos + 20
  if (nameStart < box.contentEnd) {
    const raw = bytes.subarray(nameStart, Math.min(box.contentEnd, nameStart + 128))
    let end = raw.length
    while (end > 0 && raw[end - 1] === 0) end -= 1
    for (let i = 0; i < end; i += 1) name += String.fromCharCode(raw[i])
  }
  return { handler, name }
}

function parseSmhd(bytes, box) {
  const { pos } = fullBox(bytes, box)
  if (pos + 2 > box.contentEnd) return 0
  return readI16(bytes, pos)
}

function parseStsd(bytes, box) {
  const { pos } = fullBox(bytes, box)
  if (pos + 4 > box.contentEnd) throw new Error('truncated stsd')
  const entryCount = readU32(bytes, pos)
  if (entryCount < 1 || entryCount > 32) throw new Error('audio sample description is missing')
  const entries = []
  let offset = pos + 4
  for (let i = 0; i < entryCount; i += 1) {
    const entry = readBox(bytes, offset, box.contentEnd)
    if (!entry) throw new Error('truncated sample entry')
    entries.push(entry)
    offset = entry.contentEnd
  }
  return {
    entries: entries.map((entry) => ({ type: entry.type })),
    raw: bytes.slice(pos + 4, offset),
  }
}

function parseStts(bytes, box) {
  const { pos } = fullBox(bytes, box)
  const count = readU32(bytes, pos)
  const durations = []
  let cursor = pos + 4
  for (let i = 0; i < count; i += 1) {
    if (cursor + 8 > box.contentEnd) throw new Error('truncated stts')
    const sampleCount = readU32(bytes, cursor)
    const delta = readU32(bytes, cursor + 4)
    cursor += 8
    if (sampleCount > MAX_SAMPLES || durations.length + sampleCount > MAX_SAMPLES) {
      throw new Error('too many audio samples')
    }
    for (let n = 0; n < sampleCount; n += 1) durations.push(delta)
  }
  return durations
}

function parseStsz(bytes, box) {
  const { pos } = fullBox(bytes, box)
  const sampleSize = readU32(bytes, pos)
  const sampleCount = readU32(bytes, pos + 4)
  if (sampleCount > MAX_SAMPLES) throw new Error('too many audio samples')
  if (sampleSize !== 0) return { constant: sampleSize, sizes: null, sampleCount }
  const sizes = []
  let cursor = pos + 8
  for (let i = 0; i < sampleCount; i += 1) {
    if (cursor + 4 > box.contentEnd) throw new Error('truncated stsz')
    sizes.push(readU32(bytes, cursor))
    cursor += 4
  }
  return { constant: 0, sizes, sampleCount }
}

function parseStsc(bytes, box) {
  const { pos } = fullBox(bytes, box)
  const count = readU32(bytes, pos)
  const entries = []
  let cursor = pos + 4
  for (let i = 0; i < count; i += 1) {
    if (cursor + 12 > box.contentEnd) throw new Error('truncated stsc')
    entries.push({
      firstChunk: readU32(bytes, cursor),
      samplesPerChunk: readU32(bytes, cursor + 4),
      descIndex: readU32(bytes, cursor + 8) || 1,
    })
    cursor += 12
  }
  return entries
}

function parseChunkOffsets(bytes, box) {
  const { pos } = fullBox(bytes, box)
  const count = readU32(bytes, pos)
  const wide = box.type === 'co64'
  const offsets = []
  let cursor = pos + 4
  for (let i = 0; i < count; i += 1) {
    const width = wide ? 8 : 4
    if (cursor + width > box.contentEnd) throw new Error(`truncated ${box.type}`)
    offsets.push(wide ? readU64(bytes, cursor) : readU32(bytes, cursor))
    cursor += width
  }
  return offsets
}

function samplesFromTables(bytes, tables) {
  const { durations, sizeTable, stsc, offsets } = tables
  if (!offsets.length || !durations.length || !stsc.length) return []
  const samples = []
  let sampleIndex = 0
  let stscIndex = 0
  for (let chunk = 1; chunk <= offsets.length; chunk += 1) {
    while (stscIndex + 1 < stsc.length && stsc[stscIndex + 1].firstChunk <= chunk) stscIndex += 1
    const entry = stsc[stscIndex]
    if (!entry || entry.firstChunk > chunk) throw new Error('sample table is missing a chunk map')
    let offset = offsets[chunk - 1]
    for (let i = 0; i < entry.samplesPerChunk; i += 1) {
      const size = sizeTable.constant || sizeTable.sizes?.[sampleIndex]
      const duration = durations[sampleIndex]
      if (size == null || duration == null) throw new Error('sample table ended early')
      if (size > 0 && (offset < 0 || offset + size > bytes.length)) {
        throw new Error('sample extends past end of file')
      }
      samples.push({ duration, size, offset, descIndex: entry.descIndex || 1 })
      offset += size
      sampleIndex += 1
      if (samples.length > MAX_SAMPLES) throw new Error('too many audio samples')
    }
  }
  return samples
}

function parseStbl(bytes, stbl) {
  let stsd = null
  let stts = null
  let stsz = null
  let stsc = null
  let stco = null
  for (const child of children(bytes, stbl)) {
    if (child.type === 'stsd') stsd = child
    else if (child.type === 'stts') stts = child
    else if (child.type === 'stsz') stsz = child
    else if (child.type === 'stsc') stsc = child
    else if (child.type === 'stco' || child.type === 'co64') stco = child
  }
  if (!stsd) throw new Error('audio sample description is missing')
  const description = parseStsd(bytes, stsd)
  let moovSamples = []
  if (stts && stsz && stsc && stco) {
    const durations = parseStts(bytes, stts)
    const sizeTable = parseStsz(bytes, stsz)
    if (durations.length && sizeTable.sampleCount) {
      moovSamples = samplesFromTables(bytes, {
        durations,
        sizeTable,
        stsc: parseStsc(bytes, stsc),
        offsets: parseChunkOffsets(bytes, stco),
      })
    }
  }
  return { description, moovSamples }
}

function parseTrak(bytes, trak) {
  let tkhd = null
  let mdia = null
  for (const child of children(bytes, trak)) {
    if (child.type === 'tkhd') tkhd = child
    else if (child.type === 'mdia') mdia = child
  }
  if (!tkhd || !mdia) throw new Error('track is missing a header')
  const trackHeader = parseTkhd(bytes, tkhd)
  let mdhd = null
  let handler = null
  let minf = null
  for (const child of children(bytes, mdia)) {
    if (child.type === 'mdhd') mdhd = child
    else if (child.type === 'hdlr') handler = child
    else if (child.type === 'minf') minf = child
  }
  if (!mdhd || !handler || !minf) throw new Error('audio track media header is missing')
  const media = parseMdhd(bytes, mdhd)
  const hdlr = parseHdlr(bytes, handler)
  let balance = 0
  let stbl = null
  for (const child of children(bytes, minf)) {
    if (child.type === 'smhd') balance = parseSmhd(bytes, child)
    else if (child.type === 'stbl') stbl = child
  }
  if (!stbl) throw new Error('audio sample table is missing')
  const table = parseStbl(bytes, stbl)
  return {
    ...trackHeader,
    ...media,
    handler: hdlr.handler,
    handlerName: hdlr.name,
    balance,
    sampleEntries: table.description.entries,
    sampleEntryBytes: table.description.raw,
    moovSamples: table.moovSamples,
  }
}

function parseTrex(bytes, box) {
  const { pos } = fullBox(bytes, box)
  if (pos + 20 > box.contentEnd) throw new Error('truncated trex')
  return {
    trackId: readU32(bytes, pos),
    descIndex: readU32(bytes, pos + 4) || 1,
    duration: readU32(bytes, pos + 8),
    size: readU32(bytes, pos + 12),
  }
}

function parseMoov(bytes, moov) {
  let mvhd = null
  const tracks = []
  const trexs = []
  for (const child of children(bytes, moov)) {
    if (child.type === 'mvhd') mvhd = parseMvhd(bytes, child)
    else if (child.type === 'trak') tracks.push(parseTrak(bytes, child))
    else if (child.type === 'mvex') {
      for (const ext of children(bytes, child)) {
        if (ext.type === 'trex') trexs.push(parseTrex(bytes, ext))
      }
    }
  }
  const track = tracks.find((item) => item.handler === 'soun')
  if (!track) throw new Error('mp4 has no audio track')
  if (!track.sampleEntryBytes?.length) throw new Error('audio sample description is missing')
  const trex = trexs.find((item) => item.trackId === track.trackId) || null
  return {
    creation: mvhd?.creation || track.creation || 0,
    modification: mvhd?.modification || track.modification || 0,
    timescale: mvhd?.timescale || 1000,
    nextTrackId: mvhd?.nextTrackId || 0,
    track,
    trex,
  }
}

function parseTfhd(bytes, box) {
  const { flags, pos } = fullBox(bytes, box)
  let cursor = pos
  if (cursor + 4 > box.contentEnd) throw new Error('truncated tfhd')
  const out = { trackId: readU32(bytes, cursor) }
  cursor += 4
  if (flags & 0x000001) {
    if (cursor + 8 > box.contentEnd) throw new Error('truncated tfhd')
    out.baseDataOffset = readU64(bytes, cursor)
    cursor += 8
  }
  if (flags & 0x000002) {
    if (cursor + 4 > box.contentEnd) throw new Error('truncated tfhd')
    out.descIndex = readU32(bytes, cursor) || 1
    cursor += 4
  }
  if (flags & 0x000008) {
    if (cursor + 4 > box.contentEnd) throw new Error('truncated tfhd')
    out.duration = readU32(bytes, cursor)
    cursor += 4
  }
  if (flags & 0x000010) {
    if (cursor + 4 > box.contentEnd) throw new Error('truncated tfhd')
    out.size = readU32(bytes, cursor)
    cursor += 4
  }
  return out
}

function parseTfdt(bytes, box) {
  const { version, pos } = fullBox(bytes, box)
  if (version === 1) {
    if (pos + 8 > box.contentEnd) throw new Error('truncated tfdt')
    return readU64(bytes, pos)
  }
  if (pos + 4 > box.contentEnd) throw new Error('truncated tfdt')
  return readU32(bytes, pos)
}

function parseTrun(bytes, box, defaults, moofStart) {
  const { flags, pos } = fullBox(bytes, box)
  if (pos + 4 > box.contentEnd) throw new Error('truncated trun')
  const sampleCount = readU32(bytes, pos)
  if (sampleCount > MAX_SAMPLES) throw new Error('too many audio samples')
  let cursor = pos + 4
  let dataOffset = 0
  if (flags & 0x000001) {
    if (cursor + 4 > box.contentEnd) throw new Error('truncated trun')
    dataOffset = readI32(bytes, cursor)
    cursor += 4
  }
  if (flags & 0x000004) {
    if (cursor + 4 > box.contentEnd) throw new Error('truncated trun')
    cursor += 4
  }
  const record = (flags & 0x100 ? 4 : 0) + (flags & 0x200 ? 4 : 0) + (flags & 0x400 ? 4 : 0) + (flags & 0x800 ? 4 : 0)
  if (cursor + sampleCount * record > box.contentEnd) throw new Error('truncated trun')
  const base = defaults.baseDataOffset != null ? defaults.baseDataOffset : moofStart
  let fileOffset = base + dataOffset
  const samples = []
  for (let i = 0; i < sampleCount; i += 1) {
    let duration = defaults.duration
    let size = defaults.size
    if (flags & 0x100) {
      duration = readU32(bytes, cursor)
      cursor += 4
    }
    if (flags & 0x200) {
      size = readU32(bytes, cursor)
      cursor += 4
    }
    if (flags & 0x400) cursor += 4
    if (flags & 0x800) cursor += 4
    if (duration == null || size == null) throw new Error('sample duration or size is missing')
    if (size > 0 && (fileOffset < 0 || fileOffset + size > bytes.length)) {
      throw new Error('sample extends past end of file')
    }
    samples.push({
      duration,
      size,
      offset: fileOffset,
      descIndex: defaults.descIndex || 1,
    })
    fileOffset += size
  }
  return samples
}

/**
 * MediaRecorder's fragment clock (tfdt) runs ahead of the sum of frame
 * durations between timeslices. Fold that gap into the previous frame's
 * duration so the movie length matches the recording. The frame bytes
 * stay where they are.
 */
function appendFragment(samples, state, baseTime, fragSamples) {
  if (!fragSamples.length) return
  const start = baseTime == null ? state.cursor : baseTime
  if (start > state.cursor) {
    const gap = start - state.cursor
    if (samples.length) {
      samples[samples.length - 1].duration += gap
      state.cursor = start
    } else {
      fragSamples[0].duration += gap
    }
  }
  for (const sample of fragSamples) {
    samples.push(sample)
    state.cursor += sample.duration
    if (samples.length > MAX_SAMPLES) throw new Error('too many audio samples')
  }
}

function parseMoof(bytes, moof, movie, samples, state) {
  for (const child of children(bytes, moof)) {
    if (child.type !== 'traf') continue
    const defaults = {
      trackId: null,
      baseDataOffset: null,
      descIndex: movie.trex?.descIndex || 1,
      duration: movie.trex ? movie.trex.duration : null,
      size: movie.trex ? movie.trex.size : null,
    }
    let baseTime = null
    const truns = []
    for (const part of children(bytes, child)) {
      if (part.type === 'tfhd') Object.assign(defaults, parseTfhd(bytes, part))
      else if (part.type === 'tfdt') baseTime = parseTfdt(bytes, part)
      else if (part.type === 'trun') truns.push(part)
    }
    if (defaults.trackId != null && defaults.trackId !== movie.track.trackId) continue
    if (!defaults.descIndex) defaults.descIndex = 1
    const fragSamples = []
    for (const trun of truns) fragSamples.push(...parseTrun(bytes, trun, defaults, moof.start))
    appendFragment(samples, state, baseTime, fragSamples)
  }
}

function collectSamples(bytes) {
  const top = childBoxes(bytes, 0, bytes.length)
  const moov = top.find((box) => box.type === 'moov')
  if (!moov) throw new Error('mp4 has no moov')
  const movie = parseMoov(bytes, moov)
  const fragmented = top.some((box) => box.type === 'moof')
  const samples = []
  const state = { cursor: 0 }
  if (!fragmented) {
    if (!movie.track.moovSamples.length) throw new Error('mp4 has no audio samples')
    return { movie, samples: movie.track.moovSamples }
  }
  for (const box of top) {
    if (box.type === 'moof') parseMoof(bytes, box, movie, samples, state)
  }
  if (!samples.length) throw new Error('mp4 has no audio samples')
  return { movie, samples }
}

function concat(parts) {
  let length = 0
  for (const part of parts) length += part.length
  const out = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function u16(value) {
  const out = new Uint8Array(2)
  const v = value < 0 ? value + 0x10000 : value
  out[0] = (v >> 8) & 0xff
  out[1] = v & 0xff
  return out
}

function u32(value) {
  if (value < 0 || value > 0xffffffff) throw new Error('value does not fit in 32 bits')
  const out = new Uint8Array(4)
  const v = value >>> 0
  out[0] = v >>> 24
  out[1] = (v >>> 16) & 0xff
  out[2] = (v >>> 8) & 0xff
  out[3] = v & 0xff
  return out
}

function u64(value) {
  if (value < 0) throw new Error('negative 64-bit value')
  const hi = Math.floor(value / 0x100000000)
  const lo = value % 0x100000000
  const out = new Uint8Array(8)
  out.set(u32(hi), 0)
  out.set(u32(lo), 4)
  return out
}

function fourcc(type) {
  if (type.length !== 4) throw new Error(`bad box type ${type}`)
  const out = new Uint8Array(4)
  for (let i = 0; i < 4; i += 1) out[i] = type.charCodeAt(i) & 0xff
  return out
}

function ascii(text) {
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0x7f
  return out
}

function box(type, payload) {
  const size = 8 + payload.length
  if (size > 0xffffffff) throw new Error(`${type} box is too large`)
  return concat([u32(size), fourcc(type), payload])
}

function versioned(type, version, flags, payload) {
  const head = new Uint8Array(4)
  head[0] = version & 0xff
  head[1] = (flags >> 16) & 0xff
  head[2] = (flags >> 8) & 0xff
  head[3] = flags & 0xff
  return box(type, concat([head, payload]))
}

function fitsU32(value) {
  return value >= 0 && value <= 0xffffffff
}

function timeFields(version, creation, modification) {
  if (version === 1) return concat([u64(creation), u64(modification)])
  return concat([u32(creation), u32(modification)])
}

function durationField(version, duration) {
  return version === 1 ? u64(duration) : u32(duration)
}

function scaleDuration(value, fromScale, toScale) {
  if (!fromScale || !toScale) return 0
  return Math.floor((value * toScale + Math.floor(fromScale / 2)) / fromScale)
}

function copySamples(bytes, samples) {
  let total = 0
  for (const sample of samples) {
    total += sample.size
    if (total > bytes.length) throw new Error('audio samples are larger than the file')
  }
  if (!total) throw new Error('mp4 has no audio samples')
  const payload = new Uint8Array(total)
  let offset = 0
  for (const sample of samples) {
    if (!sample.size) continue
    payload.set(bytes.subarray(sample.offset, sample.offset + sample.size), offset)
    offset += sample.size
  }
  return payload
}

function timeToSample(samples) {
  const runs = []
  for (const sample of samples) {
    if (sample.duration < 0 || !fitsU32(sample.duration)) throw new Error('sample duration is out of range')
    const last = runs[runs.length - 1]
    if (last && last.delta === sample.duration) last.count += 1
    else runs.push({ count: 1, delta: sample.duration })
  }
  const body = [u32(runs.length)]
  for (const run of runs) body.push(u32(run.count), u32(run.delta))
  return versioned('stts', 0, 0, concat(body))
}

function sampleSizes(samples) {
  let same = samples[0]?.size ?? 0
  for (const sample of samples) {
    if (!fitsU32(sample.size)) throw new Error('sample size is out of range')
    if (sample.size !== same) same = -1
  }
  if (same >= 0) return versioned('stsz', 0, 0, concat([u32(same), u32(samples.length)]))
  const body = [u32(0), u32(samples.length)]
  for (const sample of samples) body.push(u32(sample.size))
  return versioned('stsz', 0, 0, concat(body))
}

function planChunks(samples) {
  const chunks = []
  let payloadOffset = 0
  for (const sample of samples) {
    const descIndex = sample.descIndex || 1
    const current = chunks[chunks.length - 1]
    if (!current || current.descIndex !== descIndex) {
      chunks.push({ descIndex, count: 1, payloadOffset })
    } else {
      current.count += 1
    }
    payloadOffset += sample.size
  }
  return chunks
}

function sampleToChunk(chunks) {
  const entries = []
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i]
    const prev = entries[entries.length - 1]
    if (!prev || prev.samplesPerChunk !== chunk.count || prev.descIndex !== chunk.descIndex) {
      entries.push({ firstChunk: i + 1, samplesPerChunk: chunk.count, descIndex: chunk.descIndex })
    }
  }
  const body = [u32(entries.length)]
  for (const entry of entries) {
    body.push(u32(entry.firstChunk), u32(entry.samplesPerChunk), u32(entry.descIndex))
  }
  return versioned('stsc', 0, 0, concat(body))
}

function chunkOffsets(chunks, dataStart, useCo64) {
  const body = [u32(chunks.length)]
  for (const chunk of chunks) {
    const offset = dataStart + chunk.payloadOffset
    body.push(useCo64 ? u64(offset) : u32(offset))
  }
  return versioned(useCo64 ? 'co64' : 'stco', 0, 0, concat(body))
}

function handlerName(name) {
  const clean = String(name || '')
    .replace(/\0.*$/s, '')
    .replace(/[^\x20-\x7e]/g, '')
  return (clean || 'SoundHandler').slice(0, 64)
}

function buildMoov(movie, samples, dataStart, useCo64) {
  const track = movie.track
  let mediaDuration = 0
  for (const sample of samples) mediaDuration += sample.duration
  if (!mediaDuration) throw new Error('audio duration is empty')
  const movieDuration = scaleDuration(mediaDuration, track.timescale, movie.timescale)
  const creation = movie.creation || track.creation || 0
  const modification = movie.modification || track.modification || creation
  const mvhdVersion = fitsU32(creation) && fitsU32(modification) && fitsU32(movieDuration) ? 0 : 1
  const tkhdVersion = fitsU32(creation) && fitsU32(modification) && fitsU32(movieDuration) ? 0 : 1
  const mdhdVersion = fitsU32(creation) && fitsU32(modification) && fitsU32(mediaDuration) ? 0 : 1
  const chunks = planChunks(samples)
  const ftypDataStart = dataStart
  const stbl = box(
    'stbl',
    concat([
      versioned('stsd', 0, 0, concat([u32(track.sampleEntries.length), track.sampleEntryBytes])),
      timeToSample(samples),
      sampleToChunk(chunks),
      sampleSizes(samples),
      chunkOffsets(chunks, ftypDataStart, useCo64),
    ]),
  )
  const dref = versioned('dref', 0, 0, concat([u32(1), versioned('url ', 0, 1, new Uint8Array(0))]))
  const minf = box(
    'minf',
    concat([
      versioned('smhd', 0, 0, concat([u16(track.balance || 0), u16(0)])),
      box('dinf', dref),
      stbl,
    ]),
  )
  const name = handlerName(track.handlerName)
  const hdlr = versioned(
    'hdlr',
    0,
    0,
    concat([u32(0), fourcc('soun'), new Uint8Array(12), ascii(name), new Uint8Array([0])]),
  )
  const mdhd = versioned(
    'mdhd',
    mdhdVersion,
    0,
    concat([
      timeFields(mdhdVersion, creation, modification),
      u32(track.timescale),
      durationField(mdhdVersion, mediaDuration),
      u16(track.language || 0x55c4),
      u16(0),
    ]),
  )
  const mdia = box('mdia', concat([mdhd, hdlr, minf]))
  const matrix = concat(MATRIX.map((value) => u32(value)))
  const tkhd = versioned(
    'tkhd',
    tkhdVersion,
    track.flags & 0x7 ? track.flags & 0x7 : 0x3,
    concat([
      timeFields(tkhdVersion, creation, modification),
      u32(track.trackId),
      u32(0),
      durationField(tkhdVersion, movieDuration),
      new Uint8Array(8),
      u16(0),
      u16(0),
      u16(0x0100),
      u16(0),
      matrix,
      u32(0),
      u32(0),
    ]),
  )
  const trak = box('trak', concat([tkhd, mdia]))
  const nextTrackId = Math.max(movie.nextTrackId || 0, track.trackId + 1)
  const mvhd = versioned(
    'mvhd',
    mvhdVersion,
    0,
    concat([
      timeFields(mvhdVersion, creation, modification),
      u32(movie.timescale),
      durationField(mvhdVersion, movieDuration),
      u32(0x00010000),
      u16(0x0100),
      u16(0),
      u32(0),
      u32(0),
      matrix,
      new Uint8Array(24),
      u32(nextTrackId),
    ]),
  )
  return box('moov', concat([mvhd, trak]))
}

function ftypFor(codec) {
  const aac = codec === 'mp4a'
  const major = aac ? 'M4A ' : 'isom'
  const brands = aac ? AAC_BRANDS : ISOM_BRANDS
  return box('ftyp', concat([fourcc(major), u32(0), ...brands.map((brand) => fourcc(brand))]))
}

function mdat(payload) {
  const small = 8 + payload.length
  if (small <= 0xffffffff) return concat([u32(small), fourcc('mdat'), payload])
  return concat([u32(1), fourcc('mdat'), u64(16 + payload.length), payload])
}

function offsetsFit(dataStart, chunks) {
  for (const chunk of chunks) {
    if (dataStart + chunk.payloadOffset > 0xffffffff) return false
  }
  return true
}

/**
 * @param {Uint8Array | ArrayBuffer} input fragmented or progressive audio MP4
 * @returns {Uint8Array} progressive MP4, AAC branded `M4A `
 */
export function remuxFragmentedMp4(input) {
  const bytes = toBytes(input)
  if (bytes.length < 16) throw new Error('mp4 is too small')
  const { movie, samples } = collectSamples(bytes)
  const entryCount = movie.track.sampleEntries.length
  for (const sample of samples) {
    if (sample.descIndex < 1 || sample.descIndex > entryCount) {
      throw new Error('sample description index is out of range')
    }
  }
  const codec = movie.track.sampleEntries[0]?.type || ''
  const payload = copySamples(bytes, samples)
  const ftyp = ftypFor(codec)
  const headerLen = payload.length > 0xffffffff - 8 ? 16 : 8
  const chunks = planChunks(samples)
  let moov = buildMoov(movie, samples, 0, false)
  let dataStart = ftyp.length + moov.length + headerLen
  let useCo64 = !offsetsFit(dataStart, chunks)
  if (useCo64) {
    moov = buildMoov(movie, samples, 0, true)
    dataStart = ftyp.length + moov.length + headerLen
  }
  moov = buildMoov(movie, samples, dataStart, useCo64)
  return concat([ftyp, moov, mdat(payload)])
}

export function isMp4AudioType(type) {
  const value = String(type || '').toLowerCase()
  if (!value || value.includes('webm')) return false
  return value.includes('mp4') || value.includes('m4a') || value.includes('aac')
}

/**
 * Remux an mp4/AAC blob. Any failure returns `blob` unchanged.
 * webm and other types are returned unchanged.
 * @param {Blob} blob
 * @param {string} [mimeType]
 * @returns {Promise<Blob>}
 */
export async function remuxMp4Blob(blob, mimeType = '') {
  const type = blob?.type || mimeType || ''
  if (!blob || typeof blob.arrayBuffer !== 'function' || !isMp4AudioType(type)) return blob
  try {
    const output = remuxFragmentedMp4(new Uint8Array(await blob.arrayBuffer()))
    if (!output?.length) return blob
    return new Blob([output], { type: blob.type || mimeType || 'audio/mp4' })
  } catch {
    return blob
  }
}
