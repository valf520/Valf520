import fs from "node:fs";
const p = "kb/retrieve.js";
let s = fs.readFileSync(p, "utf8");
s = s.replace("if (c.path === 'core') s *= 0.7;", "if (c.path === 'core') s *= 0.55;");
fs.writeFileSync(p, s, "utf8");
console.log("core penalty -> 0.55");
