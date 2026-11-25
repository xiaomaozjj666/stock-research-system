/**
 * 数据源 provider 公共入口：契约、注册表与默认 provider 的 barrel。
 * 接入新源只需实现 DataProvider 并调用 registerProvider（见 README「数据源 provider 注册表」）。
 */
export * from './types.js';
export { marketOf } from './markets.js';
export { filterOHLCVByRange } from './ohlcvRange.js';
export { eastmoneyProvider, fetchEastmoneyKline, resolveSecid } from './eastmoney.js';
export {
  DEFAULT_PROVIDER_ID,
  getProvider,
  listProviders,
  providerSupports,
  registerProvider,
  type ProviderCapability,
} from './registry.js';
