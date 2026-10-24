// Persona 好友加载器：聊天列表、联系人、朋友圈全部 read 自 contacts 数据目录。
// 加一个人 = site/assets/contacts/<id>/ 放 avatar + contact.json + moments.md，
// 另外 prompts/personas/ 加 persona-<id>.md，worker.py 白名单加 "persona-<id>"。
//
// contact.json：一人一份画像 JSON（name/status/preview/time/avatar + base/burst/hours/glow）。
// moments.md：一行一条动态 `when — text`，# 开头当注释跳过。

const IDS = ["leo", "chole", "sam", "Fiona"];
const DIR = "assets/contacts/";

async function fetchText(url) {
  const res = await fetch(url);
  return res.ok ? res.text() : "";
}

// 作息表（schedule.json）。缺文件返回 null，节奏模块自己降级。
async function fetchJson(url) {
  try { return JSON.parse(await fetchText(url)); } catch { return null; }
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
  // 并行抓取：之前 for-await 串行，6 个请求排队,慢网下首屏黑屏好些秒；
  // Promise.all 一轮 RTT 就齐。
  const people = await Promise.all(IDS.map(async (id) => {
    const dir = `${DIR}${id}/`;
    const d = await fetchJson(dir + "contact.json");
    const p = d || {};
    p.id = `persona-${id}`;
    p.avatar = p.avatar || `${dir}avatar.png`;
    p.moments = parseMoments(await fetchText(dir + "moments.md"));
    // 节奏模块仍走 p.schedule 读 hours/base/burst/glow
    p.schedule = { hours: p.hours, hoursWeekend: p.hoursWeekend, holidays: p.holidays, base: p.base, burst: p.burst, glow: p.glow, reply: p.reply, activeChance: p.activeChance || { away: 0.2, busy: 0.1 } };
    return p;
  }));
  return people;
}
