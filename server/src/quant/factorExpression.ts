/**
 * 受限因子表达式（DSL）求值器
 * ------------------------------------------------------------------
 * RD-Agent(Q) 那套「LLM 提假设 → 自动实现 → 回测验证」闭环里，最危险的一环是
 * 直接执行模型生成的代码。这里**不执行任何代码**：只解析一个受限表达式语法——
 * 标识符白名单 + 函数白名单 + 长度/节点数上限，任何越界一律抛错。LLM 只能在
 * 这个语法内提因子假设，越界即拒绝，不存在沙箱逃逸面。
 *
 * 求值语义：表达式在「单只股票的时间序列」上求值，返回逐日数值序列；由调用方
 * 装配成截面观测（date / symbol / value / 远期收益）后交给既有评估器。
 */
import type { OHLCVData } from './types.js';
import type { FinancialData } from '../types.js';

const SERIES_IDENTS = ['open', 'high', 'low', 'close', 'volume', 'ret'] as const;
const SCALAR_IDENTS = ['roe', 'grossMargin', 'netProfitGrowth', 'debtRatio'] as const;
type SeriesIdent = (typeof SERIES_IDENTS)[number];
type ScalarIdent = (typeof SCALAR_IDENTS)[number];

/** 函数白名单：arity 固定，窗口参数仅对窗口函数生效 */
const FUNCTIONS: Record<string, { arity: number; windowed?: boolean }> = {
  mean: { arity: 2, windowed: true },
  std: { arity: 2, windowed: true },
  sum: { arity: 2, windowed: true },
  min: { arity: 2, windowed: true },
  max: { arity: 2, windowed: true },
  delay: { arity: 2, windowed: true },
  corr: { arity: 3, windowed: true },
  abs: { arity: 1 },
  log: { arity: 1 },
  sqrt: { arity: 1 },
};

export type ExprNode =
  | { kind: 'num'; value: number }
  | { kind: 'series'; name: SeriesIdent }
  | { kind: 'scalar'; name: ScalarIdent }
  | { kind: 'call'; name: string; args: ExprNode[] }
  | { kind: 'binary'; op: '+' | '-' | '*' | '/' | '^'; left: ExprNode; right: ExprNode }
  | { kind: 'neg'; arg: ExprNode };

/** 求值上下文：逐日序列 + 每股常数（基本面快照） */
export interface ExpressionContext {
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
  /** 日收益率序列（首日为 0，与窗口函数对齐用） */
  ret: number[];
  roe?: number;
  grossMargin?: number;
  netProfitGrowth?: number;
  debtRatio?: number;
}

export const MAX_EXPRESSION_CHARS = 240;
export const MAX_EXPRESSION_NODES = 120;
export const MAX_WINDOW = 250;

class ParseError extends Error {}

const NUMBER_RE = /^\d+(\.\d+)?([eE][+-]?\d+)?$/;

/** 词法分析：只产出数字、标识符、运算符、括号、逗号 */
function tokenize(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j])) {
        // 指数符号只允许紧跟 e/E 后出现，避免把 "1-2" 切成一个数
        if ((src[j] === '+' || src[j] === '-') && !/[eE]/.test(src[j - 1] ?? '')) break;
        j += 1;
      }
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    if ('+-*/^(),'.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    throw new ParseError(`非法字符：${ch}`);
  }
  return tokens;
}

