# 資教物資管理系統（Workers 1.1.0）

網站由 GitHub Pages 發布，後端使用 Cloudflare Workers 與獨立 Firebase Firestore。管理者使用入口的 Google 登入與 portalUsers 權限；學生不用帳號。functions 資料夾保留舊版本程式，現在不部署 Firebase Functions。

## 部署更新
在 Cloudflare 的 must-resource-inventory-api Worker，Edit code 貼上 worker/worker.js 全文並 Deploy。保留既有 FIREBASE_PROJECT_ID、FIREBASE_SERVICE_ACCOUNT Secret、PORTAL_FIREBASE_PROJECT_ID。/health 的 version 應為 workers-1.1.0。GitHub Pages 由 main 根目錄發布。

## 目前功能
手機借還、部分歸還、時間自動記錄、Excel 匯入匯出、物品大類預先建立及選取、五位數自動編號（00001–99999）、物品刪除、借還紀錄搜尋篩選分頁及篩選匯出、學生借用與歸還 QR 圖片下載。

刪除保留原物品文件與借還紀錄，編號不回收；有未歸還數量時禁止刪除。管理員的測試重設只重設計數器，仍跳過曾使用編號，避免舊紀錄對到不同物品。新增物品支援 requestId 防止網路重送重複新增。編號達 99999 時停止新增。

物品大類共用；老師管理自己的物品，小幫手依入口設定的老師權限管理。學生 QR 連結分別為網站 ?page=borrow 與 ?page=return。QR 使用本地 qrcode.js（Kazuhiko Arase，MIT）產生。

## 匯入
沿用 Ragic 欄位：資產編號、財產編號、物品大類、物品名稱、原始庫存數量、目前借出數量、目前庫存數量、存放位置、備註。保留前導零；數量須為非負整數，原始庫存等於借出加目前庫存。既有編號（含已刪除）禁止覆蓋。每批 100 筆，斷線後請先核對已匯入部分。

舊借出數量沒有借用人明細時，不能自動產生學生可歸還的紀錄。文宣品領用流程仍待確認。

## 驗證
npm test 涵蓋庫存守恆、超借超還、交易衝突重試、權限、編號上限、重送、刪除與重設保留紀錄、匯入計數器及台灣日期篩選。更新部署後請用測試物品驗證實際借還與手機掃描。
