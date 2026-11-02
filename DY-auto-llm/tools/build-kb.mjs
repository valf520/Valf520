/**
 * 把 goutoujunshi skill 的 references/ 切成检索用的知识块，并额外产出路由表。
 *
 *   node tools/build-kb.mjs [skill 目录] [输出目录]
 *
 * 输出：
 *   kb/kb.json      { builtAt, source, version, docs:[...], chunks:[...] }
 *   kb/routes.json  [{ k:[关键词...], f:"references/..." }]   ← 从 SKILL.md 的「按需加载」表抽出来
 *
 * 每个 chunk 带：doc（文档名）、path（knowledge/practical/core）、sec（小节）、idx（文档内序号）、kind（text/table）
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.argv[2] || 'E:/dsh/_recon/goutoujunshi';
const OUTDIR = process.argv[3] || 'E:/tool/douying-messageself/DY-auto-llm/kb';
const MAX_CHUNK = 1000;
const MIN_CHUNK = 80;

function walk(dir, acc = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (/\.md$/i.test(name)) acc.push(p);
  }
  return acc;
}

/** "07-沟通冲突与修复.md" -> "沟通冲突与修复" */
function docName(file) {
  const base = path.basename(file, '.md');
  return base.replace(/^\d+[-—\s]*/, '').trim() || base;
}

function splitLong(text, max) {
  if (text.length <= max) return [text];
  const parts = [];
  let buf = '';
  for (const line of text.split('\n')) {
    if (buf.length + line.length + 1 > max && buf) { parts.push(buf); buf = ''; }
    buf += (buf ? '\n' : '') + line;
  }
  if (buf.trim()) parts.push(buf);
  return parts;
}

/** 判断一块是不是以表格为主 */
function isTable(text) {
  const lines = text.split('\n').filter((l) => l.trim());
  if (!lines.length) return false;
  const tableLines = lines.filter((l) => l.trim().startsWith('|')).length;
  return tableLines >= 3 && tableLines / lines.length >= 0.4;
}

function parseDoc(file, rel) {
  const raw = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const kindPath = rel.includes('references/knowledge') ? 'knowledge'
    : rel.includes('references/practical') ? 'practical'
    : 'core';

  const lines = raw.split('\n');
  let title = docName(file);
  let sec = '';
  const out = [];
  let buf = [];
  let seq = 0;

  const flush = () => {
    const text = buf.join('\n').trim();
    if (text) {
      for (const piece of splitLong(text, MAX_CHUNK)) {
        out.push({
          id: rel + '#' + seq,
          file: rel,
          doc: title,
          path: kindPath,
          sec,
          idx: seq,
          kind: isTable(piece) ? 'table' : 'text',
          text: piece,
        });
        seq++;
      }
    }
    buf = [];
  };

  for (const line of lines) {
    const h1 = line.match(/^#\s+(.+)/);
    const h2 = line.match(/^##\s+(.+)/);
    if (h1) { title = h1[1].trim().replace(/^\d+[-—\s]*/, ''); continue; }
    if (h2) { flush(); sec = h2[1].trim(); continue; }
    buf.push(line);
  }
  flush();

  return out.filter((c) => !/^---\n[\s\S]*?\n---/.test(c.text.slice(0, 200)));
}

/* ---------------- 抽 SKILL.md 里的路由表 ---------------- */

function parseRoutes(repoRoot) {
  const p = path.join(repoRoot, 'SKILL.md');
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n').split('\n');
  const routes = [];
  let inTable = false;
  for (const line of lines) {
    if (/^##\s*按需加载/.test(line)) { inTable = true; continue; }
    if (inTable && /^##\s/.test(line)) break;
    if (!inTable) continue;
    if (!line.trim().startsWith('|')) continue;
    if (/^\|\s*-{2,}/.test(line.trim())) continue;

    const cells = line.split('|').map((s) => s.trim()).filter((s) => s !== '');
    if (cells.length < 2) continue;
    if (/^当前问题/.test(cells[0])) continue;                       // 表头

    const keys = cells[0].split(/[、,，/]/).map((s) => s.replace(/[「」“”"]/g, '').trim()).filter((s) => s.length >= 2);
    const files = [...cells[1].matchAll(/`([^`]+\.md)`/g)].map((m) => m[1].replace(/^\.\//, ''));
    if (keys.length && files.length) routes.push({ k: keys, f: files });
  }
  return routes;
}

/* ---------------- 跑 ---------------- */

const files = walk(path.join(ROOT, 'references'));
const skill = path.join(ROOT, 'SKILL.md');
if (fs.existsSync(skill)) files.unshift(skill);

const chunks = [];
for (const f of files) {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  chunks.push(...parseDoc(f, rel));
}

const kept = chunks.filter((c) => c.text.replace(/\s/g, '').length >= MIN_CHUNK);
const dropped = chunks.length - kept.length;

const docs = [];
for (const c of kept) {
  let d = docs.find((x) => x.file === c.file);
  if (!d) { d = { file: c.file, doc: c.doc, path: c.path, n: 0, chars: 0 }; docs.push(d); }
  d.n++;
  d.chars += c.text.length;
}

const routes = parseRoutes(ROOT);

fs.mkdirSync(OUTDIR, { recursive: true });
fs.writeFileSync(path.join(OUTDIR, 'kb.json'), JSON.stringify({
  builtAt: new Date().toISOString().slice(0, 10),
  source: 'github.com/shengjidaguai-china/goutoujunshi',
  docs,
  chunks: kept,
}), 'utf8');
fs.writeFileSync(path.join(OUTDIR, 'routes.json'), JSON.stringify(routes, null, 1), 'utf8');

const byKind = kept.reduce((a, c) => { a[c.path] = (a[c.path] || 0) + 1; return a; }, {});
const tables = kept.filter((c) => c.kind === 'table').length;

console.log('chunks   :', kept.length, JSON.stringify(byKind), '（丢弃短块 ' + dropped + '）');
console.log('表格块   :', tables);
console.log('文档     :', docs.length);
console.log('路由     :', routes.length, '条 →', routes.slice(0, 3).map((r) => r.k.join('/')).join(' , '));
console.log('kb.json  :', (fs.statSync(path.join(OUTDIR, 'kb.json')).size / 1024).toFixed(1) + ' KB');
console.log('routes   :', fs.statSync(path.join(OUTDIR, 'routes.json')).size, 'bytes');
