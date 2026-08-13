import { describe, it, expect, vi } from 'vitest';
import { extractTextFromPdf } from '../pdfExtract.js';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  getDocument: vi.fn(),
}));

interface MockPage {
  getTextContent: () => Promise<{ items: { str?: string }[] }>;
}

interface MockPdf {
  numPages: number;
  getPage: (n: number) => Promise<MockPage>;
}

function installPdf(pdf: MockPdf): typeof getDocument {
  vi.mocked(getDocument).mockReturnValue({ promise: Promise.resolve(pdf) });
  return getDocument;
}

function page(items: { str?: string }[]): MockPage {
  return {
    getTextContent: async () => ({ items }),
  };
}

describe('extractTextFromPdf', () => {
  it('单页抽取：逐条文本以空格拼接并追加换行', async () => {
    installPdf({
      numPages: 1,
      getPage: async () => page([{ str: 'Hello' }, { str: 'World' }]),
    });
    const text = await extractTextFromPdf(Buffer.from('fake-pdf'));
    expect(text).toBe('Hello World\n');
    // getDocument 收到 Uint8Array 数据
    const arg = vi.mocked(getDocument).mock.calls[0][0] as { data: Uint8Array };
    expect(arg.data).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(arg.data).toString()).toBe('fake-pdf');
  });

  it('多页拼接：每页换行分隔', async () => {
    installPdf({
      numPages: 2,
      getPage: async (n) => page([{ str: n === 1 ? 'Page one' : 'Page two' }]),
    });
    const text = await extractTextFromPdf(Buffer.from('x'));
    expect(text).toBe('Page one\nPage two\n');
  });

  it('items 缺少 str 字段时安全地以空串拼接', async () => {
    installPdf({
      numPages: 1,
      getPage: async () => page([{ str: 'A' }, {}, { str: 'B' }]),
    });
    const text = await extractTextFromPdf(Buffer.from('x'));
    expect(text).toBe('A  B\n');
  });

  it('超大文档超过 20000 字符时提前截断（不再读取后续页）', async () => {
    const getPage = vi.fn(async () => page([{ str: 'x'.repeat(30000) }]));
    installPdf({ numPages: 10, getPage });
    const text = await extractTextFromPdf(Buffer.from('x'));
    expect(getPage).toHaveBeenCalledTimes(1);
    expect(text.length).toBeGreaterThan(20000);
    expect(text.length).toBeLessThanOrEqual(30001);
  });

  it('pdfjs-dist 未安装时抛出清晰错误提示', async () => {
    // 先探测 pdfjs-dist 是否真实安装（import.meta.resolve 走 Node 解析，不受 vi.mock 影响）；
    // 一旦将来安装该包，本用例场景消失，直接跳过避免误失败。
    let installed = true;
    try {
      await import.meta.resolve('pdfjs-dist/legacy/build/pdf.mjs');
    } catch {
      installed = false;
    }
    if (installed) return;
    vi.doUnmock('pdfjs-dist/legacy/build/pdf.mjs');
    await expect(extractTextFromPdf(Buffer.from('x'))).rejects.toThrow(
      'PDF 抽取需要安装 pdfjs-dist',
    );
  });
});
