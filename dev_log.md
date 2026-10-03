# 开发日志 - FluentChat 录音实验

## 背景
原本项目只有「文字链路」可跑（点 Unit → 拿 token → 连 Gemini Live → 显示 AI 转写）。本次实验要加上「麦克风上行」和「AI 音频播放」。

## 已完成
- 前端 live.js：AI 音频播放（解析 serverContent.modelTurn.parts[].inlineData）
- 前端 live.js：麦克风采集（getUserMedia + ScriptProcessor，base64 分片发 realtimeInput.audio）
- 前端 live.js：setupComplete 后 600ms 自动开启麦克风，close/onclose 清理麦克风和定时器
- 技术文档 tech_doc.md 增加「环境」一节（conda 环境名 echo）

## 修复：手机上听不到 AI、说话没反应（2026-10-03）

症状：手机端能连上、能看到 AI 的转写文字，但**听不到声音**，且**对着麦克风说话 AI 无反应**。

根因（都在 `site/js/live.js`，是两处独立 bug，再加一个移动端前提）：

| # | 症状 | 原因 | 修法 |
| --- | --- | --- | --- |
| 1 | 听不到 | 用 `decodeAudioData` 解 Gemini 的音频。它是**裸 PCM16，没有 WAV 头**，解码必然 reject，而 `.catch(() => {})` 把错误吞了 → 静音且无任何提示 | 手工把 PCM16 转 Float32 塞进 `AudioBuffer`，按 `playHead` 排队连续播放 |
| 2 | 说了没反应 | 把 `new AudioContext({sampleRate:24000})` 当采集率，但设了之后 `ctx.sampleRate` 被改成 24000，而麦克风真实数据是 48000 → 发上去是**变速音频**（音调被拉低一半），AI 听不懂 | 不强制采样率，按 `ctx.sampleRate` 采，再线性插值降到 **16000**，mime 标 `audio/pcm;rate=16000` |
| 3 | 手机无声 / 麦克风被拒 | `AudioContext` 没在用户手势里创建，一直停在 `suspended` | 点 Unit 时同步调 `ensureAudio()` 解锁 |

顺带修的：
- 麦克风 `ScriptProcessor` 原来直连 `destination`，会把你的声音原样放出来（回声/啸叫）；改成串一个增益 0 的节点。
- 麦克风打不开原来只在 `console.warn`，手机上根本看不到；现在显示到通话卡片上。
- 收到 `serverContent.interrupted` 时停掉已排队的音频，否则被打断后模型还会继续念。
- 采样率魔法数字改成 `MIC_RATE` / `OUT_RATE` 常量。

## 待测试
- 手机端双向对话（音频播放 + 麦克风上行）
- Unit 列表在某些环境下点击无响应（需排查）

