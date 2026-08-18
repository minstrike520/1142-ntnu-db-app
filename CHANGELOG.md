# Changelog

## [2.1.1](https://github.com/nearcsie/near-chat/compare/v2.1.0...v2.1.1) (2026-08-11)


### Bug Fixes

* **backend:** 以可信代理層數解析來源 IP，並收斂正式環境入口 ([#522](https://github.com/nearcsie/near-chat/issues/522)) ([25cacd0](https://github.com/nearcsie/near-chat/commit/25cacd01432d54983596f42a64a898d7333e5045))
* **backend:** 在串流層強制上傳大小上限 ([#521](https://github.com/nearcsie/near-chat/issues/521)) ([fdc9e99](https://github.com/nearcsie/near-chat/commit/fdc9e99a4d62cfd5bab87d9eec2280b23abea797))
* **deps:** 修補 security-scan 回報的 5 項相依套件漏洞 ([#511](https://github.com/nearcsie/near-chat/issues/511)) ([bdc300b](https://github.com/nearcsie/near-chat/commit/bdc300b38b1b3190c009c794f2c63f30e3177288))
* 以注入 AvatarStore 消除 unit tests 跨檔案 mock 污染 ([#467](https://github.com/nearcsie/near-chat/issues/467)) ([#510](https://github.com/nearcsie/near-chat/issues/510)) ([e7abcaf](https://github.com/nearcsie/near-chat/commit/e7abcaf671e514cd0fee37c44f371e435d0903bf))

## [2.1.0](https://github.com/nearcsie/near-chat/compare/v2.0.0...v2.1.0) (2026-07-31)


### Features

* 群組邀請連結與接受邀請頁面 ([#271](https://github.com/nearcsie/near-chat/issues/271)) ([#401](https://github.com/nearcsie/near-chat/issues/401)) ([bbd7cf8](https://github.com/nearcsie/near-chat/commit/bbd7cf86d37131dcb55ac5181c6b4c6ffad9ef39))

## [2.0.0](https://github.com/nearcsie/near-chat/compare/v1.1.0...v2.0.0) (2026-07-29)


* feat(backend)!: 補記 Bun 與 Hono 後端重構 ([#461](https://github.com/nearcsie/near-chat/issues/461)) ([5617728](https://github.com/nearcsie/near-chat/commit/56177285ecc9e265cc06cede5a0497182577a360))


### BREAKING CHANGES

* 後端執行環境與 HTTP framework 已由 Node.js／Express 遷移至 Bun／Hono，啟動指令、middleware、路由與部署整合均須依新架構調整。

## [1.1.0](https://github.com/nearcsie/near-chat/compare/v1.0.1...v1.1.0) (2026-07-29)


### Features

* 上傳頭像與圖片附件自動壓縮為 WebP ([#293](https://github.com/nearcsie/near-chat/issues/293)) ([#399](https://github.com/nearcsie/near-chat/issues/399)) ([0d50603](https://github.com/nearcsie/near-chat/commit/0d5060391ec53184ded6d0a274bf1b5652c58150))

## [1.1.0](https://github.com/nearcsie/near-chat/compare/v1.0.1...v1.1.0) (2026-07-29)


### Features

* 上傳頭像與圖片附件自動壓縮為 WebP ([#293](https://github.com/nearcsie/near-chat/issues/293)) ([#399](https://github.com/nearcsie/near-chat/issues/399)) ([0d50603](https://github.com/nearcsie/near-chat/commit/0d5060391ec53184ded6d0a274bf1b5652c58150))

## [1.1.0](https://github.com/nearcsie/near-chat/compare/v1.0.1...v1.1.0) (2026-07-29)


### Features

* 上傳頭像與圖片附件自動壓縮為 WebP ([#293](https://github.com/nearcsie/near-chat/issues/293)) ([#399](https://github.com/nearcsie/near-chat/issues/399)) ([0d50603](https://github.com/nearcsie/near-chat/commit/0d5060391ec53184ded6d0a274bf1b5652c58150))
