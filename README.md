# CineWatch

一个只关注 GTA 两家真正 IMAX 70mm 影院的轻量座位监控页：

- Cineplex Cinemas Vaughan（theatre ID `7408`）
- Cineplex Cinemas Mississauga / Square One（theatre ID `7420`）
- 只保留 `experienceTypes` 同时包含 `IMAX` 与 `70mm` 的场次
- 展示场次、实时座位图、可选座位数量和 Cineplex 购票链接

网站：https://2ez4jz.github.io/cinewatch/

## 新日期推送（第二版）

当任一影院首次出现新的 IMAX 70mm 放映日期时，系统会立即通过 Telegram 推送影院、日期、电影、场次时间和网站入口。同一天增加新场次不会重复提醒，旧日期也不会在启用功能时集中补发。

在仓库 `Settings → Secrets and variables → Actions` 中添加：

- `TELEGRAM_BOT_TOKEN`：通过 Telegram 的 `@BotFather` 创建机器人后获得
- `TELEGRAM_CHAT_ID`：与你的机器人对话后，通过 `getUpdates` 获得的个人 chat ID

如果 Telegram 临时发送失败，该日期不会被标记为已通知，下一轮会再次尝试；推送失败也不会让整个座位刷新任务报错。

## 刷新机制

GitHub Actions 约每 5 分钟运行一次 quick scan：检查未来 14 天，以及此前已经发现的所有远期日期。这样已知远期场次的座位也会持续刷新。

每天执行一次 deep scan，逐日检查未来 180 天，用来发现刚开放销售的远期场次。也可以在 Actions 页面手动选择 `deep` 运行。

GitHub 的 scheduled workflows 是尽力调度，繁忙时可能晚于标称的 5 分钟。

## API key

脚本优先读取仓库 Secret `CINEPLEX_SUBSCRIPTION_KEY`。未设置时，会尝试从 Cineplex 当前公开网页所加载的前端 JavaScript 中自动发现其公开 API subscription key。如果 Cineplex 改版导致自动发现失效，再添加 Secret 即可。

## 本地检查

```bash
npm test
npm run check
CINEPLEX_SUBSCRIPTION_KEY=... SCRAPE_MODE=quick node scripts/scrape.mjs
python -m http.server 8000
```

## 说明

本项目不是 Cineplex 官方产品，使用的是 Cineplex 网站当前使用的未公开接口，接口结构或访问方式可能随时变化。

座位抓取的数据压缩方式参考了 MIT 授权项目 [ariesyous/cinescan](https://github.com/ariesyous/cinescan)，并针对仅两家 IMAX 70mm 影院的用途重新实现。
