# Zotero DeepSeek PDF 翻译

在 Zotero 10 的 PDF 阅读器侧栏阅读整篇简体中文译文。插件将原始 PDF 上传给 DeepSeek，使用返回的文件编号请求整篇翻译。译文使用 Markdown 和 KaTeX 排版。

## 安装和使用

1. 从 GitHub Releases 下载 `deepseek-pdf-reader.xpi`。
2. 在 Zotero 的「工具 → 插件」中选择「从文件安装插件」，打开下载的 XPI。
3. 打开论文 PDF，点击工具栏的「全文翻译」，在侧栏填入 DeepSeek 官方 API Key。
4. 点击「上传并翻译」。重新打开同一份 PDF 时可以读取本地译文缓存。

插件要求保留正文、公式和文内引用，将相关脚注放回对应段落，跳过图表及出版信息。上传原 PDF 和生成译文使用 DeepSeek API，可能产生费用。上传时请求为文件设置一小时有效期。

## 从源码打包

在仓库根目录用 PowerShell 执行以下命令，再安装生成的 XPI。渲染库及其许可文件已随源码提供。

```powershell
Compress-Archive -LiteralPath manifest.json,bootstrap.js,vendor -DestinationPath plugin.zip -Force
Copy-Item -LiteralPath plugin.zip -Destination deepseek-pdf-reader.xpi -Force
```
