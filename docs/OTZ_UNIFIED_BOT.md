# OTZ 單帳號整合

派單、測試派單、標記所有人、車訊回報、抵達、取消、標記原司機與查群組 ID，統一使用 `LINE_CHANNEL_ACCESS_TOKEN` 對應的 OTZ 主帳號。一般客人叫車及試算規則不變。

## 上線前確認

- `LINE_CHANNEL_ACCESS_TOKEN`、`LINE_CHANNEL_SECRET` 都必須屬於 OTZ 主帳號。
- OTZ 必須已加入所有 `LINE_DISPATCH_GROUP_ID` 與 `LINE_INTAKE_GROUP_IDS` 群組，並能接收群組 webhook。
- 若既有派單機器人的群組加入狀況阻擋 OTZ 入群，由管理員先完成帳號切換；程式不會自動退群或更改 LINE 後台設定。
- 所有主動推送改用 OTZ 額度；額度不足或未入群時不再回退到 A1～A4。
- 不需新資料庫 migration；保留先前已部署的 v5_4、v5_5。

## 路由

- webhook 只驗證主帳號 secret；舊 `LINE_CHANNEL_SECRETS` 不再使用。舊 dispatch token、bot ID 設定也不再使用，不會從環境中刪除它們。
- destination 非 OTZ 的事件不處理，避免多帳號重複建單或回覆。
- 標記須有 LINE mention metadata 指向 OTZ，不能只輸入普通文字 `@OTZ`，也不再用標記 A1～A4 觸發。
- OTZ 顯示名稱不影響判斷，包含「OTZ車隊」也能處理單獨標記與抵達。
- 特定接單群保留標記建單與取消入口；含單號的車訊／抵達回報及單獨標記優先走派單回報，不建新地址單。
- 派單群一般地址文字仍不進入叫車流程，原群組禁止偵測設定保持有效。
- 後台派單測試忽略舊帳號選擇欄位，固定從 OTZ 發出。

## 沿用資料

原 `01-XXXXX`、`OTZ-XXXXXX` 訂單及首次車訊、抵達、取消紀錄保留。取消未抵達訂單時仍以首次車訊的 userId 標記原接單司機；若舊資料中的使用者識別無法被 OTZ 標記，會回報通知失敗而不假裝成功。沒有來源對應的舊單仍需人工處理。
