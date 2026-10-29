# 教耗材採購（workers-1.3.0）

Cloudflare Workers → must-resource-inventory-api → Edit code → 使用本儲存庫 worker/worker.js 全文取代並 Deploy。保留所有既有環境變數及 Secret。health.version 應為 workers-1.3.0。前台由 GitHub Pages main 自動發布。

本次新增後台「教耗材採購」。姓名由已驗證入口帳號帶入；品名必填，照片及網址選填。所有已有物資後台權限的老師可查看最近50筆共用採購需求。照片先在瀏覽器壓縮為JPG，按「查看照片」才讀取。

新增獨立 purchaseRequests 與 purchasePhotos 集合，不移動、不覆寫 items、loans 或庫存索引。沒有修改Firestore規則，借還權限不變。請用測試需求確認新增與照片查看；npm test通過25項，並非已登入正式環境進行寫入測試。

還原：backup/before-supply-purchases-20261029。Worker還原該分支 worker/worker.js；前端還原該分支 app.js/index.html/style.css。已新增採購需求保留，不刪除。
