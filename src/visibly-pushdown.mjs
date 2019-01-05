import { nil, alt, seq, repeat, token as tok, lit, drop, not, wrappedWith, peek, sepBy, left, right, parse } from './parse-utils.mjs'
import { tokenize } from './token-utils.mjs'
import { MatchParser } from './parse-utils.mjs'

class MismatchedOperatorExpressionError extends Error {}
class UnknownRuleError extends Error {}
class ScopeNotDefinedError extends Error {}
class WrapCtxError extends Error {
  constructor (value, top, bottom) {
    super()
    this.message = `"${value}" cannot be used as both ${top} and ${bottom}`
  }
}

const id = (x) => x
const list = (...xs) => xs
const valueOf = (x) => x.value
const seqi = (...xs) => seq(id, ...xs)
const dlit = (x) => drop(lit(x))
const token = (type) => seq(valueOf, tok(type))
const tag = (type) => (...values) => [type, ...values]
const asLeftFn = (fn) => (...xs) => (acc) => fn(acc, ...xs)
const asRightFn = (fn) => (...xs) => (acc) => fn(...xs, acc)

const line = token('line')
const ignoreLines = drop(alt(line, nil))
const wrapIgnoreLines = (parser) => seqi(ignoreLines, parser, ignoreLines)
const op = (str) => wrapIgnoreLines(dlit(str))

const terminal = alt(
  seq(tag('token'), dlit('%'), token('identifier')),
  seq(tag('literal'), token('string'))
)

const isParser = new MatchParser((x) => x.value && x.value.parse)
const mapFn = seqi(not(isParser), token('function'))

const baseExpr = alt(
  wrappedWith(lit('('), () => expr, lit(')')),
  seq(tag('wrapped'), wrappedWith(
    lit('['), () => seq(list, terminal, sepExpr, terminal, alt(mapFn, nil)), lit(']')
  )),
  seq(tag('identifier'), token('identifier')),
  seq(tag('parser'), isParser),
  terminal,
)
// prefix and postfix operators, mutually exclusive
const opExpr = alt(
  seq(tag('peek'), dlit('&'), baseExpr),
  seq(tag('not'), dlit('!'), baseExpr),
  seq(tag('drop'), dlit('~'), baseExpr),
  seq(tag('repeat0'), baseExpr, dlit('*')),
  seq(tag('repeat1'), baseExpr, dlit('+')),
  seq(tag('maybe'), baseExpr, dlit('?')),
  baseExpr
)
// Expr / "," -> Expr, Expr, Expr ...
const sepExpr = alt(
  seq(tag('sepBy'), opExpr, dlit('/'), opExpr),
  opExpr
)
const seqExpr = seq(
  tag('seq'),
  repeat(sepExpr, 1), alt(seqi(ignoreLines, mapFn), nil)
)

const altExpr = seq(tag('alt'), sepBy(seqExpr, op('|')))
// AddExpr = < . "+" MultExpr >
const infixExpr = alt(
  seq(tag('leftInfix'),
    dlit('<'), dlit('.'), repeat(sepExpr, 1), dlit('>'), mapFn),
  seq(tag('rightInfix'),
    dlit('<'), repeat(sepExpr, 1), dlit('.'), dlit('>'), mapFn),
)
const expr = alt(
  seq(
    tag('altInfix'),
    sepBy(infixExpr, op('|')),
    drop(op('|')), altExpr,
  ),
  altExpr
)
const ruleHead = seqi(token('identifier'), dlit('='))
const rule = seq(tag('rule'), ruleHead, expr)
const notRuleHead = seqi(not(ruleHead), expr)
const program = seq(tag('program'),
  ignoreLines,
  alt(notRuleHead, nil),
  ignoreLines,
  alt(sepBy(rule, line), nil),
  ignoreLines
)

const compileTerminal = (parser) => (value, ctx, wrapCtx = 'contentToken') => {
  if (ctx.usedTerminals[value] &&
    ctx.usedTerminals[value] !== wrapCtx) {
    throw new WrapCtxError(value, wrapCtx, ctx.usedTerminals[value])
  }
  ctx.usedTerminals[value] = wrapCtx
  return parser(value)
}

