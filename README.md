# OTZ 車隊 V5.0 核心正式版

這是 V5 的第一個乾淨核心版本。

已包含：
- LINE 官方帳號叫車
- 自動解析上下車地點、時間、人數
- Google Maps Routes API
- 自動估價
- Supabase 訂單資料庫
- 管理後台
- 司機獨立帳號與 JWT 登入
- 接單／開始行程／完成訂單
- LINE 客戶通知
- 忽略「常見問題」「試算車資」「應徵司機」
- `/health` 健康檢查
- `settings` 系統設定資料表

## 部署

1. Supabase SQL Editor 執行：
   - `database/upgrade_v4_2.sql`
   - `database/upgrade_v5_0.sql`

2. Railway 確認環境變數：
   - LINE_CHANNEL_SECRET
   - LINE_CHANNEL_ACCESS_TOKEN
   - GOOGLE_MAPS_API_KEY
   - SUPABASE_URL
   - SUPABASE_SECRET_KEY
   - JWT_SECRET
   - ADMIN_TOKEN
   - PORT=8080

3. GitHub 根目錄只保留：
   - src/
   - public/
   - database/
   - docs/
   - package.json
   - README.md
   - .env.example

4. 網址：
   - 管理後台：`/admin/`
   - 司機端：`/driver/`
   - 健康檢查：`/health`
