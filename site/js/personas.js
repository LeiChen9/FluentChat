// Persona 好友注册表：聊天列表、联系人、朋友圈全从这份读。
// 加一个人 = prompts/personas/ 加 persona-x.md + worker.py 白名单一行 + 这里一行。
// id 就是发 /token 的 unit 字段，必须和 worker.py 的 PERSONAS 白名单一致。

export const PERSONAS = [
  {
    id: "persona-leo",
    name: "Leo",
    avatar: "assets/contacts/leo/avatar.png",
    tag: "咖啡车小哥 · 波特兰",
    // 列表预览：像对方刚发来的一句话
    msg: "Yo! 一个客人今天把咖啡打翻在我手上了 🌯",
    time: "09:12",
  },
  {
    id: "persona-chole",
    name: "Chole",
    avatar: "assets/contacts/chole/avatar.jpg",
    tag: "花店店员 · 曼彻斯特",
    msg: "窗台的花开了，超 lovely :)",
    time: "昨天",
  },
  {
    id: "persona-sam",
    name: "Sam",
    avatar: "assets/contacts/sam/avatar.png",
    tag: "忘年交 · 多伦多",
    msg: "Got a mini task for you 🎣",
    time: "周日",
  },
];

// 朋友圈的假动态（本期静态占位，之后由后端生成）
export const MOMENTS = [
  {
    who: "persona-leo",
    text: "Runner-up today! Sold out before 2pm 🔥",
    time: "09:12",
  },
  {
    who: "persona-chole",
    text: "Miso thinks my raincoat is his bed.",
    time: "19:47",
  },
  {
    who: "persona-sam",
    text: "One bass, two hours of patience. Worth it.",
    time: "周日",
  },
];