const compiler = createCompiler({
  program: (expr, rules = [], ctx) => {
    ctx.scope = {}
    ctx.usedTerminals = {}
    // iterate through rules bottom-to-top
    for (let i = rules.length - 1; i >= 0; i--) {
      ctx.eval(rules[i])
    }
    if (expr) { return wrapIgnoreLines(ctx.eval(expr)) }
    if (!rules.length) { return seqi(ignoreLines) }

    const firstRuleID = rules[0][1]
    return wrapIgnoreLines(ctx.scope[firstRuleID])
  },
  rule: (name, rule, ctx) => {
    ctx.scope[name] = ctx.eval(rule)
  },
  altInfix: (ts, base, ctx) => {
    base = ctx.eval(base)
    const hTag = ts[0][0]
    const asInfixFn = hTag === 'leftInfix' ? asLeftFn : asRightFn

    const seqs = []
    for (const [tTag, tSeq, tFn] of ts) {
      if (tTag !== hTag) { throw new MismatchedOperatorExpressionError(tag) }
      seqs.push(seq(asInfixFn(tFn), ignoreLines, ...tSeq.map(ctx.eval)))
    }
    if (hTag === 'leftInfix') {
      return seq(
        (init, fns) => fns.reduce((acc, fn) => fn(acc), init),
        base, repeat(alt(...seqs), 0)
      )
    } else {
      return seq(
        (fns, init) => fns.reduceRight((acc, fn) => fn(acc), init),
        repeat(alt(...seqs), 0), base
      )
    }
  },
  leftInfix: (xs, fn, ctx, base) =>
    left(fn, ctx.eval(base), ...xs.map(ctx.eval)),
  rightInfix: (xs, fn, ctx, base) =>
    right((p) => alt(seq(fn, ...xs.map(ctx.eval), p), ctx.eval(base))),
  alt: (xs, ctx) => alt(...xs.map(ctx.eval)),
  seq: (exprs, fn = id, ctx) => seq(fn, ...exprs.map(ctx.eval)),
  sepBy: (expr, sep, ctx) => {
    sep = ctx.eval(sep)
    return alt(
      sepBy(
        ctx.eval(expr),
        seqi(alt(sep, seqi(ignoreLines, sep)), ignoreLines)
      ),
      nil)
  },
  peek: (expr, ctx) => peek(ctx.eval(expr)),
  not: (expr, ctx) => not(ctx.eval(expr)),
  drop: (expr, ctx) => drop(ctx.eval(expr)),
  repeat0: (expr, ctx) => repeat(ctx.eval(expr), 0),
  repeat1: (expr, ctx) => repeat(ctx.eval(expr), 1),
  maybe: (expr, ctx) => alt(ctx.eval(expr), nil),
  wrapped: ([start, content, end], ctx) =>
    wrappedWith(
      ctx.evalWith('startToken')(start),
      () => wrapIgnoreLines(ctx.eval(content)),
      ctx.evalWith('endToken')(end)
    ),
  identifier: (name, ctx) => {
    if (!ctx.scope) { throw new ScopeNotDefinedError(name) }
    const rule = ctx.scope[name]
    if (!rule) {
      throw new UnknownRuleError(name)
    }
    return rule
  },
  parser: (parser) => parser.value,
  token: compileTerminal(token),
  literal: compileTerminal(lit),
})

function createCompiler (model) {
  return (ast) => {
    const ctx = {
      eval: ([type, ...payload]) =>
        model[type](...payload, ctx),
      evalWith: (...extra) =>
        ([type, ...payload]) =>
          model[type](...payload, ctx, ...extra),
    }
    return ctx.eval(ast)
  }
}

const rootParser = seq(compiler, program)

