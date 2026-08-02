/**
 * 行业同业可比参考数据集。
 *
 * 用途：在实时证券主数据（东方财富 push2 全表）不可用时，提供 A 股主要行业的
 * 同业可比公司列表，用于对标的估值对比（peerComparison）。
 *
 * - 数据均为 A 股真实上市公司代码（非虚构）。
 * - 估值（PE/PB/总市值）在运行期通过 datacenter 实时拉取，本表只提供「同业分组」。
 * - 生产环境下若 push2 主表可用，则优先使用主表的真实行业分组；本表作为兜底与补充。
 */

export interface IndustryPeerRef {
  /** 行业中文名（用于展示与匹配） */
  industry: string;
  /** 关键词：命中东方财富 BOARD_NAME 即归入该行业（如 "白酒Ⅱ" 含 "白酒"） */
  keywords: string[];
  /** 同业可比公司代码（A股6位） */
  peers: string[];
}

export const INDUSTRY_PEER_REFS: IndustryPeerRef[] = [
  { industry: '白酒', keywords: ['白酒'], peers: ['000858', '000568', '600809', '002304', '000596', '000799'] },
  { industry: '啤酒', keywords: ['啤酒'], peers: ['600132', '000729', '002461'] },
  { industry: '银行', keywords: ['银行'], peers: ['601398', '601939', '601288', '601988', '600036', '601166', '601328'] },
  { industry: '保险', keywords: ['保险'], peers: ['601318', '601628', '601601', '601336', '601319'] },
  { industry: '证券', keywords: ['证券'], peers: ['600030', '600837', '601211', '000776', '600999', '601688'] },
  { industry: '房地产', keywords: ['房地产', '地产'], peers: ['000002', '600048', '001979', '600383', '000069'] },
  { industry: '电力', keywords: ['电力', '水电', '火电', '热电'], peers: ['600900', '600886', '600674', '601985', '003816', '600023'] },
  { industry: '光伏', keywords: ['光伏', '太阳能'], peers: ['601012', '600438', '002129', '688599', '601877'] },
  { industry: '新能源车', keywords: ['新能源车', '电动汽车', '锂电'], peers: ['300750', '002594', '300014', '002460', '601127'] },
  { industry: '汽车', keywords: ['汽车', '乘用车', '商用车'], peers: ['600104', '000625', '601238', '601633', '000927'] },
  { industry: '医药', keywords: ['医药', '化学制药', '生物制品'], peers: ['600276', '000538', '600196', '300760', '600436'] },
  { industry: '医疗器械', keywords: ['医疗器械', '医疗服务'], peers: ['300760', '300003', '002223', '688271'] },
  { industry: '半导体', keywords: ['半导体', '集成电路'], peers: ['688981', '603501', '688041', '002049', '603986', '688256'] },
  { industry: '消费电子', keywords: ['消费电子'], peers: ['002475', '300433', '601138', '002241'] },
  { industry: '家电', keywords: ['家电', '白色家电', '小家电'], peers: ['000333', '000651', '600690', '002032', '000100'] },
  { industry: '食品饮料', keywords: ['食品', '调味', '乳业'], peers: ['600887', '603288', '002507', '600887'] },
  { industry: '钢铁', keywords: ['钢铁', '普钢', '特钢'], peers: ['600019', '000709', '600808', '000932'] },
  { industry: '煤炭', keywords: ['煤炭', '煤'], peers: ['601088', '600188', '601225', '600348', '601001'] },
  { industry: '石油石化', keywords: ['石油', '石化'], peers: ['600028', '601857', '600938', '600688'] },
  { industry: '化工', keywords: ['化工', '化学制品', '化学原料'], peers: ['600309', '002493', '600426', '600989'] },
  { industry: '工程机械', keywords: ['工程机械', '专用设备'], peers: ['600031', '000425', '601100', '000157'] },
  { industry: '计算机', keywords: ['软件', '计算机', 'IT服务'], peers: ['600570', '002230', '300454', '688111', '002410'] },
  { industry: '通信', keywords: ['通信', '电信', '通信设备'], peers: ['600050', '601728', '600941', '000063', '002396'] },
  { industry: '传媒', keywords: ['传媒', '出版', '广告'], peers: ['300413', '002027', '601928', '300058'] },
  { industry: '建材', keywords: ['建材', '水泥', '玻璃'], peers: ['600585', '000786', '002271', '600176'] },
  { industry: '航空机场', keywords: ['航空', '机场', '航运'], peers: ['601111', '600029', '601006', '600009', '600115'] },
  { industry: '农业', keywords: ['农业', '种植', '饲料'], peers: ['002311', '000998', '600598', '002385'] },
  { industry: '军工', keywords: ['军工', '航空装备', '航天'], peers: ['600760', '600893', '000768', '600316'] },
  { industry: '有色金属', keywords: ['有色', '工业金属', '黄金', '小金属'], peers: ['600362', '600547', '603993', '000630', '601600'] },
  { industry: '建筑', keywords: ['建筑', '基建', '工程'], peers: ['601668', '601390', '601186', '601800'] },
  { industry: '物流', keywords: ['物流', '快递'], peers: ['600233', '002120', '601156', '600270'] },
  { industry: '零售', keywords: ['零售', '免税', '百货'], peers: ['601888', '600859', '000759', '600729'] },
  { industry: '纺织服装', keywords: ['服装', '纺织'], peers: ['600398', '002563', '603877'] },
  { industry: '造纸', keywords: ['造纸'], peers: ['600966', '002511', '002078'] },
];