/** 递归下降解析；nodeCount 用于硬性限制表达式规模 */
function parse(tokens: string[], state: { pos: number; nodes: number }): ExprNode {
  const bump = () => {
    state.nodes += 1;
    if (state.nodes > MAX_EXPRESSION_NODES) throw new ParseError('表达式过于复杂');
  };

  const parsePrimary = (): ExprNode => {
    const tok = tokens[state.pos];
    if (tok === undefined) throw new ParseError('表达式意外结束');
    if (tok === '(') {
      state.pos += 1;
      const inner = parseAddSub();
      if (tokens[state.pos] !== ')') throw new ParseError('缺少右括号');
      state.pos += 1;
      return inner;
    }
    if (tok === '-' || tok === '+') {
      state.pos += 1;
      const arg = parsePrimary();
      bump();
      return tok === '-' ? { kind: 'neg', arg } : arg;
    }
    if (NUMBER_RE.test(tok)) {
      state.pos += 1;
      bump();
      return { kind: 'num', value: Number(tok) };
    }
    if (/^[A-Za-z_]/.test(tok)) {
      state.pos += 1;
      if (tokens[state.pos] === '(') {
        const fn = FUNCTIONS[tok];
        if (!fn) throw new ParseError(`未授权的函数：${tok}`);
        state.pos += 1;
        const args: ExprNode[] = [];
        if (tokens[state.pos] !== ')') {
          for (;;) {
            args.push(parseAddSub());
            if (tokens[state.pos] === ',') {
              state.pos += 1;
              continue;
            }
            break;
          }
        }
        if (tokens[state.pos] !== ')') throw new ParseError('函数参数缺少右括号');
        state.pos += 1;
        if (args.length !== fn.arity) {
          throw new ParseError(`${tok} 需要 ${fn.arity} 个参数，收到 ${args.length} 个`);
        }
        bump();
        return { kind: 'call', name: tok, args };
      }
      bump();
      if ((SERIES_IDENTS as readonly string[]).includes(tok)) {
        return { kind: 'series', name: tok as SeriesIdent };
      }
      if ((SCALAR_IDENTS as readonly string[]).includes(tok)) {
        return { kind: 'scalar', name: tok as ScalarIdent };
      }
      throw new ParseError(`未授权的标识符：${tok}`);
    }
    throw new ParseError(`无法解析的记号：${tok}`);
  };

  const parsePower = (): ExprNode => {
    const base = parsePrimary();
    if (tokens[state.pos] === '^') {
      state.pos += 1;
      const exp = parsePower();
      bump();
      return { kind: 'binary', op: '^', left: base, right: exp };
    }
    return base;
  };

  const parseMulDiv = (): ExprNode => {
    let left = parsePower();
    for (;;) {
      const op = tokens[state.pos];
      if (op !== '*' && op !== '/') return left;
      state.pos += 1;
      const right = parsePower();
      bump();
      left = { kind: 'binary', op: op as '*' | '/', left, right };
    }
  };

  const parseAddSub = (): ExprNode => {
    let left = parseMulDiv();
    for (;;) {
      const op = tokens[state.pos];
      if (op !== '+' && op !== '-') return left;
      state.pos += 1;
      const right = parseMulDiv();
      bump();
      left = { kind: 'binary', op: op as '+' | '-', left, right };
    }
  };

  const node = parseAddSub();
  if (state.pos !== tokens.length) throw new ParseError('表达式尾部存在多余内容');
  return node;
}

/** 解析因子表达式；非法即抛错（调用方转 400） */
export function parseFactorExpression(src: string): ExprNode {
  const trimmed = String(src ?? '').trim();
  if (!trimmed) throw new ParseError('表达式为空');
  if (trimmed.length > MAX_EXPRESSION_CHARS) {
    throw new ParseError(`表达式过长（上限 ${MAX_EXPRESSION_CHARS} 字符）`);
  }
  const tokens = tokenize(trimmed);
  return parse(tokens, { pos: 0, nodes: 0 });
}

/** 由真实 K 线 + 可选财务快照构造求值上下文 */
export function buildExpressionContext(
  bars: OHLCVData[],
  financial?: FinancialData | null,
): ExpressionContext {
  const close = bars.map((b) => b.close);
  const ret = close.map((c, i) => (i === 0 || !(close[i - 1] > 0) ? 0 : c / close[i - 1] - 1));
  const last = <T>(arr: T[] | undefined): T | undefined =>
    arr && arr.length > 0 ? arr[arr.length - 1] : undefined;
  return {
    open: bars.map((b) => b.open),
    high: bars.map((b) => b.high),
    low: bars.map((b) => b.low),
    close,
    volume: bars.map((b) => b.volume),
    ret,
    ...(financial
      ? {
          roe: last(financial.roe),
          grossMargin: last(financial.grossMargin),
          debtRatio: last(financial.debtRatio),
          netProfitGrowth:
            financial.netProfit.length >= 2 && financial.netProfit.at(-2)! > 0
              ? ((financial.netProfit.at(-1)! - financial.netProfit.at(-2)!) /
                  financial.netProfit.at(-2)!) *
                100
              : undefined,
        }
      : {}),
  };
}

function mean(xs: number[]): number {
  let s = 0;
  let n = 0;
  for (const x of xs) {
    if (Number.isFinite(x)) {
      s += x;
      n += 1;
    }
  }
  return n > 0 ? s / n : NaN;
}

