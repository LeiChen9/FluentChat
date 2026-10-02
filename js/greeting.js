// 问候语 = 时段开场 + 星期落点
// 两段各自独立成句，所以任意组合都通顺。
// 想改词只需要动这两个字典。

// 时段：[起始小时, 结束小时)
const TIME_SLOTS = [
  { from: 0,  to: 5,  lines: ["Hi，还醒着。", "Hi，夜深了。"] },
  { from: 5,  to: 7,  lines: ["Hi，早。", "Hi，天刚亮。", "Hi，起得挺早。"] },
  { from: 7,  to: 9,  lines: ["Hi，早上好。", "Hi，这会儿清醒吗。", "Hi，醒着就很好。"] },
  { from: 9,  to: 11, lines: ["Hi，上午好。", "Hi，上半场。", "Hi，状态怎么样。"] },
  { from: 11, to: 13, lines: ["Hi，中午好。", "Hi，歇一会儿。", "Hi，午休时间。"] },
  { from: 13, to: 17, lines: ["Hi，下午好。", "Hi，过半了。", "Hi，还撑得住吗。"] },
  { from: 17, to: 19, lines: ["Hi，傍晚了。", "Hi，天快黑了。", "Hi，快到饭点了。"] },
  { from: 19, to: 24, lines: ["Hi，晚上好。", "Hi，今天还顺利吗。", "Hi，忙完了吗。"] },
];

// 星期：键为 Date#getDay()，0 是周日
const WEEKDAYS = {
  0: ["周日了，悠着点。", "明天上班前，说两句？", "周末的尾巴。"],
  1: ["新的一周，慢慢来。", "周一了，先热个身。", "开头最难，开了就好。"],
  2: ["这周才刚开始。", "周二，不急。", "还有几天，慢慢走。"],
  3: ["到一半了。", "周三最容易松劲。", "撑到这里不错了。"],
  4: ["明天就周五了。", "快到周末了。"],
  5: ["周五愉快，下班想做些什么？", "一周结束了，说说今天？", "终于周五了。"],
  6: ["周末愉快，不着急。", "今天想聊点轻松的吗？", "睡个懒觉也行。"],
};

const pick = (lines) => lines[Math.floor(Math.random() * lines.length)];

export function greeting(date = new Date()) {
  const hour = date.getHours();
  const slot = TIME_SLOTS.find((s) => hour >= s.from && hour < s.to) ?? TIME_SLOTS[0];
  return {
    lead: pick(slot.lines),
    hook: pick(WEEKDAYS[date.getDay()]),
  };
}