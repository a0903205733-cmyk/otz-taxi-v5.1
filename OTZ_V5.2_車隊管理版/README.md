# OTZ 車隊 V5.2 車隊管理版

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
- Supabase Realtime 即時訂單與司機狀態同步
- 新訂單提示音與瀏覽器通知
- 多位車隊成員、獨立帳號與角色
- 車輛、車牌、廠牌、車型、顏色與座位管理
- 後台直接調整計價、LINE 歡迎訊息與忽略關鍵字
- 客戶電話、VIP／黑名單與備註
- 現金／LINE Pay 付款紀錄與電子收據資料
- 一鍵再次叫車與操作紀錄
- 手機版管理後台

## 部署

1. Supabase SQL Editor 執行：
   - `database/upgrade_v4_2.sql`
   - `database/upgrade_v5_0.sql`
   - `database/upgrade_v5_2.sql`

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
