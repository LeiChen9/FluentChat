# 开发日志 - FluentChat 录音实验

## 背景
原本项目只有「文字链路」可跑（点 Unit → 拿 token → 连 Gemini Live → 显示 AI 转写）。本次实验要加上「麦克风上行」和「AI 音频播放」。

## 已完成
- 前端 live.js：增加 AI 音频播放（解析 serverContent.modelTurn.parts[].inlineData，AudioContext.decodeAudioData 播放 PCM16 base64）
- 前端 live.js：增加麦克风采集（getUserMedia + ScriptProcessor，把 Float32 转 Int16 PCM16，base64 分片发 realtimeInput.audio，mime audio/pcm;rate=24000）
- 前端 live.js：setupComplete 后 600ms 自动开启麦克风，close/onclose 清理麦克风和定时器
- 技术文档 tech_doc.md 增加「环境」一节（conda 环境名 echo）

## 待测试
- 手机端麦克风权限、AI 音频播放、双向对话
- Unit 列表在某些环境下点击无响应（需排查）

