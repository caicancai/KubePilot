const fs = require("node:fs");
const path = require("node:path");

const helper = path.join(
  process.cwd(),
  "node_modules",
  "node-pty",
  "prebuilds",
  process.platform === "darwin" && process.arch === "arm64" ? "darwin-arm64" : `${process.platform}-${process.arch}`,
  "spawn-helper"
);

if (fs.existsSync(helper)) {
  fs.chmodSync(helper, 0o755);
}
