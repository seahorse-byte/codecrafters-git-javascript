const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
console.error("Logs from your program will appear here!");

const command = process.argv[2];

switch (command) {
  case "init":
    createGitDirectory();
    break;
  case "cat-file":
    catFile();
    break;
  case "hash-object":
    hashObject();
    break;
  case "ls-tree":
    lsTree();
    break;
  default:
    throw new Error(`Unknown command ${command}`);
}

function createGitDirectory() {
  fs.mkdirSync(path.join(process.cwd(), ".git"), { recursive: true });
  fs.mkdirSync(path.join(process.cwd(), ".git", "objects"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(process.cwd(), ".git", "refs"), { recursive: true });

  fs.writeFileSync(
    path.join(process.cwd(), ".git", "HEAD"),
    "ref: refs/heads/main\n"
  );
  console.log("Initialized git directory");
}

function catFile() {
  const hash = process.argv[4];
  const dir = hash.substring(0, 2);
  const file = hash.substring(2);

  const objectPath = path.join(process.cwd(), ".git", "objects", dir, file);
  const blob = fs.readFileSync(objectPath);
  const bufferToString = zlib.unzipSync(blob).toString();

  // Extract content after null byte separator
  const nullByteIndex = bufferToString.indexOf("\x00");
  const content = bufferToString.substring(nullByteIndex + 1);
  process.stdout.write(content);
}

function hashObject() {
  const fileName = process.argv[4];

  const fileContent = fs.readFileSync(path.join(process.cwd(), fileName));
  const blob = `blob ${fileContent.length}\x00${fileContent.toString()}`;

  const objBuffer = Buffer.from(blob);
  const compressedBlob = zlib.deflateSync(objBuffer);
  const hash = crypto.createHash("sha1").update(blob).digest("hex");

  const dir = hash.substring(0, 2);
  const file = hash.substring(2);

  const objectPath = path.join(process.cwd(), ".git", "objects", dir, file);
  fs.mkdirSync(path.join(process.cwd(), ".git", "objects", dir), {
    recursive: true,
  });
  fs.writeFileSync(objectPath, compressedBlob);
  process.stdout.write(hash);
}

function lsTree() {
  const hash = process.argv[4];

  const dir = hash.substring(0, 2);
  const file = hash.substring(2);

  const objectPath = path.join(process.cwd(), ".git", "objects", dir, file);
  const compressed = fs.readFileSync(objectPath);
  const buffer = zlib.unzipSync(compressed);

  const nullByteIndex = buffer.indexOf(0);
  const body = buffer.subarray(nullByteIndex + 1);

  const entries = [];
  let i = 0;

  while (i < body.length) {
    const modeEnd = body.indexOf(0x20, i); // space character
    if (modeEnd === -1) break;
    const mode = body.toString("utf8", i, modeEnd);

    const nameEnd = body.indexOf(0x00, modeEnd + 1);
    if (nameEnd === -1) break;
    const name = body.toString("utf8", modeEnd + 1, nameEnd);

    const shaStart = nameEnd + 1;
    const shaBuffer = body.subarray(shaStart, shaStart + 20);
    const sha = shaBuffer.toString("hex");

    entries.push({ mode, name, sha });

    i = shaStart + 20;
  }

  const nameOnly = process.argv[3] === "--name-only";
  const output = entries
    .map((entry) =>
      nameOnly ? entry.name : `${entry.mode} ${entry.sha} ${entry.name}`
    )
    .join("\n");

  if (output.length > 0) {
    process.stdout.write(output + "\n");
  }
}
