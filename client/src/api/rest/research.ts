/**
 * 研究增强域：文档库 / 研究简报 / 预注册假设（theses）。
 */
import type {
  GETApiDocumentsResponse as DocumentListResponse,
  POSTApiThesesRequestBody as CreateThesisRequest,
  POSTApiThesesResponse as CreateThesisResponse,
  DocumentInsight as GeneratedDocumentInsight,
  GETApiThesesResponse as ThesisListResponse,
  POSTApiThesesIdEvaluateResponse as EvaluateThesisResponse,
} from '../generated';
import { api, normalizeApiError } from './base';

/**
 * 文档洞察。
 *
 * 原先是手写 interface，且把 confidence/source 放宽成 number / string。
 * 服务端 documentInsights.ts 的真实类型是三个字面量联合，契约里也是
 * （'high'|'medium'|'low' 与 'llm'|'heuristic'）——放宽会让消费方写出
 * 永远走不到的类型分支，并把「LLM 未配置时 source='heuristic'」这个
 * 关键降级信号退化成普通字符串。故直接用契约生成的类型。
 */
export type IngestInsight = GeneratedDocumentInsight;
export interface IngestResult {
  id: string;
  title: string;
  ingested: boolean;
  insight: IngestInsight;
}
export async function ingestDocument(payload: {
  title: string;
  text?: string;
  pdfBase64?: string;
  stockCode?: string;
}): Promise<IngestResult> {
  try {
    const response = await api.post<IngestResult>('/ingest', payload, { timeout: 120000 });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '文档入库失败');
  }
}
export async function listDocuments(): Promise<DocumentListResponse> {
  try {
    const response = await api.get<DocumentListResponse>('/documents', { timeout: 15000 });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '读取资料库失败');
  }
}

/** 研究简报（初筛 + 台账聚合的定期快照） */
export interface ResearchDigest {
  id: string;
  createdAt: string;
  screener: {
    at: string | null;
    scanned: number | null;
    eligible: number | null;
    hitCount: number | null;
    topHits: { code: string; name: string; strategy: string; detail: string }[];
  };
  ledger: {
    total: number;
    kept: number;
    keptExpectedFalse: number;
    keptOosShare: number;
    bySource: Record<string, number>;
  };
  notes: string[];
}

export async function getResearchDigests(limit = 10): Promise<{ items: ResearchDigest[] }> {
  try {
    const response = await api.get<{ items: ResearchDigest[] }>('/quant/digests', {
      params: { limit },
      timeout: 15000,
    });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '研究简报读取失败');
  }
}

export async function runResearchDigestNow(): Promise<ResearchDigest> {
  try {
    const response = await api.post<ResearchDigest>('/quant/digests/run', {}, { timeout: 60000 });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '研究简报生成失败');
  }
}

export async function getTheses(stockCode: string): Promise<ThesisListResponse> {
  try {
    const response = await api.get<ThesisListResponse>('/theses', {
      params: { stockCode },
      timeout: 15000,
    });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '预注册实验读取失败');
  }
}

export async function createThesis(input: CreateThesisRequest): Promise<CreateThesisResponse> {
  try {
    const response = await api.post<CreateThesisResponse>('/theses', input, { timeout: 15000 });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '预注册创建失败');
  }
}

export async function evaluateThesis(id: string): Promise<EvaluateThesisResponse> {
  try {
    const response = await api.post<EvaluateThesisResponse>(`/theses/${id}/evaluate`, undefined, {
      timeout: 30000,
    });
    return response.data;
  } catch (error: unknown) {
    throw normalizeApiError(error, '预注册评估失败');
  }
}
