/**
 * 数据源 provider 注册表（quant/providers）
 * ----------------------------------------------------------------------------
 * 设计目标：**最小但真实可扩展**。核心取数流程（缓存 / 增量补尾 / look-ahead /
 * 降级）继续由 dataProvider 独占，注册表只解决「用哪个上游适配器」：
 *
 * - `registerProvider`：注册/覆盖 provider（同 id 原位覆盖，列表顺序不变）；
 * - `getProvider(id?)`：按 id 取 provider；不传 id 取当前启用 provider；
 * - `listProviders`：按启用顺序（DATA_PROVIDERS）排列，未列出的按注册顺序追加；
 * - `providerSupports`：能力声明 + 可选方法双重判定，避免「声明了但没实现」。
 *
 * `DATA_PROVIDERS`（逗号分隔）只做**选择/排序已注册 provider**：取第一个可用项；
 * 未知 id 记 warning 并忽略，全部不可用时回落默认 `eastmoney`。本轮不内置新数据源，
 * 默认配置（不设 DATA_PROVIDERS）行为与改造前完全一致。
 */
import logger from '../../utils/logger.js';
import { eastmoneyProvider } from './eastmoney.js';
import type { DataProvider } from './types.js';

/** 默认 provider：未配置 DATA_PROVIDERS 或配置全部无效时使用 */
export const DEFAULT_PROVIDER_ID = 'eastmoney';

/** 已注册 provider：Map 保持插入顺序（listProviders 的兜底顺序） */
const providers = new Map<string, DataProvider>();

/** 默认 provider 在模块加载期注册；重复注册同 id 可覆盖（见 registerProvider） */
providers.set(eastmoneyProvider.id, eastmoneyProvider);

/** 可选能力名（与 ProviderCapabilities 的布尔字段对应） */
export type ProviderCapability = 'kline' | 'quote' | 'financial';

/**
 * 未知 id 告警去重：同一份 DATA_PROVIDERS 只提示一次。
 * 取数按股票逐个调用 getProvider，若每条都 warn，一次全市场扫描会刷出几千行。
 */
let lastUnknownWarningSignature: string | null = null;

/** 解析 DATA_PROVIDERS：逗号分隔、去空白、小写归一、保序去重 */
function parseProviderIds(raw: string | undefined): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const part of (raw ?? '').split(',')) {
    const id = part.trim().toLowerCase();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/** 默认 provider：eastmoney 被覆盖/移除时退到第一个已注册项；全空则明确报错 */
function defaultProvider(): DataProvider {
  const fallback = providers.get(DEFAULT_PROVIDER_ID);
  if (fallback) return fallback;
  const first = providers.values().next().value;
  if (!first) {
    throw new Error('未注册任何数据源 provider（请调用 registerProvider）');
  }
  return first;
}

function warnUnknownProviderIds(raw: string, unknown: string[]): void {
  if (unknown.length === 0) return;
  const signature = `${raw}::${unknown.join(',')}`;
  if (signature === lastUnknownWarningSignature) return;
  lastUnknownWarningSignature = signature;
  logger.warn('DATA_PROVIDERS 含未注册的数据源 provider，已忽略', {
    unknown,
    registered: [...providers.keys()],
  });
}

/**
 * 注册数据源 provider。
 * 同 id 重复注册会**原位覆盖**（Map.set 对已存在键保留原插入顺序），
 * 因此覆盖默认 eastmoney 后，未配置 DATA_PROVIDERS 时的默认源也随之改变。
 * @throws id 为空或缺少必需方法时抛出（尽早暴露装配错误，而不是取数时才炸）
 */
export function registerProvider(provider: DataProvider): void {
  const id = typeof provider?.id === 'string' ? provider.id.trim().toLowerCase() : '';
  if (!id) {
    throw new Error('数据源 provider 的 id 不能为空');
  }
  if (typeof provider.resolveSecid !== 'function' || typeof provider.fetchKline !== 'function') {
    throw new Error(`数据源 provider「${id}」缺少必需方法 resolveSecid/fetchKline`);
  }
  providers.set(id, provider);
  // 注册表变了：同一条 DATA_PROVIDERS 里的未知 id 可能已经变为已知，允许重新提示
  lastUnknownWarningSignature = null;
}

/**
 * 取 provider。
 * - 传 id：按 id 精确查找（大小写不敏感）；未知 id 记 warning 并回落默认；
 * - 不传 id：按 DATA_PROVIDERS 顺序取第一个已注册项；未配置 / 全部未知时回落默认。
 */
export function getProvider(id?: string): DataProvider {
  if (id !== undefined) {
    const key = id.trim().toLowerCase();
    const found = key ? providers.get(key) : undefined;
    if (found) return found;
    const fallback = defaultProvider();
    logger.warn('未注册的数据源 provider，已回落默认', {
      requested: id,
      fallback: fallback.id,
    });
    return fallback;
  }

  const requested = parseProviderIds(process.env.DATA_PROVIDERS);
  if (requested.length === 0) return defaultProvider();

  const unknown: string[] = [];
  let selected: DataProvider | null = null;
  for (const candidate of requested) {
    const provider = providers.get(candidate);
    if (!provider) {
      unknown.push(candidate);
      continue;
    }
    if (!selected) selected = provider;
  }
  warnUnknownProviderIds(process.env.DATA_PROVIDERS ?? '', unknown);
  return selected ?? defaultProvider();
}

/**
 * 列出全部已注册 provider：DATA_PROVIDERS 中列出的（按配置顺序）在前，
 * 其余按注册顺序追加；未知 id 不出现（选择时的 warning 见 getProvider）。
 */
export function listProviders(): DataProvider[] {
  const ordered: DataProvider[] = [];
  const seen = new Set<string>();
  for (const id of parseProviderIds(process.env.DATA_PROVIDERS)) {
    const provider = providers.get(id);
    if (!provider || seen.has(id)) continue;
    seen.add(id);
    ordered.push(provider);
  }
  for (const [id, provider] of providers) {
    if (seen.has(id)) continue;
    ordered.push(provider);
  }
  return ordered;
}

/**
 * 能力是否可用：必须**同时**满足「声明了能力」与「实现了对应方法」。
 * 声明与实现不一致时按不可用处理（调用方据此跳过，而不是调用后 TypeError）。
 */
export function providerSupports(provider: DataProvider, capability: ProviderCapability): boolean {
  if (provider.capabilities?.[capability] !== true) return false;
  if (capability === 'kline') return typeof provider.fetchKline === 'function';
  if (capability === 'quote') return typeof provider.fetchQuote === 'function';
  return typeof provider.fetchFinancial === 'function';
}
