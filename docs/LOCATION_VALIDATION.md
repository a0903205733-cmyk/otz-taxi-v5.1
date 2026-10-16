# 地址與地標驗證

所有 LINE 叫車、表單回覆、確認後建單、測試派單、地址擷取轉發、試算車資（含人工模式下的試算）共用 `src/locations.js` 的驗證。

輸入「試算車資」僅開啟詢問上下車地點的流程，不代表後續文字已通過驗證。試算須有兩個驗證成功的地點；一般叫車可以只有上車地點。

## 可能地點片段

先從上下車欄位或路線句子擷取片段，保留人數、行李、特殊需求原文。可去除片段外的「我在」「地址是」「我要叫車」等固定開頭與「謝謝」結尾。不從聊天內容猜測未提供的地點。

單獨的數字、1/2 選項、一般短回覆、我家等代稱、疑問句與不完整片段不會被寫入地址欄位。

## 地址：Geocoding

- 直接查詢原始地址，不預設屏東、東港或以別名補地址。
- 必須有 place_id、formatted_address、有效座標與台灣國別；保留本島服務範圍限制。
- partial_match 為 true 一律拒絕。回傳多個不同且合格的 place_id 也拒絕。
- Geocoding 沒有逐欄 inferred 保證，因此採保守比對：原文須明確包含回傳的縣市、鄉鎮市區、路名，及回傳的門牌／樓室；原文也必須完整出現在正規化的 formatted_address 中。
- 只正規化全半形、空白、臺／台與門牌「之／-」寫法；不校正錯字、不補縣市或門牌。只提供路名但地圖補出門牌時拒絕。
- 提供門牌時，結果須具 street_number 且定位品質為 ROOFTOP；插值門牌不接受。
- 若提供 inferred、replaced、spellCorrected 或未確認元件標記，一律拒絕。

這會比舊版嚴格，例如「東港鎮中山路12號」若回傳「屏東縣」，原文缺少縣市即不接受；可輸入「屏東縣東港鎮中山路12號」。API 本身不能提供的驗證保證不以預設值代替。

## 地名／建築物／景點：Places Text Search（New）

- 必須有 id（place_id）、displayName、formattedAddress、數值座標與台灣國別。
- 名稱僅接受正規化後相同，或一方包含另一方且長度比例至少 90%。不自動替換「高醫」等簡稱為正式名稱。
- 可去除原文中已明確提供、且與回傳地址一致的行政區前綴，再比較地標名稱。
- 兩個不同 id 的候選同分，或最佳分數相差不超過 0.02，視為歧義。若還有下一頁，無法確認唯一性，拒絕此次辨識。
- primaryType 必須在允許清單；未提供 primaryType 時才檢查 types。單有 establishment／point_of_interest 不算通過。
- 允許清單明列在 `src/locations.js` 的 `PLACE_TYPES`，包含交通站點、醫療、學校、旅宿、餐飲、指定商業場所、宗教場所、景點、公共設施及行政地名；未列類型不接受。

## 失敗處理

任一上下車片段不成立，整則訊息結束地點處理，不顯示地址確認、不建立報價或派單，也不把其餘有效片段單獨寫入。API 未啟用、金鑰受限、逾時或錯誤同樣不放行，不改走寬鬆備援。

先前待確認地址在確認建單時再次驗證；只有上車點也必須驗證並保存座標。表單的非地址欄位仍保留原文。

## 設定與測試

沿用 `GOOGLE_MAPS_API_KEY`，Google Cloud 專案需啟用 Geocoding API、Places API（New）及 Routes API，金鑰的 API 限制也需允許這三項。未另行啟用 Address Validation API；地址採上述 Geocoding 保守驗證。

執行 `npm test`。測試以模擬 Google 回應驗證判斷與實際 LINE handler 的行為，不傳送 LINE 訊息、不建立正式訂單、不消耗 Google 查詢額度。

官方參考：
- https://developers.google.com/maps/documentation/geocoding/requests-geocoding
- https://developers.google.com/maps/documentation/places/web-service/text-search
