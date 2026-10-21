# TODO

## AI 好友主动消息（persona ≥ 1）：Web 推送方案

目标：Unit 聊天列表里的多个 AI persona 按规则随机主动给用户发消息，像 LINE 好友一样推送到手机。决定用网站（PWA）形式，不做 App。

### 方案要点
- PWA + Web Push（VAPID）。Android 浏览器直接可用；iOS 16.4+ 需用户「添加到主屏幕」并授权通知，之后锁屏推送可用。
- 后端用 Cloudflare Cron Trigger 定时调度 persona 消息，消息写入聊天记录（KV/D1）。
- 已知难点：worker 是 Python，VAPID/ES256 签名需在 Python Worker 内实现。
- 明确不做：App、商店发布；将来必要时再评估 Capacitor 包壳。

### 工作项（按片拆）
1. [ ] 切片 1（先行验证）：manifest.json + Service Worker + 请求通知授权，后端提供手动触发接口，推送一条测试消息，iOS/Android 真机各验证一次
2. [ ] 切片 2：push subscription 持久化（KV/D1），订阅状态展示
3. [ ] 切片 3：后端消息入聊天记录，前端打开页面同步历史
4. [ ] 切片 4：persona 调度规则（随机时机/频率/配额）+ LLM 生成消息 + Cron 推送

## 备忘
- Unit 教学 RPG 化的想法：3 个 persona 直接当 Unit 教学主角，教学目标藏进轻松聊天的剧情里，整体像一场 RPG。具体剧情映射未定，现阶段 Unit 训练与 persona 好友保持分离（见 prompts/personas.md 现状）。
