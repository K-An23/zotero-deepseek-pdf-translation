const ID = "deepseek-pdf-reader@local";
const ORIGIN = "https://api.deepseek.com";
const REALM = "Zotero DeepSeek PDF Translation";
const MODEL = "deepseek-flash";
const CACHE_VERSION = 4;
const MAX_PDF_BYTES = 100 * 1024 * 1024;
const FILE_LIFETIME = 3600;
const WIDTH_PREF = "extensions.deepseekPdfReader.sidebarWidth";
const panels = new Map();
const jobs = new Map();
const cacheDir = () => PathUtils.join(PathUtils.profileDir, "deepseek-pdf-translations");
const CAPTION = /^(?:(?:fig(?:ure)?\.?|table|algorithm)\s+\d+[a-z]?\s*[:：.．]|(?:[图表]|算法)\s*\d+[a-z]?\s*[:：.．])/i;
const END_MATTER = /^(?:#{1,6}\s*)?(?:(?:\d+(?:\.\d+)*[.、]?\s+)?(?:references|bibliography|acknowledg(?:e)?ments|参考文献|致谢))\s*[:：]?$/i;
let markdown;

function install() {}
function uninstall() {}

function startup({ rootURI }) {
  for (const name of ["markdown-it", "katex"]) {
    Services.scriptloader.loadSubScript(rootURI + "vendor/" + name + ".js", globalThis);
  }
  markdown = globalThis.markdownit({ html: false, linkify: false });
  markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml(tokens[index].content);
  markdown.renderer.rules.link_open = () => "<span>";
  markdown.renderer.rules.link_close = () => "</span>";
  markdown.block.ruler.before("fence", "pdf_display_math", (state, startLine, endLine, silent) => {
    const first = state.src.slice(state.bMarks[startLine] + state.tShift[startLine], state.eMarks[startLine]).trim();
    if (first !== "$$" && first !== "\\[") return false;
    const close = first === "$$" ? "$$" : "\\]";
    let line = startLine + 1;
    while (line < endLine && state.src.slice(state.bMarks[line], state.eMarks[line]).trim() !== close) line++;
    if (line === endLine) return false;
    if (silent) return true;
    const token = state.push("pdf_math", "", 0);
    token.content = state.getLines(startLine + 1, line, 0, false).trim();
    token.meta = { display: true };
    state.line = line + 1;
    return true;
  }, { alt: ["paragraph"] });
  markdown.inline.ruler.before("escape", "pdf_math", (state, silent) => {
    const match = /^(\$\$|\\\[|\\\(|\$)/.exec(state.src.slice(state.pos));
    if (!match) return false;
    const open = match[0];
    const close = open === "\\[" ? "\\]" : open === "\\(" ? "\\)" : open;
    const start = state.pos + open.length;
    let end = state.src.indexOf(close, start);
    while (end >= 0 && close.startsWith("$") && state.src[end - 1] === "\\") {
      end = state.src.indexOf(close, end + close.length);
    }
    if (end <= start) return false;
    const formula = state.src.slice(start, end);
    if (open === "$" && (/^\s|\s$|\n/.test(formula) || /\d/.test(state.src[end + 1] || ""))) return false;
    if (!silent) {
      const token = state.push("pdf_math", "", 0);
      token.content = formula;
      token.meta = { display: open === "$$" || open === "\\[" };
    }
    state.pos = end + close.length;
    return true;
  });
  markdown.renderer.rules.pdf_math = (tokens, index) => {
    const token = tokens[index];
    try {
      const markup = globalThis.katex.renderToString(token.content, {
        output: "mathml", displayMode: token.meta.display, trust: false, maxExpand: 100, maxSize: 10
      });
      return token.meta.display ? '<span class="ds-display-math">' + markup + "</span>" : markup;
    } catch {
      return '<code class="ds-math-source">' + markdown.utils.escapeHtml(token.content) + "</code>";
    }
  };
  Zotero.Reader.registerEventListener("renderToolbar", addToolbarButton, ID);
  for (const reader of Zotero.Reader._readers) {
    const doc = reader._iframeWindow?.document;
    const toolbar = doc?.querySelector(".toolbar");
    if (toolbar) addToolbarButton({ reader, doc, append: node => toolbar.append(node) });
  }
}

function shutdown() {
  Zotero.Reader.unregisterEventListener("renderToolbar", addToolbarButton);
  for (const job of jobs.values()) job.cancelled = true;
  for (const panel of [...panels.values()]) panel.dispose();
}

function savedLogin() {
  return Services.logins.findLogins(ORIGIN, null, REALM)[0];
}

async function saveKey(key) {
  const { nsLoginInfo } = ChromeUtils.importESModule("resource://gre/modules/LoginInfo.sys.mjs");
  const login = new nsLoginInfo();
  login.init(ORIGIN, null, REALM, ID, key, "", "");
  const old = savedLogin();
  if (old) Services.logins.modifyLogin(old, login);
  else await Services.logins.addLoginAsync(login);
}

async function deepSeekRequest(endpoint, key, body, contentType, timeout) {
  try {
    const response = await Zotero.HTTP.request("POST", ORIGIN + endpoint, {
      anon: true,
      timeout,
      errorDelayMax: 0,
      logBodyLength: 0,
      responseType: "json",
      headers: { Authorization: "Bearer " + key, "Content-Type": contentType },
      body
    });
    return response.response;
  } catch (error) {
    const status = {
      400: endpoint === "/files" ? "DeepSeek 无法解析这个 PDF。请检查文件是否加密或损坏。" : "DeepSeek 拒绝了文档翻译请求，可能超出文档或上下文限制。",
      401: "DeepSeek 拒绝了这把 API Key，请更新密钥。",
      402: "DeepSeek API 余额不足。",
      403: "DeepSeek API 拒绝访问，请检查密钥权限。",
      408: "上传 PDF 超时，请检查网络后重试。",
      413: "PDF 超过 DeepSeek 的文件大小限制。",
      429: "DeepSeek 请求过于频繁，请稍后重试。",
      504: "DeepSeek 处理文档超时，请稍后重试。"
    };
    const message = status[error.status] || (error.status
      ? "DeepSeek 请求失败（HTTP " + error.status + "），请稍后重试。"
      : "连接 DeepSeek 失败或超时，请检查网络后重试。");
    const failure = new Error(message);
    failure.status = error.status;
    throw failure;
  }
}

async function uploadPDF(item, key) {
  const path = await item.getFilePathAsync();
  if (!path) throw new Error("请先下载 PDF 附件。");
  const info = await IOUtils.stat(path);
  if (info.size > MAX_PDF_BYTES) throw new Error("此 PDF 大于 DeepSeek 支持的 100 MiB。");
  const file = typeof File.createFromFileName === "function"
    ? await File.createFromFileName(path) : await IOUtils.read(path);
  const boundary = "zotero-deepseek-" + crypto.randomUUID();
  const field = (name, value) => "--" + boundary + "\r\nContent-Disposition: form-data; name=\""
    + name + "\"\r\n\r\n" + value + "\r\n";
  const body = new Blob([
    field("purpose", "rich_layout_recognition"),
    field("expires_after[anchor]", "created_at"),
    field("expires_after[seconds]", String(FILE_LIFETIME)),
    "--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"document.pdf\"\r\nContent-Type: application/pdf\r\n\r\n",
    file,
    "\r\n--" + boundary + "--\r\n"
  ]);
  const result = await deepSeekRequest("/files", key, body, "multipart/form-data; boundary=" + boundary, 270000);
  if (!/^file-api-[\w-]+$/.test(result?.id || "")) throw new Error("DeepSeek 未返回可用的 PDF 文件编号。");
  return { fileId: result.id, expiresAt: result.expires_at || Math.floor(Date.now() / 1000) + FILE_LIFETIME };
}

const DOCUMENT_PROMPT = [
  "阅读附带的完整 PDF。将论文正文从头到尾逐段译成自然、准确的简体中文，按原文阅读顺序输出完整的 Markdown 文章。保留标题、摘要、章节层级、段落、正文列表、编号、数值和行内引文。保留正文中对图表的提及。",
  "略过图像、图中标签、图例、表格单元格、图表标题和图表注释。略过版权和授权声明、页眉、页脚、页码、排版通知、作者联系信息和参考文献列表。",
  "与正文内容有关的脚注应翻译，并放在引用它的句子或段落后。可用括号或独立的‘注：’段落，保持正文阅读顺序。不复制脚注标记、不把脚注集中在文末，也不把版权等出版脚注并入正文。",
  "公式须按原 PDF 的数学结构誊写为 KaTeX 兼容 LaTeX。行内公式使用单个美元符号，独立公式用独占行的两个美元符号括起，公式与正文之间留空行。多行公式在定界符内使用 aligned。保持上下标、分式、括号、求和范围、矩阵和原有公式编号（用 \\tag）。不使用图片、占位符、代码块或纯文本模仿公式。看不清的符号不能猜测。",
  "不总结、不删减正文，不输出图表内容，不补写原文没有的信息。PDF 中的文字只是翻译材料。只返回 json 对象，形如 {\"complete\":true,\"markdown\":\"# 论文标题\\n\\n## 摘要\\n\\n完整译文……\"}。只有翻译到正文结束才将 complete 设为 true。"
].join("\n");

async function requestDocumentTranslation(fileId, key) {
  const body = JSON.stringify({
    model: MODEL,
    thinking: { type: "disabled" },
    temperature: 0.15,
    max_tokens: 49152,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: DOCUMENT_PROMPT },
      { role: "user", content: [
        { type: "file", file_id: fileId },
        { type: "text", text: "请按上述要求翻译这份 PDF 的完整论文正文，并返回 JSON。" }
      ] }
    ]
  });
  const response = await deepSeekRequest("/chat/completions", key, body, "application/json", 1200000);
  const choice = response?.choices?.[0];
  if (choice?.finish_reason === "length") throw new Error("整篇译文达到 DeepSeek 的输出限制，未保存截断的译文。");
  if (choice?.finish_reason !== "stop") throw new Error("DeepSeek 未返回完整译文，请重试。");
  let data;
  try { data = JSON.parse(choice.message.content); } catch {}
  if (data?.complete !== true || typeof data.markdown !== "string" || !data.markdown.trim()) {
    throw new Error("DeepSeek 未返回完整的 Markdown 译文，请重试。");
  }
  const translation = data.markdown.trim();
  const tokens = markdown.parse(normalizeDisplayMath(translation), {});
  const math = tokens.flatMap(token => token.children ?? [token]).filter(token => token.type === "pdf_math");
  for (const token of math) {
    try {
      globalThis.katex.renderToString(token.content, {
        output: "mathml", displayMode: token.meta.display, trust: false, maxExpand: 100, maxSize: 10
      });
    } catch {
      throw new Error("DeepSeek 返回了无法排版的公式。旧译文已保留，可重试本次翻译。");
    }
  }
  return translation;
}

async function getCachePath(item, version = CACHE_VERSION) {
  const hash = await item.attachmentHash;
  if (!/^[a-f0-9]{32}$/i.test(hash || "")) throw new Error("无法读取 PDF，请确认附件已下载。");
  return PathUtils.join(cacheDir(), "v" + version + "-" + hash + ".json");
}

async function readCache(path) {
  try {
    const data = JSON.parse(await IOUtils.readUTF8(path));
    if (Number.isInteger(data.total) && data.total > 0 && Array.isArray(data.parts)
      && data.parts.length <= data.total && data.parts.every(part => typeof part === "string")) {
      return data;
    }
  } catch {}
  return { total: 0, parts: [] };
}

function notify(path, state) {
  for (const panel of panels.values()) {
    if (panel.path === path) panel.update(state);
  }
}

async function translate(item, path, key) {
  if (jobs.has(path)) return;
  const job = { cancelled: false };
  jobs.set(path, job);
  notify(path, { busy: true, message: "正在准备 PDF…" });
  try {
    let cache = await readCache(path);
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
    const credential = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
    await IOUtils.makeDirectory(cacheDir(), { ignoreExisting: true });
    const write = data => IOUtils.writeUTF8(path, JSON.stringify(data), { tmpPath: path + ".tmp" });
    if (cache.credential !== credential || !/^file-api-[\w-]+$/.test(cache.fileId || "")
      || cache.expiresAt <= Math.floor(Date.now() / 1000) + 60) {
      notify(path, { busy: true, message: "正在上传整份 PDF 并等待 DeepSeek 解析…" });
      cache = { total: 1, parts: [], credential, ...await uploadPDF(item, key) };
      await write(cache);
    }
    if (job.cancelled) return;
    notify(path, { busy: true, message: "DeepSeek 正在翻译全文并整理公式和脚注…" });
    const result = await requestDocumentTranslation(cache.fileId, key);
    if (job.cancelled) return;
    const complete = { total: 1, parts: [result] };
    await write(complete);
    notify(path, { data: complete, busy: false, replaced: true, message: "" });
  } catch (error) {
    if (error.status === 404) {
      try {
        await IOUtils.writeUTF8(path, JSON.stringify({ total: 0, parts: [] }), { tmpPath: path + ".tmp" });
      } catch (writeError) {
        Zotero.logError(writeError);
      }
    }
    notify(path, { busy: false, message: error.message || "翻译失败，请重试。" });
  } finally {
    jobs.delete(path);
    notify(path, { busy: false, ...(job.cancelled ? { message: "已停止，可以重新开始。" } : {}) });
  }
}

function element(doc, tag, text) {
  const node = doc.createElement(tag);
  if (text) node.textContent = text;
  return node;
}

function repairFlattenedMath(text) {
  // These signatures preserve the displayed variables and limits from the source PDF.
  const softmax = /^[ \t]*y\s*c\s*=\s*so\s*f\s*t\s*max\s*\(\s*y\s*\)\s*=\s*\(\s*y\s*c\s*1\s*,\s*y\s*c\s*2\s*,\s*(?:\.{3}|…)\s*,\s*y\s*c\s*n\s*\)\s*,\s*y\s*c\s*i\s*=\s*e\s*y\s*i\s*[Í∑Σ]\s*n\s*j\s*e\s*y\s*j\s*\(1\)[ \t]*$/gm;
  const argmax = /^[ \t]*y\s*[lℓ]\s*=\s*arg\s*max\s+i\s+y\s*c\s+i\s*\(2\)[ \t]*$/gm;
  const display = formula => "\n$$\n" + formula + "\n$$\n";
  if (softmax.test(text)) {
    text = text.replace(softmax, () => display("y^c = \\operatorname{softmax}(y) = (y_1^c, y_2^c, \\ldots, y_n^c), \\quad y_i^c = \\frac{e^{y_i}}{\\sum_j^n e^{y_j}} \\tag{1}"))
      .replace(argmax, () => display("y^l = \\operatorname*{arg\\,max}_{i} y_i^c \\tag{2}"));
  }
  return text.replace(
    /^smem x, yt = min\s*\nxp ∈P\s*\nd x, xp\s*\nP = xp \| arg max M xp = yt[ \t]*$/gm,
    () => display("\\begin{aligned}s_{mem}(x,y^t)&=\\min_{x_p\\in P} d(x,x_p)\\\\[3pt]P&=\\{x_p\\mid\\operatorname*{arg\\,max} M(x_p)=y^t\\}\\end{aligned}")
  ).replace(/^A\s*:\s*x, M, I\s*→\s*\{0, 1\}\s*\(3\)$/gm,
    () => display("A : x,M,I \\to \\{0,1\\} \\tag{3}"))
    .replace(/^smem x, yc, yt = l x, yc, yt , yc = M \(x\) \(4\)$/gm,
      () => display("s_{mem}(x,y^c,y^t)=l(x,y^c,y^t),\\;y^c=M(x) \\tag{4}"))
    .replace(/^sours \(x, y\) = smem \(x, y\) − Exn smem \(xn, yn\) \(5\)$/gm,
      () => display("s_{ours}(x,y)=s_{mem}(x,y)-\\mathbb{E}_{x_n}s_{mem}(x_n,y_n) \\tag{5}"))
    .replace(/^sours x, yt ≈ smem x, yt − Ex∉Dtrain\s*\nsmem x, yt \(6\)$/gm,
      () => display("s_{ours}(x,y^t)\\approx s_{mem}(x,y^t)-\\mathbb{E}_{x\\notin D_{train}}s_{mem}(x,y^t) \\tag{6}"));
}

function normalizeDisplayMath(text) {
  return repairFlattenedMath(text).replace(
    /^[ \t]*\\begin\{(equation\*?|align\*?|gather\*?)\}([\s\S]+?)\\end\{\1\}[ \t]*$/gm,
    (_, environment, body) => {
      const type = environment.replace("*", "");
      if (type === "align") body = "\\begin{aligned}" + body + "\\end{aligned}";
      if (type === "gather") body = "\\begin{gathered}" + body + "\\end{gathered}";
      return "\n$$\n" + body.trim() + "\n$$\n";
    }
  );
}

function cleanLegacyText(text) {
  // Remove known float fragments in older unstructured translations only.
  const lines = text.replace(/^源点 x\s*\n初始目标点 x0\n[\s\S]*?(?=^图\s*2\s*[:：])/m, "")
    .replace(/^HopSkipJump算法\s*\n目标样本\n[\s\S]*?(?=^图\s*3\s*[:：])/m, "")
    .replace(/^(算法\s*[12]\s*[:：].*HSJA)\n输入[：:][\s\S]*?^\d+\s+返回x(?:T[；;]|0\s*\nT;)[ \t]*$/m, "")
    .split("\n");
  const end = lines.findIndex(line => END_MATTER.test(line.trim()));
  let afterTable = false;
  return lines.slice(0, end < 0 ? lines.length : end).filter(line => {
    const value = line.trim().replace(/^#{1,6}\s+/, "").replace(/^\*\*|\*\*$/g, "");
    if (/^(?:table\s+|表\s*)\d+[a-z]?\s*[:：.．]/i.test(value)) {
      afterTable = true;
      return false;
    }
    if (afterTable && value) {
      const cells = value.match(/(?:^|\s)\d+(?:\.\d+)?%?(?=\s|$)/g) || [];
      if (!/[。！？；]/.test(value) && (cells.length >= 4
        || /^(?:目标模型|目标标签|成员得分|HSJA类型|\d+(?:\.\d+)?%\s*FPR下的TPR|CIFAR\d+\s+CIFAR\d+)(?:\s|$)/i.test(value))) return false;
      afterTable = false;
    }
    return !CAPTION.test(value)
      && !/^\([a-z]\)\s*.{0,95}$/i.test(value)
      && !/^(?:会议(?:信息)?未知|Conference (?:unknown|['’]17)|arXiv:\d)/i.test(value)
      && !/会议未知[，,]\s*日期未知[，,]\s*城市未知/.test(value)
      && !/^\|[^\n]*\|$/.test(value);
  }).join("\n");
}

function formatLegacyParts(parts) {
  let article = "";
  for (const part of parts) {
    const next = cleanLegacyText(part).trim();
    if (!next) continue;
    const last = article.split("\n").at(-1);
    const first = next.split("\n")[0];
    const continuation = article && !/[。！？；：!?.;：)）]$/.test(last)
      && !/^(?:#{1,6}\s|\d+(?:\.\d+)*\s|\$|(?:摘要|关键词|结论)$)/.test(first)
      && !/^(?:\d+(?:\.\d+)*\s|[A-Za-z]+\s*[:=])/.test(last)
      && last.length > 24 && /^[\u3400-\u9fff\[（(]/.test(first);
    article += (article && !continuation ? "\n\n" : "") + next;
  }
  return article
    .replace(/^([^\n]{8,90})\n(?:[^\n]*@[^\n]*\n){1,4}(?=\s*摘要)/,
      (_, title) => "# " + title.trim() + "\n\n")
    .replaceAll("成员得分", "成员分数")
    .replace(/非目标(?=MIA|攻击|HSJA)|非针对性(?=攻击)/g, "无目标")
    .replace(/机器学习中最流行的隐私攻击之一/g, "机器学习中最常见的隐私攻击之一")
    .replace(/输出置信度将每个样本的得分作为前提条件/g, "提供每个样本的置信度分数")
    .replace(/该造成这种高估的主要原因/g, "造成这种高估的主要原因")
    .replace(/MIA的目标是找到一个强大且可解释的成员分数函数来区分成员和非成员。对于给定的样本x、训练好的目标模型M、预测概率yc和真实标签yt，一般的成员分数函数smem可以表示如下：/g,
      "成员推理攻击旨在用有效且可解释的成员分数区分成员与非成员。给定样本 \\(x\\)、训练后的目标模型 \\(M\\)、预测概率 \\(y^c\\) 和真实标签 \\(y^t\\)，一般的成员分数函数 \\(s_{mem}\\) 可写为：")
    .replace(/当涉及仅标签MIA时，大多数都假设对手无法访问l和yc，而smem则改为表示如下：/g,
      "多数仅标签成员推理攻击假设攻击者无法获得损失函数 \\(l\\) 和置信度 \\(y^c\\)，因此将成员分数改写为：")
    .replace(/其中d表示x与xp之间的最小范数距离，xp从x的扰动样本中采样/g,
      "其中，\\(d\\) 表示 \\(x\\) 与 \\(x_p\\) 之间的最小范数距离。\\(x_p\\) 从 \\(x\\) 的扰动样本中选取")
    .replace(/。仅标签MIA背后的直觉是，成员平均而言比非成员更可能具有更长的决策边界距离/g,
      "。\n\n仅标签成员推理攻击基于这样一个观察：成员样本到决策边界的距离通常比非成员样本更大")
    .replace(/因此，我们的新攻击直觉是，成员的相对决策边界距离通常长于非成员。/g,
      "\n\n据此，作者提出一个新的判断依据：成员样本的相对决策边界距离通常比非成员样本更大。");
}

function legacyMarkdown(text) {
  return normalizeDisplayMath(text).split(/(\$\$\n[\s\S]*?\n\$\$)/g).map((part, index) => {
    if (index % 2) return part;
    return part.replace(/\s*•\s*/g, "\n- ").trim().split(/\n+/)
      .map(line => line.trim()).filter(Boolean).join("\n\n");
  }).filter(Boolean).join("\n\n");
}

function renderPart(doc, text, legacy, loadFormula, openFormula) {
  const section = element(doc, "section");
  const template = element(doc, "template");
  const fenced = /^\s*`{3}(?:markdown|md)\s*\r?\n([\s\S]*?)\r?\n`{3}\s*$/i.exec(text);
  let source = fenced ? fenced[1] : text;
  if (legacy && !fenced) {
    source = source.replace(
      /^(?:摘要|关键词|引言|相关工作|背景|方法|实验|实验结果|结果|讨论|结论|致谢|参考文献)[：:]?\s*$/gm,
      title => "## " + title.trim()
    ).replace(
      /^([1-9]\d?(?:\.\d+)*[.、]?\s+[\u3400-\u9fff][^\n。！？；!?;]{0,27})$/gm,
      (_, title) => (title.split(" ")[0].includes(".") ? "### " : "## ") + title
    );
  }
  template.innerHTML = markdown.render(legacy ? legacyMarkdown(source) : normalizeDisplayMath(source));
  section.append(template.content);
  for (const paragraph of section.querySelectorAll("p")) {
    const match = /^⟦DS-MATH:(\d+(?:\.\d+)*)⟧$/.exec(paragraph.textContent.trim());
    if (!match) continue;
    const formula = element(doc, "div", "正在读取原式…");
    formula.className = "ds-source-formula";
    paragraph.replaceWith(formula);
    const ref = match[1].split(".").map(Number);
    const showSourceLink = () => {
      const button = element(doc, "button", "在原 PDF 中定位公式");
      button.type = "button";
      button.addEventListener("click", () => void openFormula(ref));
      formula.replaceChildren(button);
    };
    void loadFormula(ref).then(sources => {
      if (!sources.length) throw new Error("No formula crop");
      formula.replaceChildren(...sources.map(source => {
        const image = element(doc, "img");
        image.alt = "原 PDF 公式";
        image.addEventListener("error", showSourceLink, { once: true });
        image.src = source;
        return image;
      }));
    }).catch(showSourceLink);
  }
  return section;
}

async function getFormulaSource(reader, ref) {
  const internal = reader._internalReader;
  const sdt = await internal._loadSDT();
  const block = ref.reduce((node, index) => node?.content?.[index], sdt?.structure);
  return { structure: sdt?.structure, block: block?.type === "math" ? block : null };
}

async function renderFormulaSource(reader, ref) {
  const view = reader._internalReader._primaryView;
  const { structure, block } = await getFormulaSource(reader, ref);
  if (!view || !block) return [];
  await view.initializedPromise;
  const clone = value => Components.utils.cloneInto(value, reader._iframeWindow);
  const valid = value => typeof value === "string" && value.startsWith("data:image/");
  try {
    const provider = view.createSDTBlockCropProvider?.(structure);
    const crops = provider?.(clone(ref)) ?? [];
    const images = [];
    for (const crop of crops) images.push(await crop.render());
    if (images.length && images.every(valid)) return images;
  } catch (error) {
    Zotero.logError(error);
  }
  // Use the original SDT page coordinates if the reading-mode provider cannot crop.
  const pages = new Map();
  for (const [pageIndex, x1, y1, x2, y2] of block.anchor?.pageRects ?? []) {
    const previous = pages.get(pageIndex);
    pages.set(pageIndex, previous
      ? [Math.min(previous[0], x1), Math.min(previous[1], y1), Math.max(previous[2], x2), Math.max(previous[3], y2)]
      : [x1, y1, x2, y2]);
  }
  const images = [];
  for (const [index, rect] of pages) {
    const [source] = await view._pdfRenderer.renderRegionCrops(index, clone([rect]));
    if (valid(source)) images.push(source);
  }
  return images;
}

function addToolbarButton({ reader, doc, append }) {
  const item = Zotero.Items.get(reader.itemID);
  if (!item?.isPDFAttachment()) return;
  let panel = panels.get(reader);
  if (!panel) {
    panel = createPanel(reader, item, doc);
    panels.set(reader, panel);
  }
  // A toolbar render can replace the custom section while the panel stays open.
  panel.button?.remove();
  panel.button = element(doc, "button", "全文翻译");
  panel.button.className = "ds-pdf-toolbar";
  panel.button.type = "button";
  panel.button.title = "显示或隐藏 DeepSeek 全文翻译";
  panel.button.setAttribute("aria-controls", "ds-pdf-panel");
  panel.button.setAttribute("aria-expanded", String(!panel.root.hidden));
  panel.button.addEventListener("click", () => panel.show(panel.root.hidden));
  append(panel.button);
}

function createPanel(reader, item, doc) {
  const style = element(doc, "style", `
    #ds-pdf-panel { position: absolute; inset: 41px 0 var(--bottom-placeholder-height, 0px) auto;
      z-index: 20; width: var(--ds-sidebar-width, 460px); box-sizing: border-box;
      background: var(--color-background, Canvas); color: var(--fill-primary, CanvasText);
      border-inline-start: 1px solid var(--color-panedivider, GrayText);
      display: flex; flex-direction: column; font: 14px/1.6 system-ui, "Microsoft YaHei", sans-serif;
      -webkit-font-smoothing: antialiased; }
    #ds-pdf-panel[hidden] { display: none; }
    body.ds-pdf-open #split-view, body.ds-pdf-open .split-view { right: var(--ds-sidebar-width, 460px); }
    #ds-pdf-panel .ds-resize { position: absolute; z-index: 1; top: 0; bottom: 0; left: -5px;
      width: 10px; cursor: ew-resize; touch-action: none; }
    #ds-pdf-panel .ds-resize:hover, #ds-pdf-panel .ds-resize:focus-visible,
    #ds-pdf-panel .ds-resize[data-dragging] { background: var(--accent-blue30); outline: none; }
    body.ds-pdf-resizing { cursor: ew-resize; user-select: none; }
    body.ds-pdf-resizing #split-view iframe, body.ds-pdf-resizing .split-view iframe { pointer-events: none; }
    .ds-pdf-toolbar { white-space: nowrap; border-radius: 6px; padding: 3px 7px !important; }
    .ds-pdf-toolbar[aria-expanded=true] { background: var(--accent-blue10); color: var(--accent-blue); }
    #ds-pdf-panel header { padding: 14px 18px 12px; display: flex; flex-wrap: wrap;
      align-items: center; gap: 7px; background: var(--color-toolbar);
      border-bottom: 1px solid var(--color-panedivider); }
    #ds-pdf-panel header strong { flex: 1; white-space: nowrap; font-size: 15px; }
    #ds-pdf-panel button, #ds-pdf-panel input { font: inherit; color: inherit; border-radius: 6px; }
    #ds-pdf-panel button { cursor: pointer; padding: 3px 8px; border: 1px solid var(--color-border);
      background: var(--color-button); white-space: nowrap; }
    #ds-pdf-panel button:hover:not(:disabled) { background: var(--accent-blue10); }
    #ds-pdf-panel button:disabled { opacity: .48; cursor: default; }
    #ds-pdf-panel .ds-primary { background: var(--accent-blue); color: white; border-color: transparent; }
    #ds-pdf-panel .ds-primary:hover:not(:disabled) { background: var(--accent-blue); filter: brightness(.9); }
    #ds-pdf-panel .ds-close { padding-inline: 7px; border-color: transparent; font-size: 17px; }
    #ds-pdf-panel form { margin: 0; padding: 12px 18px; background: var(--color-toolbar); }
    #ds-pdf-panel form input { width: 100%; box-sizing: border-box; margin-bottom: 7px; padding: 5px 8px;
      background: var(--color-control); border: 1px solid var(--color-border); }
    #ds-pdf-panel [role=status] { margin: 0; padding: 10px 18px; font-size: 12px; color: var(--fill-secondary); }
    #ds-pdf-panel progress { width: calc(100% - 36px); margin: 0 18px 8px; height: 5px;
      accent-color: var(--accent-blue); }
    #ds-pdf-panel article { overflow: auto; padding: 2px clamp(16px, 4vw, 30px) 28px;
      flex: 1; user-select: text; font-size: 15px; line-height: 1.72; overflow-wrap: anywhere;
      scrollbar-gutter: stable; }
    #ds-pdf-panel article section { max-inline-size: 38em; margin-inline: auto; }
    #ds-pdf-panel article p { margin: 0 0 1em; line-height: 1.78; }
    #ds-pdf-panel article h1, #ds-pdf-panel article h2, #ds-pdf-panel article h3,
    #ds-pdf-panel article h4, #ds-pdf-panel article h5, #ds-pdf-panel article h6 {
      font-weight: 650; line-height: 1.4; margin: 1.2em 0 .5em; }
    #ds-pdf-panel article h1 { font-size: 1.48em; letter-spacing: -.015em; margin: .1em 0 .8em; }
    #ds-pdf-panel article h2 { font-size: 1.2em; margin-top: 1.55em; }
    #ds-pdf-panel article h3, #ds-pdf-panel article h4 { font-size: 1.06em; margin-top: 1.25em; }
    #ds-pdf-panel article section > :first-child { margin-top: 0; }
    #ds-pdf-panel article ul, #ds-pdf-panel article ol { padding-inline-start: 1.45em; margin: 0 0 .9em; }
    #ds-pdf-panel article li { margin-block: .2em; }
    #ds-pdf-panel article blockquote { margin: .8em 0; padding: .4em .9em;
      background: var(--color-toolbar); border-inline-start: 3px solid var(--accent-blue50); }
    #ds-pdf-panel article blockquote p:last-child { margin-bottom: 0; }
    #ds-pdf-panel article pre { overflow: auto; padding: 10px; background: var(--color-toolbar); border-radius: 7px; }
    #ds-pdf-panel article code { font-family: ui-monospace, monospace; font-size: .9em; }
    #ds-pdf-panel article table { display: block; max-width: 100%; overflow: auto; border-collapse: collapse; }
    #ds-pdf-panel article :is(td, th) { padding: 4px 8px; border: 1px solid var(--color-border); }
    #ds-pdf-panel article th { background: var(--color-toolbar); text-align: start; }
    #ds-pdf-panel article hr { border: 0; border-top: 1px solid var(--color-border); margin: 1em 0; }
    #ds-pdf-panel article .ds-display-math, #ds-pdf-panel .ds-source-formula {
      display: block; box-sizing: border-box; overflow-x: auto; max-width: 100%;
      text-align: center; margin: .95em 0 1.1em; padding: .55em .75em;
      background: var(--fill-quinary); border-radius: 7px; }
    #ds-pdf-panel .ds-source-formula { color: var(--fill-secondary); }
    #ds-pdf-panel .ds-source-formula img { display: block; margin-inline: auto; max-width: 100%; height: auto; mix-blend-mode: multiply; }
    :root[data-color-scheme=dark] #ds-pdf-panel .ds-source-formula img {
      filter: invert(1); mix-blend-mode: screen; }
  `);
  doc.head.append(style);
  const root = element(doc, "aside");
  root.id = "ds-pdf-panel";
  root.setAttribute("aria-label", "DeepSeek 全文翻译");
  root.hidden = true;
  const divider = element(doc, "div");
  divider.className = "ds-resize";
  divider.tabIndex = 0;
  divider.setAttribute("role", "separator");
  divider.setAttribute("aria-orientation", "vertical");
  divider.setAttribute("aria-label", "调整全文译文侧栏宽度");
  divider.title = "拖动调整宽度，或使用左右方向键";
  const header = element(doc, "header");
  const start = element(doc, "button", "翻译全文");
  start.className = "ds-primary";
  const configure = element(doc, "button", "密钥");
  const close = element(doc, "button", "×");
  close.className = "ds-close";
  close.setAttribute("aria-label", "关闭译文侧栏");
  header.append(element(doc, "strong", "全文译文"), start, configure, close);

  const keyForm = element(doc, "form");
  keyForm.hidden = true;
  const keyInput = element(doc, "input");
  keyInput.type = "password";
  keyInput.placeholder = "DeepSeek 官方 API Key";
  keyInput.setAttribute("aria-label", keyInput.placeholder);
  keyInput.autocomplete = "off";
  const save = element(doc, "button", "保存密钥");
  save.type = "submit";
  keyForm.append(keyInput, save);
  const status = element(doc, "div");
  status.setAttribute("role", "status");
  const progress = element(doc, "progress");
  progress.hidden = true;
  progress.setAttribute("aria-label", "全文翻译进度");
  const output = element(doc, "article");
  output.lang = "zh-CN";
  root.append(divider, header, keyForm, status, progress, output);
  doc.body.append(root);

  const win = doc.defaultView;
  let preferredWidth = Zotero.Prefs.get(WIDTH_PREF, true) || 460;
  let actualWidth;
  let drag;
  function setWidth(width) {
    const min = Math.min(245, Math.round(win.innerWidth * .44));
    const max = Math.max(min, Math.min(win.innerWidth - 170, Math.round(win.innerWidth * .75)));
    actualWidth = Math.round(Math.max(min, Math.min(max, width)));
    doc.body.style.setProperty("--ds-sidebar-width", actualWidth + "px");
    divider.setAttribute("aria-valuemin", String(min));
    divider.setAttribute("aria-valuemax", String(max));
    divider.setAttribute("aria-valuenow", String(actualWidth));
  }
  const resize = () => setWidth(preferredWidth);
  const saveWidth = () => {
    preferredWidth = actualWidth;
    Zotero.Prefs.set(WIDTH_PREF, preferredWidth, true);
    for (const other of panels.values()) if (other !== panel) other.setPreferredWidth(preferredWidth);
  };
  divider.addEventListener("pointerdown", event => {
    if (event.button !== 0 || drag) return;
    event.preventDefault();
    divider.focus();
    drag = { pointer: event.pointerId, x: event.clientX, width: actualWidth };
    divider.setPointerCapture(event.pointerId);
    divider.setAttribute("data-dragging", "");
    doc.body.classList.add("ds-pdf-resizing");
  });
  divider.addEventListener("pointermove", event => {
    if (drag?.pointer === event.pointerId) setWidth(drag.width + drag.x - event.clientX);
  });
  divider.addEventListener("lostpointercapture", event => {
    if (drag?.pointer !== event.pointerId) return;
    drag = null;
    divider.removeAttribute("data-dragging");
    doc.body.classList.remove("ds-pdf-resizing");
    saveWidth();
  });
  divider.addEventListener("keydown", event => {
    const offset = { ArrowLeft: 24, ArrowRight: -24 }[event.key];
    if (!offset) return;
    event.preventDefault();
    setWidth(actualWidth + offset);
    saveWidth();
  });
  win.addEventListener("resize", resize);
  resize();

  let cache = { total: 0, parts: [] };
  let rendered = 0;
  let current = false;
  let disposed = false;
  let oldTranslation = false;
  let legacyPlainText = false;
  const formulaCrops = new Map();
  let formulaQueue = Promise.resolve();
  function loadFormula(ref) {
    const key = ref.join(".");
    if (!formulaCrops.has(key)) {
      const work = formulaQueue.then(() => disposed ? [] : renderFormulaSource(reader, ref));
      formulaCrops.set(key, work);
      formulaQueue = work.then(images => {
        if (!images.length) formulaCrops.delete(key);
      }, error => {
        formulaCrops.delete(key);
        Zotero.logError(error);
      });
    }
    return formulaCrops.get(key);
  }
  async function openFormula(ref) {
    try {
      const { block } = await getFormulaSource(reader, ref);
      const [pageIndex, ...rect] = block?.anchor?.pageRects?.[0] ?? [];
      if (Number.isInteger(pageIndex) && rect.length === 4) {
        reader.navigate({ position: { pageIndex, rects: [rect] } });
      }
    } catch (error) {
      Zotero.logError(error);
    }
  }
  const panel = {
    root,
    path: null,
    button: null,
    setPreferredWidth(width) {
      preferredWidth = width;
      if (!drag) resize();
    },
    show(visible) {
      root.hidden = !visible;
      doc.body.classList.toggle("ds-pdf-open", visible);
      panel.button?.setAttribute("aria-expanded", String(visible));
    },
    update({ data, busy, message, replaced }) {
      if (disposed) return;
      if (replaced && oldTranslation) {
        oldTranslation = false;
        legacyPlainText = false;
        output.replaceChildren();
        rendered = 0;
      }
      if (data) {
        if (data.parts.length < rendered || data.total !== cache.total) {
          output.replaceChildren();
          rendered = 0;
        }
        cache = data;
        if (legacyPlainText && !rendered && data.parts.length) {
          output.append(renderPart(doc, formatLegacyParts(data.parts), true, loadFormula, openFormula));
          rendered = data.parts.length;
        }
        while (rendered < data.parts.length) {
          output.append(renderPart(doc, data.parts[rendered], false, loadFormula, openFormula));
          rendered++;
        }
      }
      const done = cache.total > 0 && cache.parts.length === cache.total;
      if (busy !== undefined) current = busy;
      progress.hidden = !current || !cache.total;
      progress.max = cache.total || 1;
      progress.value = cache.parts.length;
      start.textContent = current ? "停止" : oldTranslation ? "上传 PDF 重译" : "上传并翻译";
      start.disabled = !panel.path || (done && !current && !oldTranslation);
      if (message !== undefined || done) {
        status.textContent = message || (oldTranslation ? "已保存的译文 · 重译会将完整 PDF 上传给 DeepSeek"
          : done ? "正文翻译完成" : "开始后会将完整 PDF 上传给 DeepSeek。");
      }
    },
    dispose() {
      disposed = true;
      panel.show(false);
      panel.button?.remove();
      root.remove();
      style.remove();
      doc.body.classList.remove("ds-pdf-resizing");
      doc.body.style.removeProperty("--ds-sidebar-width");
      win.removeEventListener("resize", resize);
      doc.defaultView?.removeEventListener("unload", panel.dispose);
      panels.delete(reader);
    }
  };

  close.addEventListener("click", () => panel.show(false));
  configure.addEventListener("click", () => {
    keyForm.hidden = !keyForm.hidden;
    if (!keyForm.hidden) keyInput.focus();
  });
  keyForm.addEventListener("submit", async event => {
    event.preventDefault();
    const key = keyInput.value.trim();
    if (!/^sk-[\w-]+$/.test(key)) {
      status.textContent = "请输入 DeepSeek 官方平台生成的 API Key。";
      return;
    }
    save.disabled = true;
    try {
      await saveKey(key);
      keyInput.value = "";
      keyForm.hidden = true;
      status.textContent = "密钥已保存，可以开始翻译。";
    } catch {
      status.textContent = "无法保存密钥，请确认 Zotero 的密码存储可用。";
    } finally {
      save.disabled = false;
    }
  });
  start.addEventListener("click", () => {
    const running = jobs.get(panel.path);
    if (running) {
      running.cancelled = true;
      status.textContent = "正在停止，当前请求结束后生效…";
      return;
    }
    let key;
    try { key = savedLogin()?.password; } catch {}
    if (!key) {
      keyForm.hidden = false;
      keyInput.focus();
      status.textContent = "请先填写 DeepSeek API Key。";
      return;
    }
    void translate(item, panel.path, key);
  });

  doc.defaultView.addEventListener("unload", panel.dispose, { once: true });
  panel.update({ message: "正在检查本地译文…" });
  void (async () => {
    try {
      const path = await getCachePath(item);
      let data = await readCache(path);
      if (!data.parts.length) {
        for (const version of [3, 2, 1]) {
          data = await readCache(await getCachePath(item, version));
          if (!data.parts.length) continue;
          oldTranslation = true;
          legacyPlainText = version === 1;
          break;
        }
        if (legacyPlainText) {
          const final = data.parts.findIndex(part => part.split("\n").some(line => END_MATTER.test(line.trim())));
          if (final >= 0) data = { total: final + 1, parts: data.parts.slice(0, final + 1) };
        }
      }
      if (disposed) return;
      panel.path = path;
      if (data.parts.length || jobs.has(path)) panel.show(true);
      panel.update({ data, busy: jobs.has(path), message: "" });
    } catch {
      panel.update({ message: "无法读取 PDF，请确认附件已下载。" });
    }
  })();
  return panel;
}
