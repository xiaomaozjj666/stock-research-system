import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 生产适配器的单元测试
 * ----------------------------------------------------------------------------
 * 这里覆盖的是「研究引擎与系统既有通道之间的接线」，分三类风险：
 *   1. 代码提取：把非股票问题误判成个股问题（会导致检索跑偏、证据全不相干）
 *   2. 协议履约：search 与 fetch 两段式协议必须闭合，否则编排器拿到空正文
 *   3. 降级契约：适配器该返回空还是该抛错，直接决定降级链是否按预期流动
 */

const mocks = vi.hoisted(() => ({
  chat: vi.fn(),
  listAnnouncements: vi.fn(),
  fetchAnnouncementContent: vi.fn(),
  fetchLatestNews: vi.fn(),
  retrieveEvidence: vi.fn(),
}));

vi.mock('../../llm/client.js', () => ({ chat: mocks.chat }));

vi.mock('../../quant/announcementProvider.js', () => ({
  ANNOUNCEMENT_CONTENT_LIMIT: 4000,
  fetchAnnouncementList: mocks.listAnnouncements,
  fetchAnnouncementContent: mocks.fetchAnnouncementContent,
}));

vi.mock('../../quant/newsSignal.js', () => ({ fetchLatestNews: mocks.fetchLatestNews }));

vi.mock('../../llm/rag.js', () => ({ retrieveEvidence: mocks.retrieveEvidence }));

import {
  createAnnouncementAdapter,
  createDefaultSearchAdapters,
  createKnowledgeBaseAdapter,
  createLLMAdapter,
  createNewsAdapter,
  extractStockCode,
} from '../adapters.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('extractStockCode', () => {
  it('从含代码的问题中取出合法 A 股代码', () => {
    expect(extractStockCode('600519 最新公告怎么解读')).toBe('600519');
    expect(extractStockCode('看看 300750 的产能利用率')).toBe('300750');
    expect(extractStockCode('688981 中芯国际')).toBe('688981');
  });

  it('无代码的问题返回 null，交由知识库通道兜底', () => {
    expect(extractStockCode('白酒行业未来两年的竞争格局')).toBeNull();
    expect(extractStockCode('2027 年光伏产能出清进展')).toBeNull();
  });

  it('不把长数字串中的子串误当成代码', () => {
    // 10 位订单号里嵌着 6 位数字，前后都紧邻数字 → 不是代码
    expect(extractStockCode('订单号 1234567890 已生成')).toBeNull();
  });

  it('丢弃前缀不合法的 6 位数字', () => {
    expect(extractStockCode('合同编号 999999 签署')).toBeNull();
  });
});

describe('createLLMAdapter', () => {
  it('把 system 与 user 两段提示拼成对话并透传温度', async () => {
    mocks.chat.mockResolvedValue('{"ok":true}');
    const adapter = createLLMAdapter({ timeoutMs: 1234 });

    const text = await adapter.complete({
      system: '你是分析师',
      prompt: '请拆解问题',
      temperature: 0.5,
    });

    expect(text).toBe('{"ok":true}');
    const [messages, options] = mocks.chat.mock.calls[0] as [
      Array<{ role: string; content: string }>,
      Record<string, unknown>,
    ];
    expect(messages).toEqual([
      { role: 'system', content: '你是分析师' },
      { role: 'user', content: '请拆解问题' },
    ]);
    expect(options.temperature).toBe(0.5);
    expect(options.timeout).toBe(1234);
  });

  it('无 system 时只发用户消息，避免空 system 干扰模型', async () => {
    mocks.chat.mockResolvedValue('ok');
    await createLLMAdapter().complete({ system: '   ', prompt: 'q' });

    const [messages] = mocks.chat.mock.calls[0] as [Array<{ role: string }>];
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe('user');
  });

  it('模型返回空串时抛错，交给上层重试而不是写进报告', async () => {
    mocks.chat.mockResolvedValue('   ');
    await expect(createLLMAdapter().complete({ prompt: 'q' })).rejects.toThrow('LLM 返回空内容');
  });
});

describe('createAnnouncementAdapter', () => {
  it('无股票代码时返回空结果，让降级链继续往下走', async () => {
    const hits = await createAnnouncementAdapter().search({
      query: '白酒行业格局',
      maxResults: 3,
    });
    expect(hits).toEqual([]);
    expect(mocks.listAnnouncements).not.toHaveBeenCalled();
  });

  it('命中时带上公司披露来源层级与可回溯地址', async () => {
    mocks.listAnnouncements.mockResolvedValue({
      code: '600519',
      announcements: [
        { artCode: 'A1', title: '关于产能扩建的公告', date: '2026-03-01' },
        { artCode: 'A2', title: '月度经营数据', date: '2026-04-01' },
      ],
    });

    const hits = await createAnnouncementAdapter().search({
      query: '600519 产能扩建进展',
      maxResults: 2,
    });

    expect(hits).toHaveLength(2);
    // 关键词命中的排在前面：产能扩建比月度经营数据更贴合查询
    expect(hits[0]!.title).toBe('关于产能扩建的公告');
    expect(hits[0]!.sourceType).toBe('company_disclosure');
    expect(hits[0]!.url).toBe('em-ann://A1');
    expect(hits[0]!.publishedAt).toBe('2026-03-01');
  });

  it('search 返回的地址能被 fetch 还原成正文', async () => {
    mocks.listAnnouncements.mockResolvedValue({
      code: '600519',
      announcements: [{ artCode: 'A 1/2', title: '公告', date: '2026-03-01' }],
    });
    mocks.fetchAnnouncementContent.mockResolvedValue('正文内容');

    const adapter = createAnnouncementAdapter();
    const [hit] = await adapter.search({ query: '600519 公告', maxResults: 1 });
    const doc = await adapter.fetch(hit!.url);

    expect(mocks.fetchAnnouncementContent).toHaveBeenCalledWith('A 1/2');
    expect(doc.text).toBe('正文内容');
  });

  it('正文为空时抛错，让编排器记为检索失败而非拿到空证据', async () => {
    mocks.fetchAnnouncementContent.mockResolvedValue('   ');
    await expect(createAnnouncementAdapter().fetch('em-ann://A1')).rejects.toThrow('公告正文为空');
  });
});

