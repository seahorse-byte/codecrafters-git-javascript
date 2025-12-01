const https = require("https");
const { URL } = require("url");
const zlib = require("zlib");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function createGitDirectory() {
  fs.mkdirSync(path.join(process.cwd(), ".git"), { recursive: true });
  fs.mkdirSync(path.join(process.cwd(), ".git", "objects"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(process.cwd(), ".git", "refs"), { recursive: true });

  // create the HEAD file and point it to the main branch by adding "ref: refs/heads/main\n" to it
  fs.writeFileSync(
    path.join(process.cwd(), ".git", "HEAD"),
    "ref: refs/heads/main\n"
  );
  console.log("Initialized git directory");
}

// ------------------------------------------------------------------
// CONFIGURATION
// ------------------------------------------------------------------
// Try 'https://github.com/git/git.git' if you want to test your RAM!
// const REPO_URL = "https://github.com/octocat/Hello-World.git";

// ------------------------------------------------------------------
// STEP 1: DISCOVERY (HTTP Transport & Pkt-Line)
// ------------------------------------------------------------------

function _fetchRefsWithLogging(repoUrl) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${repoUrl}/info/refs?service=git-upload-pack`);
    console.log(`🔍 Connecting to ${url}`);

    const req = https.request(url, (res) => {
      // --- 1. Log Status & Headers ---
      console.log(`\nS: ${res.statusCode} ${res.statusMessage}`);
      Object.keys(res.headers).forEach((key) => {
        console.log(`S: ${key}: ${res.headers[key]}`);
      });
      console.log("S:"); // Empty line separator
      if (res.statusCode !== 200)
        return reject(new Error(`HTTP ${res.statusCode}`));
      let data = [];
      res.on("data", (c) => data.push(c));
      res.on("end", () => {
        const buffer = Buffer.concat(data);

        // --- 2. Log the Raw Body ---
        // We convert buffer to string, then make invisible chars visible
        const rawString = buffer.toString("utf8");

        // Split by logical packet lines (usually end with newline)
        const lines = rawString.split("\n");

        lines.slice(0, 10).forEach((line) => {
          if (line.length === 0) return;
          let visualLine = line.replace(/\0/g, "\\0");
          console.log(`S: ${visualLine}\\n`);
        });

        resolve(buffer);
      });
    });
    req.on("error", reject);
    req.end();
  });
}

// function fetchRefs(repoUrl) {
//   return new Promise((resolve, reject) => {
//     const url = new URL(`${repoUrl}/info/refs?service=git-upload-pack`);

//     https
//       .request(url, (res) => {
//         if (res.statusCode !== 200)
//           return reject(new Error(`HTTP ${res.statusCode}`));
//         let data = [];
//         res.on("data", (c) => data.push(c));
//         res.on("end", () => {
//           const buffer = Buffer.concat(data);
//           resolve(buffer);
//         });

//         res.on("error", reject);
//         res.end();
//       })
//       .on("error", reject)
//       .end();
//   });
// }

function parsePktLines(buffer) {
  console.log("buffer", buffer);
  // buffer <Buffer 30 30 31 65 23 20 73 65 72 76 69 63 65 3d 67 69 74 2d 75 70 6c 6f 61 64 2d 70 61 63 6b 0a 30 30 30 30 30 31 35 62 37 66 64 31 61 36 30 62 30 31 66 39 ... 150205 more bytes>
  console.log("buffer.length", buffer.length);
  // buffer.length 150255
  let cursor = 0;
  const lines = [];

  while (cursor < buffer.length) {
    // We peek at the first 4 bytes.
    // 1. Read the 4-byte header as a string (e.g., "001e")
    const lengthHeader = buffer.toString("utf8", cursor, cursor + 4);
    cursor += 4;

    // 2. check for Flush Packet
    if (lengthHeader === "0000") {
      lines.push({ type: "flush", data: null });
      continue;
    }

    // Get the entire packet (header + content)
    // 3. Parse the string into a real number (e.g., 30)
    const length = parseInt(lengthHeader, 16);

    // Safety checks
    if (isNaN(length) || length === 0) continue;

    // We want to read the payload now.
    // Start: cursor (4)
    // End:   cursor + (lengthOfPacket - 4)
    const content = buffer
      .toString("utf8", cursor, cursor + (length - 4))
      .trim();

    // We push the content to the lines array.
    lines.push({ type: "data", data: content });

    // We move the cursor forward to next packet
    cursor += length - 4;
  }
  return lines;
}

// ------------------------------------------------------------------
// STEP 2: NEGOTIATION (POST Request)
// ------------------------------------------------------------------

function fetchPackfile(repoUrl, wantHash) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${repoUrl}/git-upload-pack`);
    const caps = "multi_ack_detailed side-band-64k agent=git/node-clone";
    const wantLine = `want ${wantHash} ${caps}\n`;
    const length = (wantLine.length + 4).toString(16).padStart(4, "0");
    const body = `${length}${wantLine}00000009done\n`;

    const options = {
      method: "POST",
      headers: {
        "Content-Type": "application/x-git-upload-pack-request",
        "user-agent": "git/node-clone",
      },
    };

    console.log(`\n📤 Sending Negotiation Request...`);
    const req = https.request(url, options, (res) => {
      if (res.statusCode !== 200)
        return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      let totalSize = 0;
      console.log(`\n📥 Receiving Packfile Stream...`);
      res.on("data", (chunk) => {
        chunks.push(chunk);
        totalSize += chunk.length;
        process.stdout.write(
          `\rDownloaded: ${(totalSize / 1024).toFixed(2)} KB`
        );
      });
      res.on("end", () => {
        console.log("\n✅ Download Complete.");
        resolve(Buffer.concat(chunks));
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ------------------------------------------------------------------
// STEP 3: DEMULTIPLEXING (Side-band)
// ------------------------------------------------------------------

function demuxSideband(buffer) {
  const packDataParts = [];
  let cursor = 0;
  console.log("\n--- 🧶 Demultiplexing Side-band Stream ---");

  while (cursor < buffer.length) {
    const lengthHex = buffer.toString("utf8", cursor, cursor + 4);
    cursor += 4;
    if (lengthHex === "0000") continue;

    const length = parseInt(lengthHex, 16);
    if (isNaN(length)) break;
    const remaining = length - 4;
    const payload = buffer.slice(cursor, cursor + remaining);
    cursor += remaining;

    if (payload.toString("utf8") === "NAK\n") continue;

    const channel = payload[0];
    const content = payload.slice(1);

    if (channel === 1) packDataParts.push(content);
    else if (channel === 2)
      process.stdout.write(`[REMOTE]: ${content.toString("utf8")}`);
    else if (channel === 3)
      console.error(`[REMOTE ERROR]: ${content.toString("utf8")}`);
  }
  return Buffer.concat(packDataParts);
}

// ------------------------------------------------------------------
// STEP 4: PARSING (Packfile & Zlib)
// ------------------------------------------------------------------
class PackParser {
  constructor(buffer) {
    this.buffer = buffer;
    this.cursor = 0;
    this.objects = [];
  }

  read(bytes) {
    const chunk = this.buffer.slice(this.cursor, this.cursor + bytes);
    this.cursor += bytes;
    return chunk;
  }

  inflateAsync(bufferSlice) {
    return new Promise((resolve, reject) => {
      const inflate = zlib.createInflate();
      const output = [];
      inflate.on("data", (c) => output.push(c));
      inflate.on("error", reject);
      inflate.on("end", () =>
        resolve({
          data: Buffer.concat(output),
          bytesRead: inflate.bytesWritten,
        })
      );
      inflate.write(bufferSlice);
      inflate.end();
    });
  }

  async parse() {
    console.log("\n--- 🔓 Parsing Packfile ---");
    const sig = this.read(4).toString("utf8");
    if (sig !== "PACK") throw new Error("Invalid Signature");

    this.read(4); // Version
    const numObjects = this.read(4).readUInt32BE(0);
    console.log(`Objects to parse: ${numObjects}`);

    for (let i = 0; i < numObjects; i++) {
      await this.parseObject(i);
    }
    return this.objects;
  }

  async parseObject(index) {
    const objStartOffset = this.cursor;
    let byte = this.read(1)[0];
    const typeId = (byte & 0x70) >> 4;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = this.read(1)[0];
      size += (byte & 0x7f) << shift;
      shift += 7;
    }

    const typeMap = {
      1: "COMMIT",
      2: "TREE",
      3: "BLOB",
      4: "TAG",
      6: "OFS_DELTA",
      7: "REF_DELTA",
    };
    const typeStr = typeMap[typeId] || "UNKNOWN";

    let deltaBase = null;
    if (typeId === 6) {
      let byte = this.read(1)[0];
      let offset = byte & 0x7f;
      while (byte & 0x80) {
        byte = this.read(1)[0];
        offset = ((offset + 1) << 7) | (byte & 0x7f);
      }
      deltaBase = objStartOffset - offset;
    } else if (typeId === 7) {
      deltaBase = this.read(20).toString("hex");
    }

    const { data, bytesRead } = await this.inflateAsync(
      this.buffer.slice(this.cursor)
    );
    this.cursor += bytesRead;

    this.objects.push({
      index,
      offset: objStartOffset,
      type: typeStr,
      typeId,
      size,
      deltaBase,
      data,
    });
  }
}

// ------------------------------------------------------------------
// STEP 5: DELTA RESOLUTION
// ------------------------------------------------------------------

function applyDelta(baseBuf, deltaBuf) {
  let cursor = 0;
  const readVarInt = () => {
    let num = 0,
      shift = 0,
      byte;
    do {
      byte = deltaBuf[cursor++];
      num |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    return num;
  };

  readVarInt(); // Source size
  const targetSize = readVarInt(); // Target size
  const targetBuf = Buffer.alloc(targetSize);
  let targetIdx = 0;

  while (cursor < deltaBuf.length) {
    const opcode = deltaBuf[cursor++];
    if ((opcode & 0x80) === 0) {
      const length = opcode & 0x7f;
      deltaBuf.copy(targetBuf, targetIdx, cursor, cursor + length);
      cursor += length;
      targetIdx += length;
    } else {
      let offset = 0,
        size = 0;
      if (opcode & 0x01) offset |= deltaBuf[cursor++] << 0;
      if (opcode & 0x02) offset |= deltaBuf[cursor++] << 8;
      if (opcode & 0x04) offset |= deltaBuf[cursor++] << 16;
      if (opcode & 0x08) offset |= deltaBuf[cursor++] << 24;
      if (opcode & 0x10) size |= deltaBuf[cursor++] << 0;
      if (opcode & 0x20) size |= deltaBuf[cursor++] << 8;
      if (opcode & 0x40) size |= deltaBuf[cursor++] << 16;
      if (size === 0) size = 0x10000;
      baseBuf.copy(targetBuf, targetIdx, offset, offset + size);
      targetIdx += size;
    }
  }
  return targetBuf;
}

function resolveAllDeltas(objects) {
  console.log("\n--- 🔗 Resolving Deltas ---");
  const offsetMap = new Map();
  const hashMap = new Map();
  objects.forEach((obj) => offsetMap.set(obj.offset, obj));

  // Compute hashes for non-delta objects first (needed for REF_DELTA)
  function computeHash(obj) {
    const header = Buffer.from(
      `${obj.type.toLowerCase()} ${obj.data.length}\0`
    );
    const store = Buffer.concat([header, obj.data]);
    return crypto.createHash("sha1").update(store).digest("hex");
  }

  // First pass: resolve non-delta objects and build hash map
  for (const obj of objects) {
    if (obj.typeId !== 6 && obj.typeId !== 7) {
      obj.resolvedData = obj.data;
      const hash = computeHash(obj);
      hashMap.set(hash, obj);
    }
  }

  function resolve(obj) {
    if (obj.resolvedData) return obj.resolvedData;
    if (obj.typeId !== 6 && obj.typeId !== 7) {
      obj.resolvedData = obj.data;
      return obj.data;
    }

    let baseObj;
    if (obj.typeId === 6) {
      // OFS_DELTA: deltaBase is an offset
      baseObj = offsetMap.get(obj.deltaBase);
    } else {
      // REF_DELTA: deltaBase is a SHA hash
      baseObj = hashMap.get(obj.deltaBase);
    }

    if (!baseObj)
      throw new Error(
        `Base object not found for ${
          obj.typeId === 6 ? "offset " + obj.deltaBase : "hash " + obj.deltaBase
        }`
      );
    obj.resolvedData = applyDelta(resolve(baseObj), obj.data);
    obj.type = baseObj.type;

    // Add resolved delta to hash map (it might be a base for another delta)
    const hash = computeHash(obj);
    hashMap.set(hash, obj);

    return obj.resolvedData;
  }

  let count = 0;
  for (const obj of objects) {
    resolve(obj);
    if (obj.typeId === 6 || obj.typeId === 7) count++;
  }
  console.log(`Resolved ${count} deltas.`);
  return objects;
}

// ------------------------------------------------------------------
// STEP 6: INDEXING & CHECKOUT
// ------------------------------------------------------------------
function calculateHash(type, data) {
  const header = `${type} ${data.length}\0`;
  const shasum = crypto.createHash("sha1");
  shasum.update(header);
  shasum.update(data);
  return shasum.digest("hex");
}

async function extractTree(treeHash, currentPath, objMap) {
  const treeObj = objMap.get(treeHash);
  if (!treeObj) return;

  const buffer = treeObj.resolvedData;
  let cursor = 0;

  while (cursor < buffer.length) {
    const modeEnd = buffer.indexOf(" ", cursor);
    const nameEnd = buffer.indexOf(0, cursor);
    if (modeEnd === -1 || nameEnd === -1) break;

    const name = buffer.slice(modeEnd + 1, nameEnd).toString("utf8");
    const hash = buffer.slice(nameEnd + 1, nameEnd + 21).toString("hex");
    cursor = nameEnd + 21;

    const entryPath = path.join(currentPath, name);
    const object = objMap.get(hash);

    if (object) {
      if (object.type === "BLOB") {
        console.log(`📝 Writing: ${entryPath}`);
        fs.writeFileSync(entryPath, object.resolvedData);
      } else if (object.type === "TREE") {
        console.log(`📂 Entering: ${entryPath}`);
        if (!fs.existsSync(entryPath)) fs.mkdirSync(entryPath);
        await extractTree(hash, entryPath, objMap);
      }
    }
  }
}

async function clone(repoUrl, targetDir) {
  try {
    // Create target directory
    if (targetDir) fs.mkdirSync(targetDir, { recursive: true });

    const workDir = targetDir || ".";

    console.log("--- Step 1: Discovery ---");
    const refsBuffer = await _fetchRefsWithLogging(repoUrl);
    const lines = parsePktLines(refsBuffer);
    const headLine = lines.find((l) => l.data && l.data.includes("HEAD"));
    if (!headLine) throw new Error("No HEAD found");
    const wantHash = headLine.data.split(" ")[0];
    console.log(`🎯 HEAD: ${wantHash}`);

    console.log("\n--- Step 2: Negotiation ---");
    const rawResponse = await fetchPackfile(repoUrl, wantHash);

    console.log("\n--- Step 3: Demux ---");
    const purePackfile = demuxSideband(rawResponse);

    console.log("\n--- Step 4: Parse ---");
    const packParser = new PackParser(purePackfile);
    const rawObjects = await packParser.parse();

    // Step 5: Resolve
    const resolvedObjects = resolveAllDeltas(rawObjects);

    // Step 6: Create .git directory structure
    const gitDir = path.join(workDir, ".git");
    fs.mkdirSync(path.join(gitDir, "objects"), { recursive: true });
    fs.mkdirSync(path.join(gitDir, "refs", "heads"), { recursive: true });
    fs.writeFileSync(path.join(gitDir, "HEAD"), `ref: refs/heads/main\n`);

    // Write all objects to .git/objects
    console.log("\n--- � Writing Objects ---");
    const objMap = new Map();
    resolvedObjects.forEach((obj) => {
      const hash = calculateHash(obj.type.toLowerCase(), obj.resolvedData);
      objMap.set(hash, obj);

      // Write object to .git/objects
      const header = Buffer.from(
        `${obj.type.toLowerCase()} ${obj.resolvedData.length}\0`
      );
      const store = Buffer.concat([header, obj.resolvedData]);
      const compressed = zlib.deflateSync(store);
      const objDir = path.join(gitDir, "objects", hash.substring(0, 2));
      fs.mkdirSync(objDir, { recursive: true });
      fs.writeFileSync(path.join(objDir, hash.substring(2)), compressed);
    });

    // Write HEAD ref
    fs.writeFileSync(
      path.join(gitDir, "refs", "heads", "main"),
      wantHash + "\n"
    );

    // Step 7: Checkout
    console.log("\n--- 💿 Checking Out ---");
    const commitObj = objMap.get(wantHash);
    const treeHash = commitObj.resolvedData
      .toString("utf8")
      .match(/tree ([0-9a-f]{40})/)[1];

    console.log(`Root Tree: ${treeHash}`);
    await extractTree(treeHash, workDir, objMap);

    console.log("\n✅ CLONE COMPLETE!");
  } catch (err) {
    console.error("❌ Error:", err.message);
  }
}

module.exports = { clone, createGitDirectory };
