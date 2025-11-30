const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { clone } = require("./git");

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
  case "write-tree":
    writeTree();
    break;

  case "commit-tree":
    commitTree();
    break;

  case "clone":
    clone(process.argv[3], process.argv[4]);
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

  // create the HEAD file and point it to the main branch by adding "ref: refs/heads/main\n" to it
  fs.writeFileSync(
    path.join(process.cwd(), ".git", "HEAD"),
    "ref: refs/heads/main\n"
  );
  console.log("Initialized git directory");
}

function catFile() {
  const hash = process.argv[4];
  const dir = hash.substring(0, 2); // the first 2 bytes are the directory
  const file = hash.substring(2); // the rest of the hash is the file name

  const objectPath = path.join(process.cwd(), ".git", "objects", dir, file);
  const blob = fs.readFileSync(objectPath);
  const bufferToString = zlib.unzipSync(blob).toString();

  // Extract content after null byte separator
  const nullByteIndex = bufferToString.indexOf("\x00");

  // the content of the blob is after the null byte separator
  const content = bufferToString.substring(nullByteIndex + 1);

  process.stdout.write(content);
}

function hashObject() {
  const fileName = process.argv[4];
  const filePath = path.join(process.cwd(), fileName);
  const hash = hashObjectUtil(filePath);

  process.stdout.write(hash);
}

// helper: create a blob object for a file path and return its SHA-1 hash
function hashObjectUtil(filePath) {
  const fileContent = fs.readFileSync(filePath);
  // the blob is the header (blob <size>\0) + the actual contents of the file
  // { <mode> <name>\0 <content> }
  const blob = `blob ${fileContent.length}\x00${fileContent.toString()}`;

  const objBuffer = Buffer.from(blob);
  const compressedBlob = zlib.deflateSync(objBuffer);

  // Although the object file is stored with zlib compression, the SHA-1 hash needs to be computed over the "uncompressed" contents of the file, not the compressed version.
  // The input for the SHA-1 hash is the header (blob <size>\0) + the actual contents of the file, not just the contents of the file.
  const hash = crypto.createHash("sha1").update(blob).digest("hex");

  // create the directory for the hash
  const dir = hash.substring(0, 2);
  const file = hash.substring(2);

  // store the compressed blob in the .git/objects directory with dir as the directory and file as the file name
  const objectDir = path.join(process.cwd(), ".git", "objects", dir);
  // create the directory if it doesn't exist
  fs.mkdirSync(objectDir, { recursive: true });

  // store the compressed blob in the .git/objects directory
  fs.writeFileSync(path.join(objectDir, file), compressedBlob);

  return hash;
}

function lsTree() {
  const hash = process.argv[4];

  const dir = hash.substring(0, 2); // the first 2 bytes are the directory
  const file = hash.substring(2); // the rest of the hash is the file name

  const objectPath = path.join(process.cwd(), ".git", "objects", dir, file); // the path to the object
  const compressed = fs.readFileSync(objectPath); // read the compressed object
  const buffer = zlib.unzipSync(compressed); // unzip the object

  const nullByteIndex = buffer.indexOf(0); // find the null byte separator
  const body = buffer.subarray(nullByteIndex + 1); // the body of the object

  const entries = []; // the entries of the object
  let i = 0;

  while (i < body.length) {
    const modeEnd = body.indexOf(0x20, i); // space character
    if (modeEnd === -1) break;
    const mode = body.toString("utf8", i, modeEnd); // the mode of the entry

    const nameEnd = body.indexOf(0x00, modeEnd + 1); // null byte character
    if (nameEnd === -1) break;
    const name = body.toString("utf8", modeEnd + 1, nameEnd); // the name of the entry

    const shaStart = nameEnd + 1;
    const shaBuffer = body.subarray(shaStart, shaStart + 20); // the sha of the entry
    const sha = shaBuffer.toString("hex");

    entries.push({ mode, name, sha });

    i = shaStart + 20;
  }

  const nameOnly = process.argv[3] === "--name-only"; // if the user wants only the name of the entries
  const output = entries
    .map((entry) =>
      nameOnly ? entry.name : `${entry.mode} ${entry.sha} ${entry.name}`
    )
    .join("\n"); // join the entries with a newline character

  if (output.length > 0) {
    process.stdout.write(output + "\n");
  }
}

function writeTree() {
  const rootTreeHash = writeTreeForDirectory(process.cwd());
  process.stdout.write(rootTreeHash + "\n");
}

// Recursively write a tree object for the given directory and return its SHA-1 hash
function writeTreeForDirectory(dirPath) {
  let entries = fs
    .readdirSync(dirPath)
    .filter((name) => name !== ".git") // ignore the .git directory
    .sort(); // sort the entries alphabetically

  const treeEntries = [];

  for (const name of entries) {
    const fullPath = path.join(dirPath, name);
    const stat = fs.statSync(fullPath);

    if (stat.isFile()) {
      const sha = hashObjectUtil(fullPath);
      const mode = "100644";
      treeEntries.push({ mode, name, sha });
    } else if (stat.isDirectory()) {
      const sha = writeTreeForDirectory(fullPath);
      const mode = "40000";
      treeEntries.push({ mode, name, sha });
    }
  }

  const entryBuffers = treeEntries.map((entry) => {
    const header = Buffer.from(`${entry.mode} ${entry.name}\x00`, "utf8");
    const shaBuffer = Buffer.from(entry.sha, "hex");
    return Buffer.concat([header, shaBuffer]);
  });

  const body = Buffer.concat(entryBuffers);
  const header = Buffer.from(`tree ${body.length}\x00`, "utf8");
  const store = Buffer.concat([header, body]); // the store is the header + the body

  const compressed = zlib.deflateSync(store);
  const hash = crypto.createHash("sha1").update(store).digest("hex");

  const dir = hash.substring(0, 2);
  const file = hash.substring(2);
  const objectDir = path.join(process.cwd(), ".git", "objects", dir);
  fs.mkdirSync(objectDir, { recursive: true });
  fs.writeFileSync(path.join(objectDir, file), compressed);

  return hash;
}

function commitTree() {
  // Expected CLI: commit-tree <tree_sha> -p <parent_sha> -m <message>
  const treeHash = process.argv[3];
  const parentHash = process.argv[5];
  const message = process.argv.slice(7).join(" ");

  const timestamp = Math.floor(Date.now() / 1000);
  const authorLine = `author Olsi Gjeci <olsi@codecrafters.io> ${timestamp} +0000\n`;
  const committerLine = `committer Olsi Gjeci <olsi@codecrafters.io> ${timestamp} +0000\n`;

  const commitText = `tree ${treeHash}\n${
    parentHash ? `parent ${parentHash}\n` : ""
  }${authorLine}${committerLine}\n${message}\n`;

  const commitContentBuffer = Buffer.from(commitText, "utf8");
  const header = Buffer.from(
    `commit ${commitContentBuffer.length}\x00`,
    "utf8"
  );
  const store = Buffer.concat([header, commitContentBuffer]);

  const hash = crypto.createHash("sha1").update(store).digest("hex");

  const dir = hash.substring(0, 2);
  const file = hash.substring(2);
  const objectDir = path.join(process.cwd(), ".git", "objects", dir);
  const compressed = zlib.deflateSync(store);

  fs.mkdirSync(objectDir, { recursive: true });
  fs.writeFileSync(path.join(objectDir, file), compressed);

  process.stdout.write(hash + "\n");
}
