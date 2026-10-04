# 上传资源预算（批准风险 8、10）

预检：lizhonghao31-crypto/dx-rework，main 9fcc05c49dd7f236e2aad183b7e638780e9d63fc，security/upload-budgets，FULL。允许公共文件验证、supplier上传读入前置预算和必要测试；禁止删除历史附件、管理员附件元数据（11）、识别费用（9）、迁移/数据库参数、A4 UI。

8：JPEG SOF及WebP VP8/VP8L/VP8X原仅验证非零/结构，允许小文件声明巨大解码面。现统一最大边16384、6400万像素；PNG也检查统一预算且保留原128MiB实际inflate预算。冻结main高像素JPEG/WebP oracle两项失败；候选通过，包括48MP手机JPEG正常路径。校验在pending→ready上传验证，现有ready附件不重新扫描/删除/改记录。大于64MP新照片需要缩放；未声称全量历史图片或所有手机型号都已抽样。metadata/sha/结构校验不变。

10：原2MiB仅限制压缩上传，read-excel-file在row/column schema之前全量解压。现在在导入library前检查ZIP目录、条目≤128、单项≤8MiB、总解压≤16MiB、比例≤200以及原压缩≤2MiB。拒绝加密/不支持方法、多磁盘/ZIP64超限、重复条目、重叠局部数据、local/central差异；实际native DecompressionStream逐块统计长度/总预算/CRC，不信任伪造小size，异常取消reader。验证后才让原library解析同一份字节，不引入依赖升级或新的全量解压路径。正常ZIP data-descriptor标志仍可使用。

定向25通过；完整1851通过/318跳过，lint/build通过；首轮CI发现DecompressionStream与ArrayBufferLike泛型不一致，改为Blob实际输出的ArrayBuffer泛型后重新typecheck和构建。真实Chromium153本地浏览器调用相同前置validator及readSheet：官方模板15列表头成功、中文供应商和001234567890文本账号不变；压缩bomb在进入readSheet前拒绝。当前测试不代表旧版浏览器均支持native deflate-raw；不支持的浏览器会以清晰错误fail-closed。

无migration/manifest/lockfile/部署参数变化。main221、release237原身份checksum保留；release仅cherry-pick上传通用能力及同一supplier读入前置，历史/A4组件不覆盖。固定183309工具无需升级，但组合候选要通过旧工具preflight及打包runtime导入验证。不自动合并/部署、未关闭scan findings，无真实钉钉/收费API/线上压测。