function std(xs: number[]): number {
  const m = mean(xs);
  if (!Number.isFinite(m)) return NaN;
  const vs = xs.filter((x) => Number.isFinite(x));
  if (vs.length < 2) return NaN;
  const v = vs.reduce((acc, x) => acc + (x - m) ** 2, 0) / (vs.length - 1);
  return Math.sqrt(v);
}

function corr(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return NaN;
  const ma = mean(a);
  const mb = mean(b);
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    sab += x * y;
    saa += x * x;
    sbb += y * y;
  }
  if (!(saa > 0) || !(sbb > 0)) return NaN;
  return sab / Math.sqrt(saa * sbb);
}

function seriesAt(node: ExprNode, ctx: ExpressionContext, i: number): number {
  switch (node.kind) {
    case 'num':
      return node.value;
    case 'series':
      return ctx[node.name][i] ?? NaN;
    case 'scalar':
      return ctx[node.name] ?? NaN;
    case 'neg': {
      const v = seriesAt(node.arg, ctx, i);
      return Number.isFinite(v) ? -v : NaN;
    }
    case 'binary': {
      const a = seriesAt(node.left, ctx, i);
      const b = seriesAt(node.right, ctx, i);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
      switch (node.op) {
        case '+':
          return a + b;
        case '-':
          return a - b;
        case '*':
          return a * b;
        case '/':
          return Math.abs(b) < 1e-12 ? NaN : a / b;
        case '^':
          return Number.isFinite(a ** b) ? a ** b : NaN;
      }
      return NaN;
    }
    case 'call':
      return callAt(node, ctx, i);
  }
}

function callAt(node: Extract<ExprNode, { kind: 'call' }>, ctx: ExpressionContext, i: number) {
  const spec = FUNCTIONS[node.name];
  if (!spec) return NaN;
  if (spec.windowed) {
    const nRaw = seriesAt(node.args[node.args.length - 1], ctx, i);
    if (!Number.isFinite(nRaw)) return NaN;
    const n = Math.floor(nRaw);
    if (!Number.isFinite(n) || n < 1 || n > MAX_WINDOW) return NaN;
    const target = node.args[0];
    switch (node.name) {
      case 'delay': {
        const j = i - n;
        return j >= 0 ? seriesAt(target, ctx, j) : NaN;
      }
      case 'corr': {
        const other = node.args[1];
        const xs: number[] = [];
        const ys: number[] = [];
        for (let k = i - n + 1; k <= i; k++) {
          if (k < 0) return NaN;
          xs.push(seriesAt(target, ctx, k));
          ys.push(seriesAt(other, ctx, k));
        }
        return corr(xs, ys);
      }
      default: {
        const xs: number[] = [];
        for (let k = i - n + 1; k <= i; k++) {
          if (k < 0) return NaN;
          xs.push(seriesAt(target, ctx, k));
        }
        switch (node.name) {
          case 'mean':
            return mean(xs);
          case 'std':
            return std(xs);
          case 'sum':
            return xs.reduce((a, b) => a + b, 0);
          case 'min':
            return Math.min(...xs);
          case 'max':
            return Math.max(...xs);
        }
        return NaN;
      }
    }
  }
  const v = seriesAt(node.args[0], ctx, i);
  if (!Number.isFinite(v)) return NaN;
  switch (node.name) {
    case 'abs':
      return Math.abs(v);
    case 'log':
      return v > 0 ? Math.log(v) : NaN;
    case 'sqrt':
      return v >= 0 ? Math.sqrt(v) : NaN;
  }
  return NaN;
}

/** 在整段序列上求值，返回与 bars 等长的数值数组（不足/越界处为 NaN） */
export function evaluateFactorSeries(node: ExprNode, ctx: ExpressionContext): number[] {
  const n = ctx.close.length;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const v = seriesAt(node, ctx, i);
    out[i] = Number.isFinite(v) ? v : NaN;
  }
  return out;
}

/** 便捷入口：解析 + 求值一步到位 */
export function evaluateFactorExpression(
  src: string,
  bars: OHLCVData[],
  financial?: FinancialData | null,
): number[] {
  return evaluateFactorSeries(parseFactorExpression(src), buildExpressionContext(bars, financial));
}
