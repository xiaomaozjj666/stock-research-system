/**
 * 兼容层：证券主数据实现已下移到 shared/stockMaster.ts（打破 quant ↔ services 包级循环：
 * quant/screener 需要主数据，而主数据只依赖 dataRoot/utils，属底层共享能力）。
 * services 内既有 import 与本模块的 vi.mock 路径保持不变。
 */
export * from '../shared/stockMaster.js';
