// Persona 好友加载器：聊天列表、联系人、朋友圈全部 read 自 contacts 数据目录。
// 加一个人 = site/assets/contacts/<id>/ 放 avatar + profile.md + moments.md，
// 另外 prompts/personas/ 加 persona-<id>.md，worker.py 白名单加 "persona-<id>"。
//
// profile.md：一行一个 key: value（name/status/preview/time/avatar）。
// moments.md：一行一条动态 `when — text`，# 开头当注释跳过。

const IDS = ["leo", "chole", "sam"];
const DIR = "assets/contacts/";

async function fetchText(url) {
  const res = await fetch(url);
  return res.ok ? res.text() : "";
}

// 作息表（schedule.json）。缺文件返回 null，节奏模块自己降级。
async function fetchJson(url) {
  try { return JSON.parse(await fetchText(url)); } catch { return null; }
}

// 全站就这一个解析器：只认「key: value」行和 `when — text` 行，别加语法。
function parseProfile(md) {
  const out = {};
  for (const line of md.split("\n")) {
    const i = line.indexOf(":");
    if (i < 1) continue;
    const key = line.slice(0, i).trim();
    const val = line.slice(i + 1).trim();
    if (key && val) out[key] = val.replace(/^"|"$/g, "");
  }
  return out;
}

function parseMoments(md) {
  const out = [];
  for (const raw of md.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf(" — ");
    out.push(i < 0
      ? { time: "", text: line }
      : { time: line.slice(0, i).trim(), text: line.slice(i + 3).trim() });
  }
  return out;
}

// 顺序按 IDS；缺文件不中断，只少一个字段
export async function loadContacts() {
  const people = [];
  for (const id of IDS) {
    const dir = `${DIR}${id}/`;
    const p = parseProfile(await fetchText(dir + "profile.md"));
    p.id = `persona-${id}`;
    p.avatar = p.avatar || `${dir}avatar.png`;
    p.moments = parseMoments(await fetchText(dir + "moments.md"));
    p.schedule = await fetchJson(dir + "schedule.json");
    people.push(p);
  }
  return people;
}
