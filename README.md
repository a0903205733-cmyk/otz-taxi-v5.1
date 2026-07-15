# OTZ 車隊 V5.3.6 正式版

這是目前唯一應部署的 OTZ 車隊正式版本，整合 LINE 叫車、Google Maps 路線與估價、Supabase、管理後台及司機端。

## 已完成

- LINE 解析上下車地點、時間與人數，確認／取消叫車。
- LINE 訊息正常換行；忽略「常見問題」「試算車資」「應徵司機」。
- LINE 群組安靜模式：只有「我要叫車」或完整起訖地點才介入。
- 支援中文數字時間與 `08/30 22:10` 等日期時間格式。
- 上車時間超過目前30分鐘自動歸類預約單；過期超過30分鐘拒絕建立。
- 支援 `2位`、`人數：2位`、`2位乘客`、`2大1小`，人數文字不會混入地點。
- 台灣縣市與鄉鎮簡稱可接受，包含東港、林邊、潮州、佳冬、枋寮、高雄及台北。
- 高醫、高雄榮總、高雄長庚、夢時代等常用地標使用固定正式名稱與地址。
- Google Maps 台灣本島地點驗證，排除國外與外島。
- 高醫、高雄榮總、夢時代等常用地標校正；矛盾地點拒絕估價。
- 多條 Google 路線依目前計價規則選擇最優方案。
- Supabase 訂單、客戶、司機、車輛、付款、收據及操作紀錄。
- 管理後台：未完成／已完成分區、派單、改價、取消、完成及響應式手機版。
- 多司機與車輛管理、車號、車型及車隊角色。
- 司機獨立帳號、接單、開始、完成及狀態管理。
- 同一時間只允許一張一般進行中訂單。
- 已接預約單在上車前 30 分鐘禁止再接新單。
- 司機 GPS 到上車點，僅 Google 最佳駕車時間 20 分鐘內顯示待接單。
- Google 路線快取；沒有必要時不重複呼叫 API。
- Supabase Realtime、提示音及 Browser Notification。
- 系統設定、客戶電話、VIP／黑名單、現金／LINE Pay、電子收據、一鍵再次叫車及操作紀錄。
- `/health` 系統健康檢查。

## 首次或升級部署

1. 依序在 Supabase SQL Editor 執行：
   - `database/upgrade_v4_2.sql`
   - `database/upgrade_v5_0.sql`
   - `database/upgrade_v5_2.sql`

   已執行過前兩支時，只需重新執行最新版 `upgrade_v5_2.sql`。Migration 可重複執行。

2. Railway 必要環境變數：
   - `LINE_CHANNEL_SECRET`
   - `LINE_CHANNEL_ACCESS_TOKEN`
   - `GOOGLE_MAPS_API_KEY`
   - `SUPABASE_URL`
   - `SUPABASE_SECRET_KEY`
   - `JWT_SECRET`
   - `ADMIN_TOKEN`
   - `PORT=8080`

3. 將本專案完整上傳到 GitHub 根目錄，等待 Railway 自動部署。

4. 驗證：
   - `/health` 應顯示 `version: 5.3.6` 且各服務為 `true`。
   - `/admin/` 管理後台。
   - `/driver/` 司機端；必須允許精確位置及瀏覽器通知。

## 注意

- 不要上傳 `.env`、LINE Token、Supabase Secret 或 JWT Secret 到 GitHub。
- 舊訂單沒有上車座標，不會自動推送到司機端；新建立訂單才使用 GPS 20 分鐘規則。
- 正式營運前請完成 LINE、管理後台、司機端與預約限制的實機測試。
