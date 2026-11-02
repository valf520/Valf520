import fs from "node:fs";

/* 1) README 特性表补两行 */
let r = fs.readFileSync("README.md", "utf8");
r = r.replace(
  "| 🧠 上下文回复 | 读整段对话再生成，不是关键词匹配 |",
  "| 🧠 上下文回复 | 读整段对话再生成，不是关键词匹配 |\n| ⏸️ 人类停顿 | 生成完先停 8-30 秒再发，停顿期间对方再发就合并重答 |\n| 🧵 连发合并 | 对方连发几条，读完一起回一条，不一条一条答 |");
fs.writeFileSync("README.md", r, "utf8");

/* 2) 版本号 */
const V = "3.7.0";
let c = fs.readFileSync("content.js", "utf8");
c = c.replace(/const VERSION = '[^']+';/, "const VERSION = '" + V + "';");
fs.writeFileSync("content.js", c, "utf8");
const m = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
m.version = V;
fs.writeFileSync("manifest.json", JSON.stringify(m, null, 2) + "\n", "utf8");
console.log("version ->", V);
