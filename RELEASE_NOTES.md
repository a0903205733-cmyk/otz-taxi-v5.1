# OTZ V5.2.2 Release Notes

- 派單改用全新 `claim_order_v2` JSON RPC，徹底避開 PostgREST 單一物件 coercion 與舊 schema cache 衝突。
- 訂單與司機查詢改為安全的 maybe-single 處理，找不到資料時回傳明確錯誤。

- 修正後台指定司機時 PostgREST 單一 JSON coercion 錯誤。
- 修正 LINE 訊息顯示 `\\n` 的問題。
- 強化台灣本島與常用地標驗證，排除國外、外島及矛盾地點。
- 管理後台拆分未完成與已完成訂單。
- 加入一般單與預約單接單限制。
- 車資使用 Google Maps 替代路線中符合計價規則的最優路線。
- 司機端加入 GPS 派單：Google 最佳駕車時間 20 分鐘內才顯示。
- GPS 派單不使用直線距離算法，並加入必要性判斷與快取以控制 API 用量。
- 整理正式部署文件與 Railway 環境變數範例。
