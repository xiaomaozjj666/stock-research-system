/**
 * PDF 文本抽取（可选依赖 pdfjs-dist）
 * ----------------------------------------------------------------------------
 * 用动态 import 加载 pdfjs-dist（不写死为静态依赖，避免未安装时 tsc/构建失败）。
 * 未安装 pdfjs-dist 时，extractTextFromPdf 抛出清晰错误，调用方应回退到纯文本入口。
 */
export async function extractTextFromPdf(buffer: Buffer): Promise<string> {
  // 用变量持有 specifier，使 tsc 不解析该模块路径（未安装也不报错）
  const spec = 'pdfjs-dist/legacy/build/pdf.mjs';
  let mod: {
    getDocument: (p: unknown) => {
      promise: Promise<{
        numPages: number;
        getPage: (
          n: number,
        ) => Promise<{ getTextContent: () => Promise<{ items: { str?: string }[] }> }>;
      }>;
    };
  };
  try {
    mod = (await import(spec)) as unknown as typeof mod;
  } catch {
    throw new Error('PDF 抽取需要安装 pdfjs-dist（npm i pdfjs-dist），或改用纯文本入口 text');
  }
  const data = new Uint8Array(buffer);
  const pdf = await mod.getDocument({ data }).promise;
  let text = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((it) => it.str || '').join(' ') + '\n';
    if (text.length > 20000) break; // 截断超大文档
  }
  return text;
}