describe('createNewsAdapter', () => {
  it('无股票代码时不请求上游', async () => {
    const hits = await createNewsAdapter().search({ query: '光伏行业', maxResults: 3 });
    expect(hits).toEqual([]);
    expect(mocks.fetchLatestNews).not.toHaveBeenCalled();
  });

  it('按关键词排序并标注媒体来源层级', async () => {
    mocks.fetchLatestNews.mockResolvedValue([
      { id: 'n1', title: '公司发布季度报告', publishedAt: '2026-04-02', summary: '摘要一' },
      { id: 'n2', title: '产能扩建项目投产', publishedAt: '2026-04-01', summary: '摘要二' },
    ]);

    const hits = await createNewsAdapter().search({
      query: '600519 产能扩建',
      maxResults: 2,
    });

    expect(hits[0]!.title).toBe('产能扩建项目投产');
    expect(hits[0]!.sourceType).toBe('news_media');
  });

  it('fetch 能取回 search 阶段缓存的正文（两段式协议闭合）', async () => {
    mocks.fetchLatestNews.mockResolvedValue([
      { id: 'n1', title: '标题', publishedAt: '2026-04-02', summary: '摘要' },
    ]);

    const adapter = createNewsAdapter();
    const [hit] = await adapter.search({ query: '600519 标题', maxResults: 1 });
    const doc = await adapter.fetch(hit!.url);

    expect(doc.title).toBe('标题');
    expect(doc.text).toContain('摘要');
    expect(doc.publishedAt).toBe('2026-04-02');
  });

  it('缓存未命中时抛错，避免返回空正文污染下游抽取', async () => {
    await expect(createNewsAdapter().fetch('em-news://600519/unknown')).rejects.toThrow(
      '新闻正文未命中缓存',
    );
  });
});

describe('createKnowledgeBaseAdapter', () => {
  it('把召回文档映射为内部资料来源', async () => {
    mocks.retrieveEvidence.mockResolvedValue([
      { id: 'd1', source: '光伏行业跟踪报告', text: '硅料价格连续三个月下行' },
    ]);

    const hits = await createKnowledgeBaseAdapter({ topK: 3 }).search({
      query: '硅料价格',
      maxResults: 3,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]!.sourceType).toBe('internal_doc');
    // 出版方 = 文档真实来源分类（doc.source），写常量会把来源独立性折叠成单一值
    expect(hits[0]!.publisher).toBe('光伏行业跟踪报告');
    expect(hits[0]!.snippet).toContain('硅料价格');
  });

  it('文档无来源分类时省略 publisher（验证器回落 URL 判文档级独立性）', async () => {
    mocks.retrieveEvidence.mockResolvedValue([
      { id: 'd2', source: undefined, text: '无来源内部笔记' },
    ]);
    const hits = await createKnowledgeBaseAdapter({ topK: 3 }).search({
      query: '笔记',
      maxResults: 3,
    });
    expect(hits[0]!.publisher).toBeUndefined();
    expect(hits[0]!.title).toContain('内部资料');
  });

  it('召回为空时返回空数组（这是合法结果，不是异常）', async () => {
    mocks.retrieveEvidence.mockResolvedValue([]);
    const hits = await createKnowledgeBaseAdapter().search({ query: '无命中', maxResults: 3 });
    expect(hits).toEqual([]);
  });

  it('fetch 能取回缓存的正文', async () => {
    mocks.retrieveEvidence.mockResolvedValue([{ id: 'd1', source: '报告', text: '正文' }]);
    const adapter = createKnowledgeBaseAdapter();
    const [hit] = await adapter.search({ query: 'q', maxResults: 1 });
    const doc = await adapter.fetch(hit!.url);
    expect(doc.text).toBe('正文');
  });
});

describe('createDefaultSearchAdapters', () => {
  it('按权威度排序：公告 -> 新闻 -> 内部知识库', () => {
    expect(createDefaultSearchAdapters().map((a) => a.name)).toEqual([
      'eastmoney.announcement',
      'eastmoney.news',
      'internal.knowledge_base',
    ]);
  });
});