export function lang (strings, ...interpolations) {
  const tokens = Array.from(tokenize(strings, interpolations))
  const childParser = parse(rootParser, tokens)
  const childTTS = (strings, ...interpolations) => {
    const tokens = Array.from(tokenize(strings, interpolations))
    return parse(childParser, tokens)
  }
  childTTS.parse = (subject) => childParser.parse(subject)
  return childTTS
}

export function test_lang_nil_language (expect) {
  const nil = lang``
  expect(nil`
  `).toEqual(undefined)
}

export function test_lang_single_expression (expect) {
  const num = lang`~"(" %number ")" ${id}`
  expect(num`(123)`).toEqual(123)
}

export function test_lang_recursive_rules (expect) {
  const math = lang`
    Neg   = ~"-" Expr ${(value) => -value}
          | Expr
    Expr  = ["(" Neg ")" ${(_, x) => x}]
          | %number
  `
  expect(math`123`).toEqual(123)
  expect(math`-123`).toEqual(-123)
  expect(math`(123)`).toEqual(123)
  expect(math`-(-(123))`).toEqual(123)
}

export function test_lang_recursive_rule_errors (expect) {
  expect(() => { lang`Rule = ["( %number "("]` }).toThrow()
  expect(() => {
    lang`
      Root = ["( Value ")"]
      Value = "("
    `
  }).toThrow()
}

export function test_lang_repeaters (expect) {
  const list = lang`
    Expr  = ["(" Expr* ")"]
          | %identifier
  `
  expect(list`(foo bar (baz quux) xyzzy)`)
    .toEqual(['foo', 'bar', ['baz', 'quux'], 'xyzzy'])

  const nonEmptyList = lang`
    Expr  = ["(" Expr+ ")"]
          | %identifier
  `
  expect(nonEmptyList`(foo bar (baz quux) xyzzy)`)
    .toEqual(['foo', 'bar', ['baz', 'quux'], 'xyzzy'])
  expect(() => nonEmptyList`()`).toThrow()
}

export function test_lang_operator_precedence_assoc (expect) {
  const math = lang`
    AddExpr = < . ~"+" MulExpr >  ${(l, r) => l + r}
            | < . ~"-" MulExpr >  ${(l, r) => l - r}
            | MulExpr
    MulExpr = < . ~"*" PowNeg >   ${(l, r) => l * r}
            | < . ~"/" PowNeg >   ${(l, r) => l / r}
            | PowNeg
    PowNeg  = NegExpr 
            | PowExpr
    NegExpr = ~"-" Expr           ${(x) => -x}
    PowExpr = < Expr ~"**" . >    ${(l, r) => l ** r}
            | Expr
    Expr    = ["(" AddExpr ")"] 
            | %number
  `
  expect(math`3 / 4 / 5`).toEqual((3 / 4) / 5)
  expect(math`3/ (4 / 5)`).toEqual(3 / (4 / 5))
  expect(math`1 
    + 2 
    * 3 
    - 4`).toEqual(1 + (2 * 3) - 4)
  expect(math`2 ** 3 ** 2`).toEqual(2 ** (3 ** 2))
}

export function test_lookahead (expect) {
  const optionalSemis = lang`(!";" ("+" | "*") ${(x) => x.value})+ ";"? ${(xs) => xs}`
  expect(optionalSemis`+ *`).toEqual(['+', '*'])
  expect(optionalSemis`+ * ;`).toEqual(['+', '*'])
}

export function test_lang_maybe (expect) {
  const trailingCommas = lang`%number ~"," %number ","? ${(a, b) => [a, b]}`
  expect(trailingCommas`1, 2`).toEqual([1, 2])
  expect(trailingCommas`1, 2,`).toEqual([1, 2])
}

export function test_lang_with_line_separators (expect) {
  const lines = lang`%number+ / %line`
  const text = lines`
    1 2 
  
    3 4
  `
  expect(text).toEqual([[1, 2], [3, 4]])
}

export function test_interpolated_parser (expect) {
  const num = lang`%number`
  const list = lang`${num}+`
  expect(list`1 2 3`).toEqual([1, 2, 3])
}
