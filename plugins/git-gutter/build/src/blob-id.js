function rotateLeft(value, bits) {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0
}

function sha1Words(bytes) {
  const bitLength = bytes.length * 8
  const paddedLength = (bytes.length + 9 + 63) & ~63
  const padded = new Uint8Array(paddedLength)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 4, bitLength >>> 0)
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000))
  let h0 = 0x67452301
  let h1 = 0xefcdab89
  let h2 = 0x98badcfe
  let h3 = 0x10325476
  let h4 = 0xc3d2e1f0
  const w = new Uint32Array(80)
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index++) w[index] = view.getUint32(offset + index * 4)
    for (let index = 16; index < 80; index++) {
      w[index] = rotateLeft(w[index - 3] ^ w[index - 8] ^ w[index - 14] ^ w[index - 16], 1)
    }
    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4
    for (let index = 0; index < 80; index++) {
      let f
      let k
      if (index < 20) {
        f = (b & c) | (~b & d)
        k = 0x5a827999
      } else if (index < 40) {
        f = b ^ c ^ d
        k = 0x6ed9eba1
      } else if (index < 60) {
        f = (b & c) | (b & d) | (c & d)
        k = 0x8f1bbcdc
      } else {
        f = b ^ c ^ d
        k = 0xca62c1d6
      }
      const temp = (rotateLeft(a, 5) + f + e + k + w[index]) >>> 0
      e = d
      d = c
      c = rotateLeft(b, 30)
      b = a
      a = temp
    }
    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
  }
  return [h0, h1, h2, h3, h4]
}

function toHex(words) {
  return words.map((word) => word.toString(16).padStart(8, "0")).join("")
}

export function gitBlobId(text) {
  const content = new TextEncoder().encode(text)
  const header = new TextEncoder().encode(`blob ${content.length}\0`)
  const store = new Uint8Array(header.length + content.length)
  store.set(header, 0)
  store.set(content, header.length)
  return toHex(sha1Words(store))
}

export function gitBlobIds(rawText, normalizedText) {
  const raw = gitBlobId(rawText)
  if (normalizedText === rawText) return [raw]
  const normalized = gitBlobId(normalizedText)
  return raw === normalized ? [raw] : [raw, normalized]
}