/** 代码 -> 行业（由上面的参考表反查，方便「已知代码反推行业」） */
export const CODE_TO_INDUSTRY: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const ref of INDUSTRY_PEER_REFS) {
    for (const code of ref.peers) {
      if (!map[code]) map[code] = ref.industry;
    }
  }
  // 常见研究标的（可能不在 peers 列表中）
  const extra: Record<string, string> = {
    '600519': '白酒', '000858': '白酒', '601318': '保险', '600036': '银行',
    '000001': '银行', '600000': '银行', '601166': '银行', '600016': '银行',
    '300750': '新能源车', '002594': '新能源车', '600276': '医药', '000333': '家电',
    '601012': '光伏', '600900': '电力', '601088': '煤炭',
    '600028': '石油石化', '600309': '化工', '600031': '工程机械', '600050': '通信',
    '688825': '半导体', /* 长鑫科技：2026-07-27 登陆科创板，国产 DRAM 龙头 */
    '601899': '有色金属', '300059': '证券', '600887': '食品饮料', '002415': '计算机',
    '000725': '消费电子', '601668': '建筑', '600009': '航空机场', '601888': '零售',
  };
  for (const [code, ind] of Object.entries(extra)) map[code] = ind;
  return map;
})();

/** 去掉行业名中的罗马数字序号（Ⅰ/Ⅱ/Ⅲ/Ⅳ/V…），便于关键词匹配 */
function normalizeIndustryName(name: string): string {
  return name.replace(/[Ⅰ-Ⅹ]/g, '').replace(/\s+/g, '').trim();
}

/**
 * 解析股票所属行业。
 * 优先级：代码反查 -> BOARD_NAME 关键词匹配 -> 未命中返回 undefined。
 */
export function resolveIndustry(boardName: string | undefined, code: string | undefined): string | undefined {
  if (code && CODE_TO_INDUSTRY[code]) return CODE_TO_INDUSTRY[code];
  if (boardName) {
    const norm = normalizeIndustryName(boardName);
    for (const ref of INDUSTRY_PEER_REFS) {
      if (ref.keywords.some(k => norm.includes(k) || k.includes(norm))) return ref.industry;
    }
  }
  return undefined;
}

/**
 * 获取同行业可比公司代码（排除自身），最多 limit 只。
 */
export function getPeerCodes(industry: string | undefined, selfCode: string | undefined, limit = 4): string[] {
  if (!industry) return [];
  const ref = INDUSTRY_PEER_REFS.find(r => r.industry === industry);
  if (!ref) return [];
  return ref.peers.filter(c => c !== selfCode).slice(0, limit);
}
