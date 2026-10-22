# TODO

## AI 好友主动消息（persona ≥ 1）：Web 推送方案

目标：Unit 聊天列表里的多个 AI persona 按规则随机主动给用户发消息，像 LINE 好友一样推送到手机。决定用网站（PWA）形式，不做 App。

### 方案要点
- PWA + Web Push（VAPID）。Android 浏览器直接可用；iOS 16.4+ 需用户「添加到主屏幕」并授权通知，之后锁屏推送可用。
- 推送发送由 Python Worker 通过 Service Binding 委托给 JS `fluentchat-pusher` Worker 和 `web-push` 库。
- 后台主动消息尚未实现；需要先定义服务端用户/聊天记录数据模型，再设计 Cron 调度及用户互动状态同步。
- 明确不做：App、商店发布；将来必要时再评估 Capacitor 包壳。

### 工作项（按片拆）
1. [x] PWA manifest、Service Worker、用户授权、KV 订阅登记及 iPhone 锁屏横幅真机验证
2. [ ] 服务端聊天记录/用户模型及多设备数据隔离
3. [ ] persona 调度规则、互动状态同步、LLM 消息生成及 Cron 推送

## 备忘
- Unit 教学 RPG 化的想法：3 个 persona 直接当 Unit 教学主角，教学目标藏进轻松聊天的剧情里，整体像一场 RPG。具体剧情映射未定，现阶段 Unit 训练与 persona 好友保持分离（见 prompts/personas.md 现状）。
