// Persona 好友加载器：聊天列表、联系人、朋友圈都从 contacts 目录取头像和名字。
// 加一个人 = site/assets/contacts/<id>/ 放 avatar + contact.json，
// 另外 prompts/personas/ 加 persona-<id>.md，worker.py 白名单加 "persona-<id>"。
//
// contact.json：一人一份画像 JSON（name/status/preview/time/avatar + base/burst/hours/glow）。

const IDS = ["leo", "chole", "sam", "Fiona"];
const DIR = "assets/contacts/";
let contactsPromise = null;

async function fetchText(url) {
  const res = await fetch(url);
  return res.ok ? res.text() : "";
}

// 作息表（schedule.json）。缺文件返回 null，节奏模块自己降级。
async function fetchJson(url) {
  try { return JSON.parse(await fetchText(url)); } catch { return null; }
}

// 顺序按 IDS；缺文件不中断，只少一个字段
export function loadContacts() {
  // 并行抓取：之前 for-await 串行，4 个请求排队，慢网下首屏黑屏好些秒；
  // Promise.all 一轮 RTT 就齐。缓存 promise，避免多个入口重复拉。
  return contactsPromise ??= Promise.all(IDS.map(async (id) => {
    const dir = `${DIR}${id}/`;
    const d = await fetchJson(dir + "contact.json");
    const p = d || {};
    p.id = `persona-${id}`;
    p.avatar = p.avatar || `${dir}avatar.png`;
    return p;
  }));
}
