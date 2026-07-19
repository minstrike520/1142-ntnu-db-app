# Turbopack 程式碼分割:調查與技術決策 (#380)

本文件記錄 issue #380(#285 前端效能優化的子任務)所要求的調查:Next.js 16 搭配 Turbopack 是否提供受支援、穩定的手動 chunk splitting 設定(等同 Webpack 的 `optimization.splitChunks`),以及此結論對後續效能工作(#381–#383)的意義。

**決策(TL;DR):本專案使用的 Next.js 版本中,Turbopack 沒有任何等同 Webpack `splitChunks` 的公開穩定 API。我們「不會」在 `next.config.ts` 加入任何 chunk splitting 設定。Bundle 體積工作改由受支援的層級進行:App Router 路由分割(自動)、`next/dynamic`(#381)、逐圖示/套件按需匯入(#382)。**

> **2026-07-19 更新:** 重新評估觸發條件 3(dev/build bundler 統一)已由 #387 達成(PR #388,commit `7322545`)。已依約重新檢視本決策——**決策維持不變**,因為主要依據(觸發條件 1:沒有公開穩定的 chunking API)仍然成立。詳見文末〈重新評估紀錄〉。

## 本次調查使用的工具鏈版本

| 工具 | 版本 |
| :--- | :--- |
| Next.js | 16.2.10(實際安裝版;`package.json` 宣告 `16.2.10`) |
| Node.js | v22 sandbox(專案 `package.json` engines 要求 Node >=24) |
| pnpm | 11.13.1 |
| 分支/日期 | `claude/issue-285-fix-yhe83u`,基於 `dev` `8cffa93`,2026-07-19 |

Issue #380 撰寫時參照「16.2.6」;專案現已升至 16.2.10。以下所有結論皆以實際安裝的 16.2.10 驗證。

## 問題 1:Turbopack 是否提供等同 `splitChunks` 的設定?

**沒有。** 三條獨立證據:

### 1a. 官方文件記載的 `turbopack` 設定面

Next.js 官方對 `next.config.ts` 中 `turbopack` 鍵的參考文件([nextjs.org/docs/app/api-reference/config/next-config-js/turbopack](https://nextjs.org/docs/app/api-reference/config/next-config-js/turbopack))記載的選項僅有:

- `root` — 應用程式根目錄
- `rules` — 套用 webpack **loaders**(僅檔案轉換,與打包策略無關)
- `resolveAlias` — 匯入別名
- `resolveExtensions` — 模組解析副檔名
- `debugIds` — 在 bundle/source map 產生 debug ID
- `ignoreIssue` — 抑制特定 Turbopack 診斷訊息

沒有任何一項控制 chunking。Turbopack 指南([nextjs.org/docs/app/api-reference/turbopack](https://nextjs.org/docs/app/api-reference/turbopack)的「Unsupported and unplanned features」)另明確指出:以 Turbopack 建置時,`next.config.js` 中的任何 `webpack()` 設定**不會被識別**——因此把 `splitChunks` 塞進 `webpack()` callback 對 `next build` 完全無效。

### 1b. 實際安裝套件的型別定義

`frontend/node_modules/next/dist/server/config-shared.d.ts`(next@16.2.10)定義的 `TurbopackOptions` 恰好只有上述六個欄位(`resolveAlias`、`resolveExtensions`、`rules`、`root`、`debugIds`、`ignoreIssue`),沒有任何 chunking 相關欄位。

與 chunking 沾邊的開關確實存在,但全部位於同檔案的 `experimental.*` 旗標(例如 `turbopackClientSideNestedAsyncChunking`、`turbopackServerSideNestedAsyncChunking`、`turbopackScopeHoisting`、`turbopackTreeShaking`、`turbopackMinify`、`turbopackModuleIds`)。這些只是 Turbopack 內建行為的布林/列舉開關——不是 `splitChunks` 式的策略語言(沒有 cache groups、沒有大小門檻、沒有手動 vendor 分組)——而且皆為 experimental,不符合 #380「公開且穩定」的門檻。詳見下方「不採用的選項」。

### 1c. 最小可重現測試

在 `frontend/src/__turbopack-splitchunks-spike__.ts` 放入:

```ts
import type { NextConfig } from "next";

const spikeConfig: NextConfig = {
  turbopack: {
    splitChunks: {
      chunks: "all",
      cacheGroups: {
        vendor: { test: /node_modules/, name: "vendors" },
      },
    },
  },
};

export default spikeConfig;
```

於 `frontend/` 執行 `pnpm exec tsc --noEmit`,失敗訊息為:

```
src/__turbopack-splitchunks-spike__.ts(5,5): error TS2353: Object literal may only
specify known properties, and 'splitChunks' does not exist in type 'TurbopackOptions'.
```

該測試檔在擷取輸出後即刪除,刻意不納入 commit。

## 問題 2:那麼程式碼分割由誰負責?

在沒有手動 chunking API 的前提下,本專案的分割責任依層級劃分如下,後續 issue 應在此邊界內工作:

| 層級 | 機制 | 本專案現況 |
| :--- | :--- | :--- |
| 路由 | App Router 自動逐路由分割:每個路由區段有自己的 chunk,共用模組由 Turbopack 自動去重。 | 已生效;`docs/frontend-bundle-analysis.md` 的逐路由表格即為證據(`/`、`/chat/[chatId]`、`/settings` 各有不同的路由專屬模組)。 |
| 元件 | `next/dynamic` / `React.lazy` 建立非同步邊界,Turbopack 會輸出獨立 chunk 並於首次渲染時載入。這是**唯一受支援的「手動把程式碼移出路由初始 chunk」方式**。 | #381 的範疇(例如目前同步匯入、但預設隱藏的 `GroupSettings`)。 |
| 套件 | 匯入衛生:逐圖示 subpath 匯入取代執行期字串查找;Turbopack 原生最佳化 barrel file(官方文件註明 `experimental.optimizePackageImports` 是 Webpack 時代的輔助,「使用 Turbopack 時不需要」)。 | #382 的範疇(`@iconify/react` → `@iconify-react/boxicons/<icon>` subpath 匯入)。 |

換句話說:#381–#383 需要的一切都不會被「缺少 `splitChunks`」擋住。手動 vendor 分組是 Webpack 時代的手段;在 Turbopack 之下,等價效果來自非同步邊界與匯入衛生。

## 問題 3:dev/build bundler 不一致(已於 2026-07-19 解決)

本調查當時,`frontend/package.json` 為:

- `dev`:`next dev --webpack` → 開發使用 **Webpack**
- `build`:`next build` → production 使用 **Turbopack**(Next 16 預設)

影響:

- 未來若加入任何 `turbopack.*` 設定,只會影響 `next build`(及 `pnpm run analyze`),**不影響** dev server;反之 `webpack()` callback 只影響 dev、被 production build 忽略。對任何未來的 bundler 層設定而言,這種分裂是明顯的陷阱——這也是讓 `next.config.ts` 維持 bundler 中立的又一理由(目前它既無 `webpack` 也無 `turbopack` 鍵)。
- dev/prod 行為漂移(模組解析、HMR 語意、CSS 處理)理論上可能,但目前尚未觀察到實際問題。

**建議:** 統一 dev 也使用 Turbopack(`next dev` 去掉 `--webpack`)——已由 #387 獨立追蹤,並附獨立驗證(dev server 的 HMR、CSS、Socket.IO client 行為煙霧測試),不搭在本文件 PR 上。在那之前,「只有單一 bundler 會讀取的設定」應視為 code review 的警訊。

**後續(2026-07-19):** #387 已完成——commit `7322545`(PR #388)自 `dev` script 移除 `--webpack`,dev 與 build 現在皆使用 Turbopack。本節描述的設定分裂陷阱不復存在:未來任何 `turbopack.*` 設定會同時作用於兩個環境;反之,`webpack()` callback 如今 dev 與 build 都不會讀取,屬純粹的死設定。此事件即〈重新評估觸發條件〉第 3 項,重新評估結果見下方〈重新評估紀錄〉。

## 問題 4:約 112 KB 的 `polyfill-nomodule.js`(基準文件候選 3)

`docs/frontend-bundle-analysis.md` 指出分析器在每個路由都列出 `polyfill-nomodule.js`(~112 KB),並把結論交由本調查。

**結論:對現代瀏覽器不構成實際成本,也無法設定移除——不處理。** Next.js 以 `<script noModule>` 標籤注入此檔(已於安裝套件中驗證:`next/dist/server/app-render/app-render.js` 由 `buildManifest.polyfillFiles` 建立 polyfill script 項目並帶 `noModule: true`)。凡支援 `<script type="module">` 的瀏覽器——也就是所有能執行本應用 ES module bundle 的瀏覽器——依規範會跳過 `nomodule` script,因此該檔只會被本來就無法運作的舊瀏覽器下載執行。Next.js 沒有公開設定可移除它;移除只會破壞舊瀏覽器的 fallback,不會改變現代瀏覽器下載或執行的內容。`docs/frontend-bundle-analysis.md` 的量測方法已將其排除於 client-JS 統計之外;維持現狀即可。

## 決策紀錄

### 採用

1. **不在 `next.config.ts` 加入任何 chunk splitting 設定。** 沒有受支援的 API 可加;且在 dev/build 使用不同 bundler 期間,設定檔維持 bundler 中立。(2026-07-19 更新:bundler 已統一,後半「bundler 中立」理由退役;前半「沒有受支援的 API」仍成立,決策不變——見〈重新評估紀錄〉。)
2. **Bundle 體積工作僅經由受支援層級進行:** `next/dynamic` 邊界(#381)、逐圖示 subpath 匯入(#382)、有量測依據的重新渲染修正(#383),全部以 `docs/frontend-bundle-analysis.md` 的可重現 `pnpm run analyze` 流程驗證。
3. **`polyfill-nomodule.js` 以「不採取行動」結案:** 排除於 client-JS 統計,非可移除項目,亦非現代瀏覽器的實際成本。

### 不採用的選項(與原因)

- **`experimental.turbopack*` 旗標**(`turbopackClientSideNestedAsyncChunking`、`turbopackScopeHoisting`、`turbopackTreeShaking`、`turbopackMinify`、`turbopackModuleIds` 等):屬 experimental、語意隨版本變動,且目前沒有任何 bundle 證據顯示存在它們能解決的 chunk 問題。現在採用等於無依據的投機調校,還附帶升級風險。
- **透過 `webpack()` callback 移植 Webpack `optimization.splitChunks`**:官方明示 Turbopack 建置不識別;只會(錯誤地)設定到 dev server。
- **私有/未文件化 API**:#380 自身的限制條件即禁止。

### 重新評估觸發條件

發生下列任一情況時重新檢視本決策:

1. Next.js 將 Turbopack 的 chunking 控制 API 升為**穩定**(升級時追蹤 `turbopack` 設定參考頁)。
2. `pnpm run analyze` 顯示存在單一過大的 client chunk,且可證明 `next/dynamic` 邊界無法拆解(例如某共用 vendor 模組始終被拉進初始 chunk)。
3. ~~dev/build bundler 統一完成,使 bundler 專屬設定對兩個環境同時生效。~~ → **已於 2026-07-19 觸發並完成重新評估**(見下方〈重新評估紀錄〉);後續重新評估以條件 1、2 為準。

### 重新評估紀錄

#### 2026-07-19:觸發條件 3(dev/build bundler 統一)

**觸發事實:** issue #387 由 PR #388 合併完成(commit `7322545`),自 `frontend/package.json` 的 `dev` script 移除 `--webpack`。dev 與 build 現在皆由 Turbopack 驅動,bundler 專屬設定自此對兩個環境同時生效。

**重新驗證(於 next@16.2.10,lockfile 實際安裝版):**

- `frontend/node_modules/next/dist/server/config-shared.d.ts` 的 `TurbopackOptions` 仍恰好只有原六個欄位(`resolveAlias`、`resolveExtensions`、`rules`、`root`、`debugIds`、`ignoreIssue`),沒有任何 chunking 相關欄位——觸發條件 1 仍未發生。
- `next.config.ts` 維持既無 `webpack` 也無 `turbopack` 鍵,與原決策一致。

**結論:決策維持不變。** bundler 統一移除的是「設定分裂陷阱」這個**次要**理由,不是主要理由——主要理由(Turbopack 沒有公開穩定的 chunking API)在 next@16.2.10 仍然成立,因此仍然沒有任何受支援的 chunk splitting 設定可加。本次觸發帶來的實際變化:

1. 「維持 `next.config.ts` bundler 中立」不再是防禦性要求。日後若 Next.js 將 chunking 控制升為穩定(觸發條件 1),`turbopack.*` 設定可直接採用,並同時作用於 dev 與 build,不再有「只影響單邊」的陷阱。
2. Code review 警訊從「只有單一 bundler 會讀取的設定」更新為:`webpack()` callback 如今不被任何環境讀取,任何新增皆為死設定,應直接拒絕。
3. 觸發條件 3 已消耗;本決策的後續重新評估以觸發條件 1、2 為準。

### 回退方案

本變更僅新增文件。回退 = 刪除本檔(及英文版 `docs/frontend-turbopack-code-splitting.md`)。未修改任何 production 程式碼或設定。
