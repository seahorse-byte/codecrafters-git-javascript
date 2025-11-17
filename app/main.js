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
