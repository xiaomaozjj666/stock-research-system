// pdfjs-dist 是可选依赖（未安装时系统降级）。为让测试文件的静态 import 通过 tsc，
// 提供最小类型声明（运行时仍由 vi.mock / 动态 import 控制）。
declare module 'pdfjs-dist/legacy/build/pdf.mjs' {
  export interface PDFTextItem {
    str?: string;
  }
  export interface PDFPageProxy {
    getTextContent: () => Promise<{ items: PDFTextItem[] }>;
  }
  export interface PDFDocumentProxy {
    numPages: number;
    getPage: (n: number) => Promise<PDFPageProxy>;
  }
  export function getDocument(data: unknown): { promise: Promise<PDFDocumentProxy> };
}
