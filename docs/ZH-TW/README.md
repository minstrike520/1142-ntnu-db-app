# 文件

Near Chat 的參考文件 —— 一個以 NTNU 資料庫理論課程專題形式開發的即時群組聊天應用程式。

每份參考文件都同時維護英文與繁體中文版本，兩者保持同步；若內容有出入，以英文版為準。

| 文件 | 繁體中文 | English |
| :--- | :--- | :--- |
| 本機環境架設、port 配置、seeding 與執行測試 | [DEVELOPMENT.md](DEVELOPMENT.md) | [../DEVELOPMENT.md](../DEVELOPMENT.md) |
| REST 端點、payload schema 與 Socket.IO 事件 | [api-documentation.md](api-documentation.md) | [../api-documentation.md](../api-documentation.md) |
| PostgreSQL 18 schema：資料表、約束、索引 | [database-design.md](database-design.md) | [../database-design.md](../database-design.md) |
| 發布與版本流程 | [RELEASE.md](RELEASE.md) | [../RELEASE.md](../RELEASE.md) |

英文索引請見 [../README.md](../README.md)。

## 倉庫中的其他文件

- [../../README.md](../../README.md) — 專案簡介與快速開始
- [../../CONTRIBUTING.zh-TW.md](../../CONTRIBUTING.zh-TW.md) — 分支、commit 慣例、語言規範與送出前檢查清單
- [../CLAUDE.md](../CLAUDE.md) — 給 AI coding agent 的目錄導覽（僅英文版，見下方說明）

## 語言規範的適用範圍

雙語規則適用於上表的參考文件。以下兩類刻意只維護英文版：

- **給 AI agent 的指示檔**（`CLAUDE.md`／`AGENTS.md`）—— 由工具讀取，維護第二份只會讓兩邊悄悄失準。
- **[archive/](../archive/)** —— 已凍結的課程產出，按當初繳交的原貌保存，不得修改。
