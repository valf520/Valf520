import fs from "node:fs";
const V = "3.7.1";
let c = fs.readFileSync("content.js", "utf8");
c = c.replace(/const VERSION = '[^']+';/, "const VERSION = '" + V + "';");
fs.writeFileSync("content.js", c, "utf8");
const m = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
m.version = V;
fs.writeFileSync("manifest.json", JSON.stringify(m, null, 2) + "\n", "utf8");
console.log("version ->", V);
