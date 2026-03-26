<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/77117a2b-1692-4d49-8ef9-05d051b9d8c7

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## GitHub Actions 自動部署
本專案已設定 GitHub Actions。當程式碼推送到 `main` 或 `master` 分支時，會自動觸發編譯並部署到 **GitHub Pages**。

- 流程檔位置：`.github/workflows/deploy.yml`
- **請確保**: 
  - 在 GitHub Repository 中前往 **Settings > Pages**。
  - 將 **Source** 改為 **GitHub Actions**。

## `.gitignore` 設定
為了保持專案乾淨與安全，已設定過濾以下檔案/資料夾：
- `node_modules/` (套件庫)
- `dist/` 或 `build/` (編譯輸出檔)
- `.env*` (避免上傳任何含有私鑰的環境變數檔)
- 編輯器暫存檔 (如 `.vscode/`, `.idea/`, `.DS_Store`)
