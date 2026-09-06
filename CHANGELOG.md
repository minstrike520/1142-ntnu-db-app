# Changelog

## [2.2.0](https://github.com/nearcsie/near-chat/compare/v2.1.1...v2.2.0) (2026-09-06)


### Features

* Add users.is_admin field and administrator authorization middleware ([#565](https://github.com/nearcsie/near-chat/issues/565)) ([#577](https://github.com/nearcsie/near-chat/issues/577)) ([f89ff1c](https://github.com/nearcsie/near-chat/commit/f89ff1cb314750653ae526f48603f390c1e3661e))
* **backend:** add the admin monitoring API ([#569](https://github.com/nearcsie/near-chat/issues/569)) ([#608](https://github.com/nearcsie/near-chat/issues/608)) ([c94a7d5](https://github.com/nearcsie/near-chat/commit/c94a7d5043d99492e1d392853c025ad510c8f96d))
* **backend:** Added request timing middleware and performance metrics consolidation ([#567](https://github.com/nearcsie/near-chat/issues/567)) ([#585](https://github.com/nearcsie/near-chat/issues/585)) ([9468e15](https://github.com/nearcsie/near-chat/commit/9468e154550251cc53028e85e85113dc5fd1dade))
* **backend:** Establish Bun.SQL Slow Query Monitoring and Slow Query Buffer ([#568](https://github.com/nearcsie/near-chat/issues/568)) ([#590](https://github.com/nearcsie/near-chat/issues/590)) ([340a2b2](https://github.com/nearcsie/near-chat/commit/340a2b2f0407a599c6fc1267646b4338da060881))
* **backend:** manage Redis connections on Bun's native client ([#472](https://github.com/nearcsie/near-chat/issues/472)) ([#607](https://github.com/nearcsie/near-chat/issues/607)) ([e7d2fc9](https://github.com/nearcsie/near-chat/commit/e7d2fc9887571105dba8cf3f3fa880128735f7c5))
* **backend:** share user presence across instances through Redis ([#473](https://github.com/nearcsie/near-chat/issues/473)) ([#611](https://github.com/nearcsie/near-chat/issues/611)) ([72624c6](https://github.com/nearcsie/near-chat/commit/72624c6e0c1050b9336f0724c45f6bdf3595d166))
* create Redis Compose service and env setup ([#471](https://github.com/nearcsie/near-chat/issues/471)) ([#526](https://github.com/nearcsie/near-chat/issues/526)) ([f814b38](https://github.com/nearcsie/near-chat/commit/f814b38adf0b53941a9bd57262acfe6fa1e910b3))
* **frontend:** add admin monitoring page ([#635](https://github.com/nearcsie/near-chat/issues/635)) ([84e8749](https://github.com/nearcsie/near-chat/commit/84e87490f7ea29a622a8587801ea6880a3d07bd6))
* harden recoverable realtime chat consistency and deployment safety ([#542](https://github.com/nearcsie/near-chat/issues/542)) ([a56cabe](https://github.com/nearcsie/near-chat/commit/a56cabe268eaf1cbc45d2df27694bafe63f52bd1))
* Introducing Pino structured logging and recent log buffering ([#566](https://github.com/nearcsie/near-chat/issues/566)) ([#578](https://github.com/nearcsie/near-chat/issues/578)) ([8607914](https://github.com/nearcsie/near-chat/commit/860791459dda00bbca35c0bbc13a03e4df73eba0))
* **migrate:** take the migration target as an explicit --database-url ([#600](https://github.com/nearcsie/near-chat/issues/600)) ([aa3298b](https://github.com/nearcsie/near-chat/commit/aa3298bc18f0ab510ea2f1a24cfa58d234a2c183))
* **realtime:** carry realtime events across instances over Redis ([#475](https://github.com/nearcsie/near-chat/issues/475)) ([#646](https://github.com/nearcsie/near-chat/issues/646)) ([105b6d7](https://github.com/nearcsie/near-chat/commit/105b6d7630e9bf63737855a8f4b942226fae458d))


### Bug Fixes

* **backend:** deliver SIGTERM to the production backend process ([#586](https://github.com/nearcsie/near-chat/issues/586)) ([#613](https://github.com/nearcsie/near-chat/issues/613)) ([5578cce](https://github.com/nearcsie/near-chat/commit/5578cce64a47832e98cf09f9f7185887e04a1ef1))
* **realtime:** aggregate typing state per room member ([#474](https://github.com/nearcsie/near-chat/issues/474)) ([#640](https://github.com/nearcsie/near-chat/issues/640)) ([65a8ddd](https://github.com/nearcsie/near-chat/commit/65a8dddd0573d1d689137a7094df1899ca0844ff))
* **realtime:** deliver user_status to friends on every instance ([#476](https://github.com/nearcsie/near-chat/issues/476)) ([#647](https://github.com/nearcsie/near-chat/issues/647)) ([e1583a6](https://github.com/nearcsie/near-chat/commit/e1583a638479b3e6f6122faa2cf329f62fe31aad))

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
