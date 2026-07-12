// Bundle ADO Atlas into dist/ado-atlas-extension.zip, ready for the Chrome Web Store.
// This is a pure Node.js replacement for build.ps1/build.bat, which makes it
// fully cross-platform (works on Windows, macOS, and Linux) with zero dependencies.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const root = path.join(__dirname, "..");
const dist = path.join(root, "dist");
const out = path.join(dist, "ado-atlas-extension.zip");

const files = ["manifest.json", "background.js", "index.html", "README.md", "LICENSE", "THIRD-PARTY-NOTICES.md"];
const dirs = ["vendor", "icons", "_locales", "src"];

class ZipArchive {
  constructor() {
    this.entries = [];
    this.offset = 0;
    this.buffers = [];
  }

  addFile(name, content) {
    const nameBuf = Buffer.from(name.replace(/\\/g, "/"), "utf8");
    const compressed = zlib.deflateRawSync(content);
    const crc32 = crc32Compute(content);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // signature
    localHeader.writeUInt16LE(20, 4);        // min version
    localHeader.writeUInt16LE(2048, 6);      // flag (UTF-8)
    localHeader.writeUInt16LE(8, 8);         // DEFLATE
    localHeader.writeUInt16LE(0, 10);        // mod time
    localHeader.writeUInt16LE(0, 12);        // mod date
    localHeader.writeUInt32LE(crc32, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(content.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    const localOffset = this.offset;
    this.buffers.push(localHeader, nameBuf, compressed);
    this.offset += localHeader.length + nameBuf.length + compressed.length;

    this.entries.push({
      nameBuf,
      crc32,
      compressedSize: compressed.length,
      uncompressedSize: content.length,
      localOffset
    });
  }

  toBuffer() {
    const cdBuffers = [];
    let cdSize = 0;

    for (const entry of this.entries) {
      const cdHeader = Buffer.alloc(46);
      cdHeader.writeUInt32LE(0x02014b50, 0); // central dir signature
      cdHeader.writeUInt16LE(20, 4);        // made by
      cdHeader.writeUInt16LE(20, 6);        // min version
      cdHeader.writeUInt16LE(2048, 8);      // flag
      cdHeader.writeUInt16LE(8, 10);        // DEFLATE
      cdHeader.writeUInt16LE(0, 12);
      cdHeader.writeUInt16LE(0, 14);
      cdHeader.writeUInt32LE(entry.crc32, 16);
      cdHeader.writeUInt32LE(entry.compressedSize, 20);
      cdHeader.writeUInt32LE(entry.uncompressedSize, 24);
      cdHeader.writeUInt16LE(entry.nameBuf.length, 28);
      cdHeader.writeUInt16LE(0, 30);
      cdHeader.writeUInt16LE(0, 32);
      cdHeader.writeUInt16LE(0, 34);
      cdHeader.writeUInt16LE(0, 36);
      cdHeader.writeUInt32LE(0, 38);
      cdHeader.writeUInt32LE(entry.localOffset, 42);

      cdBuffers.push(cdHeader, entry.nameBuf);
      cdSize += cdHeader.length + entry.nameBuf.length;
    }

    const cdOffset = this.offset;

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(this.entries.length, 8);
    eocd.writeUInt16LE(this.entries.length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdOffset, 16);
    eocd.writeUInt16LE(0, 20);

    return Buffer.concat([...this.buffers, ...cdBuffers, eocd]);
  }
}

const crc32Table = new Int32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crc32Table[i] = c;
}

function crc32Compute(buf) {
  let crc = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ crc32Table[(crc ^ buf[i]) & 0xFF];
  }
  return (crc ^ -1) >>> 0;
}

// Clean and recreate dist directory
if (fs.existsSync(dist)) {
  fs.rmSync(dist, { recursive: true, force: true });
}
fs.mkdirSync(dist, { recursive: true });

const archive = new ZipArchive();

// Add individual files
for (const f of files) {
  const filePath = path.join(root, f);
  if (fs.existsSync(filePath)) {
    archive.addFile(f, fs.readFileSync(filePath));
  }
}

// Recursively walk and add directories
function addDirectoryRecursively(d) {
  const fullPath = path.join(root, d);
  if (!fs.existsSync(fullPath)) return;

  const list = fs.readdirSync(fullPath);
  list.forEach(file => {
    const filePath = path.join(fullPath, file);
    const relPath = path.join(d, file).replace(/\\/g, "/");
    const stat = fs.statSync(filePath);
    if (stat && stat.isDirectory()) {
      addDirectoryRecursively(relPath);
    } else {
      archive.addFile(relPath, fs.readFileSync(filePath));
    }
  });
}

for (const d of dirs) {
  addDirectoryRecursively(d);
}

fs.writeFileSync(out, archive.toBuffer());
const kb = Math.round(fs.statSync(out).size / 1024);
console.log(`Built ${out} (${kb} KB)`);
