import { clone, createGitDirectory, catFile, hashObject, lsTree, writeTree, commitTree } from "./git";

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
