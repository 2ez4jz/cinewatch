# Cineplex Showtime Watcher

每 15 分钟检查以下两家影院未来 21 天的场次，只保留 **The Odyssey + IMAX + 70mm**：

- Cineplex Cinemas Vaughan（Cineplex theatre ID `7408`）
- Cineplex Cinemas Mississauga / Square One（Cineplex theatre ID `7420`）

发现新 Vista session ID 后，Telegram 通知会包含影院、日期、时间、格式和可直接进入选座/购票页的链接。首次运行默认只建立基线，不会把所有现有场次当成新增通知。

> Cineplex 没有为此提供公开稳定的官方 API。本项目使用其网站当前调用的 theatrical JSON endpoint，因此未来网页接口变更时可能需要维护。请求有超时、指数退避重试，并保持低并发。

## 本地运行

需要 Python 3.11+。

```bash
python -m venv .venv
source .venv/bin/activate        # Windows PowerShell: .venv\Scripts\Activate.ps1
pip install -r requirements.txt
cp .env.example .env             # Windows: copy .env.example .env
```

编辑 `.env`，至少填写：

- `TELEGRAM_BOT_TOKEN`：在 Telegram 找 `@BotFather`，运行 `/newbot` 后取得。
- `TELEGRAM_CHAT_ID`：先给机器人发一条消息，然后浏览器打开 `https://api.telegram.org/bot<你的TOKEN>/getUpdates`，在返回 JSON 的 `message.chat.id` 找到。群聊 ID 通常是负数；若用于群聊，先把机器人加入群并发一条消息。
- `CINEPLEX_SUBSCRIPTION_KEY`：可留空，程序会从 Cineplex 当前前端自动发现。若自动发现失效，可在浏览器开发者工具 Network 中查看 `apis.cineplex.com/.../showtimes` 请求的 `Ocp-Apim-Subscription-Key` 并填入。

运行：

```bash
python watcher.py
```

首次运行会写入 `data/state.json` 作为比较基线。想测试通知，可暂时将 `.env` 中 `NOTIFY_ON_FIRST_RUN=true`，删除本地 `data/state.json` 后运行；测试完恢复为 `false`。

运行测试：

```bash
pip install -r requirements-dev.txt
pytest -q
```

## 部署到 GitHub Actions

1. 在 GitHub 新建一个 repository，把本目录内的全部文件（包括 `.github`）推送到仓库根目录。
2. 打开仓库 **Settings → Secrets and variables → Actions → New repository secret**。
3. 添加 `TELEGRAM_BOT_TOKEN` 和 `TELEGRAM_CHAT_ID`。
4. 可选添加 `CINEPLEX_SUBSCRIPTION_KEY`；不添加时会自动发现当前公共前端键。
5. 打开 **Actions → Watch Cineplex showtimes → Run workflow** 手动跑一次，确认日志成功。首次成功运行只建立基线。
6. 此后 workflow 每 15 分钟触发一次，并把成功结果提交回 `data/state.json`。GitHub 定时任务可能排队几分钟，不保证精确到分钟。

如果仓库开启了分支保护，需允许 GitHub Actions 写入默认分支，或对本 workflow 使用的 bot 放行。仓库的 **Settings → Actions → General → Workflow permissions** 也应选择 **Read and write permissions**；workflow 文件已经声明 `contents: write`。

## 状态与失败行为

- 只有完整抓取成功、且 Telegram 通知成功后才原子更新状态。
- 任一 Cineplex 请求或 Telegram 请求在重试后仍失败，进程会返回非零，旧状态保留；下次运行会再次尝试，因此不会因一次短暂故障漏掉新增场次。
- 日志输出到控制台，可直接在 GitHub Actions 的对应 run 中查看；不会把 token 写入日志。
- `data/state.json` 仅保存公开场次数据，不包含任何秘密。

## 调整

- 修改 `.github/workflows/watch.yml` 的 cron 可调整频率；GitHub Actions cron 使用 UTC。
- 修改 workflow 中 `WATCH_DAYS` 可调整前瞻天数（允许 1–90）。天数越大，请求越多。
- 影院 ID 和名称集中在 `watcher.py` 的 `THEATRES` 常量中。
