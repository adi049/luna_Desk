/**
 * A restricted arithmetic parser.
 *
 * Deliberately NOT eval / new Function: user input is tokenised and parsed by
 * hand so nothing but numbers and the four operators can ever execute.
 *
 * Supports: + − × ÷, parentheses, decimals, unary minus, and contextual
 * percentages the way a desk calculator behaves: `200 + 10%` → 220.
 */
type Token = { type: 'number'; value: number } | { type: 'op'; value: string };

export class CalcError extends Error {}

const OPERATORS = new Set(['+', '-', '*', '/', '%', '(', ')']);

function tokenise(input: string): Token[] {
  const src = input
    .replace(/×/g, '*')
    .replace(/÷/g, '/')
    .replace(/−/g, '-')
    .replace(/,(?=\d{3}\b)/g, '')
    .replace(/\s+/g, '');
  if (!src) throw new CalcError('Nothing to calculate');
  if (!/^[0-9+\-*/%().]+$/.test(src)) throw new CalcError('Only numbers and + − × ÷ ( ) % are allowed');
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/[0-9.]/.test(ch)) {
      let num = '';
      while (i < src.length && /[0-9.]/.test(src[i])) num += src[i++];
      if ((num.match(/\./g) ?? []).length > 1) throw new CalcError('Malformed number');
      const value = Number(num);
      if (!Number.isFinite(value)) throw new CalcError('Malformed number');
      tokens.push({ type: 'number', value });
      continue;
    }
    if (OPERATORS.has(ch)) {
      tokens.push({ type: 'op', value: ch });
      i += 1;
      continue;
    }
    throw new CalcError(`Unexpected character “${ch}”`);
  }
  return tokens;
}

interface Term {
  value: number;
  percent: boolean;
}

export function evaluate(expression: string): number {
  const tokens = tokenise(expression);
  let pos = 0;

  const peek = () => tokens[pos];
  const consume = () => tokens[pos++];

  function parseFactor(): Term {
    const token = peek();
    if (!token) throw new CalcError('Incomplete expression');
    if (token.type === 'op' && token.value === '-') {
      consume();
      const inner = parseFactor();
      return { value: -inner.value, percent: inner.percent };
    }
    if (token.type === 'op' && token.value === '+') {
      consume();
      return parseFactor();
    }
    let term: Term;
    if (token.type === 'number') {
      consume();
      term = { value: token.value, percent: false };
    } else if (token.type === 'op' && token.value === '(') {
      consume();
      const value = parseExpr();
      const closing = peek();
      if (!closing || closing.type !== 'op' || closing.value !== ')') throw new CalcError('Missing closing parenthesis');
      consume();
      term = { value, percent: false };
    } else {
      throw new CalcError('Unexpected operator');
    }
    // Postfix percent
    const next = peek();
    if (next && next.type === 'op' && next.value === '%') {
      consume();
      term = { value: term.value, percent: true };
    }
    return term;
  }

  function parseTerm(): Term {
    let left = parseFactor();
    if (left.percent) left = { value: left.value / 100, percent: false };
    for (;;) {
      const token = peek();
      if (!token || token.type !== 'op' || (token.value !== '*' && token.value !== '/')) break;
      consume();
      const rightRaw = parseFactor();
      const right = rightRaw.percent ? rightRaw.value / 100 : rightRaw.value;
      if (token.value === '*') {
        left = { value: left.value * right, percent: false };
      } else {
        if (right === 0) throw new CalcError('Cannot divide by zero');
        left = { value: left.value / right, percent: false };
      }
    }
    return left;
  }

  function parseExpr(): number {
    let acc = parseTerm();
    let value = acc.percent ? acc.value / 100 : acc.value;
    for (;;) {
      const token = peek();
      if (!token || token.type !== 'op' || (token.value !== '+' && token.value !== '-')) break;
      consume();
      const right = parseTerm();
      // Contextual percent: `200 + 10%` adds 10% *of 200*.
      const delta = right.percent ? (value * right.value) / 100 : right.value;
      value = token.value === '+' ? value + delta : value - delta;
    }
    return value;
  }

  const result = parseExpr();
  if (pos < tokens.length) throw new CalcError('Unexpected trailing input');
  if (!Number.isFinite(result)) throw new CalcError('Result is not a finite number');
  return result;
}

/** Trim floating-point noise (0.30000000000000004 → 0.3) for display. */
export function tidy(value: number, precision = 10): number {
  if (!Number.isFinite(value)) return value;
  return Number(value.toFixed(precision));
}

export function formatResult(value: number): string {
  const tidied = tidy(value);
  if (Number.isInteger(tidied)) return tidied.toLocaleString('en-IN');
  const fixed = tidied.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return Number(fixed).toLocaleString('en-IN', { maximumFractionDigits: 6 });
}
