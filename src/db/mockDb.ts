import crypto from 'node:crypto';
import {
  getTableColumns,
  getTableName,
  is,
  SQL,
  type Column,
} from 'drizzle-orm';
import { getTableConfig, PgDialect, type PgTable } from 'drizzle-orm/pg-core';

const dialect = new PgDialect();

type Row = Record<string, unknown>;
type RowCtx = Record<string, Row | null>;

interface TableMeta {
  tableName: string;
  columns: Array<{ jsKey: string; sqlName: string; col: Column }>;
  sqlToJs: Map<string, string>;
  uniqueKeySets: string[][];
}

const metaCache = new WeakMap<object, TableMeta>();

function getMeta(table: PgTable): TableMeta {
  const cached = metaCache.get(table);
  if (cached) return cached;

  const tableName = getTableName(table);
  const cols = getTableColumns(table);
  const cfg = getTableConfig(table);
  const sqlToJs = new Map<string, string>();
  const columns: Array<{ jsKey: string; sqlName: string; col: Column }> = [];
  const uniqueKeySets: string[][] = [];

  for (const [jsKey, col] of Object.entries(cols)) {
    sqlToJs.set(col.name, jsKey);
    columns.push({ jsKey, sqlName: col.name, col });
    if (col.isUnique) {
      uniqueKeySets.push([jsKey]);
    }
  }

  for (const idx of cfg.indexes) {
    if (idx.config.unique) {
      const keys = idx.config.columns
        .map((c) => ('name' in c && typeof c.name === 'string' ? sqlToJs.get(c.name) : undefined))
        .filter((k): k is string => Boolean(k));
      if (keys.length > 0) {
        uniqueKeySets.push(keys);
      }
    }
  }

  const meta: TableMeta = { tableName, columns, sqlToJs, uniqueKeySets };
  metaCache.set(table, meta);
  return meta;
}

function cloneDefault(val: unknown): unknown {
  if (Array.isArray(val)) return [...val];
  if (val && typeof val === 'object') return { ...(val as Record<string, unknown>) };
  return val;
}

function applyDefaults(table: PgTable, input: Row): Row {
  const meta = getMeta(table);
  const out: Row = {};
  for (const { jsKey, sqlName, col } of meta.columns) {
    const provided = input[jsKey];
    if (provided !== undefined) {
      out[jsKey] = provided;
    } else if (col.hasDefault) {
      if (sqlName === 'id') {
        out[jsKey] = crypto.randomUUID();
      } else if (is(col.default, SQL)) {
        out[jsKey] = new Date();
      } else if (col.default !== undefined) {
        out[jsKey] = cloneDefault(col.default);
      } else {
        out[jsKey] = null;
      }
    } else {
      out[jsKey] = null;
    }
  }
  return out;
}

type Token =
  | { type: 'ident'; table?: string; column: string }
  | { type: 'param'; index: number }
  | { type: 'string'; value: string }
  | { type: 'number'; value: number }
  | { type: 'op'; value: string }
  | { type: 'kw'; value: string }
  | { type: 'lparen' }
  | { type: 'rparen' }
  | { type: 'comma' };

function tokenizeSql(sqlStr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const len = sqlStr.length;

  while (i < len) {
    const ch = sqlStr[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '(') {
      tokens.push({ type: 'lparen' });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: 'rparen' });
      i++;
      continue;
    }
    if (ch === ',') {
      tokens.push({ type: 'comma' });
      i++;
      continue;
    }
    if (ch === '$') {
      let j = i + 1;
      while (j < len && /\d/.test(sqlStr[j])) j++;
      const num = Number(sqlStr.slice(i + 1, j));
      tokens.push({ type: 'param', index: num - 1 });
      i = j;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      let str = '';
      while (j < len) {
        if (sqlStr[j] === "'" && sqlStr[j + 1] === "'") {
          str += "'";
          j += 2;
        } else if (sqlStr[j] === "'") {
          j++;
          break;
        } else {
          str += sqlStr[j];
          j++;
        }
      }
      tokens.push({ type: 'string', value: str });
      i = j;
      continue;
    }
    if (ch === '"') {
      const readQuoted = () => {
        let j = i + 1;
        while (j < len && sqlStr[j] !== '"') j++;
        const val = sqlStr.slice(i + 1, j);
        i = j + 1;
        return val;
      };
      const first = readQuoted();
      if (sqlStr[i] === '.' && sqlStr[i + 1] === '"') {
        i++; // skip '.'
        const second = readQuoted();
        tokens.push({ type: 'ident', table: first, column: second });
      } else {
        tokens.push({ type: 'ident', column: first });
      }
      continue;
    }
    if (sqlStr.slice(i, i + 2) === '>=' || sqlStr.slice(i, i + 2) === '<=' || sqlStr.slice(i, i + 2) === '!=' || sqlStr.slice(i, i + 2) === '<>') {
      tokens.push({ type: 'op', value: sqlStr.slice(i, i + 2) });
      i += 2;
      continue;
    }
    if (ch === '=' || ch === '>' || ch === '<' || ch === '+' || ch === '-') {
      if (ch === '-' && /\d/.test(sqlStr[i + 1] || '')) {
        let j = i + 1;
        while (j < len && /[\d.]/.test(sqlStr[j])) j++;
        tokens.push({ type: 'number', value: Number(sqlStr.slice(i, j)) });
        i = j;
        continue;
      }
      tokens.push({ type: 'op', value: ch });
      i++;
      continue;
    }
    if (/\d/.test(ch)) {
      let j = i;
      while (j < len && /[\d.]/.test(sqlStr[j])) j++;
      tokens.push({ type: 'number', value: Number(sqlStr.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[a-zA-Z_]/.test(ch)) {
      let j = i;
      while (j < len && /[a-zA-Z0-9_]/.test(sqlStr[j])) j++;
      const word = sqlStr.slice(i, j);
      if (sqlStr[j] === '.') {
        j++;
        let k = j;
        while (k < len && /[a-zA-Z0-9_]/.test(sqlStr[k])) k++;
        const colWord = sqlStr.slice(j, k);
        tokens.push({ type: 'ident', table: word, column: colWord });
        i = k;
        continue;
      }
      tokens.push({ type: 'kw', value: word.toLowerCase() });
      i = j;
      continue;
    }
    i++;
  }
  return tokens;
}

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function resolveIdent(
  tok: Extract<Token, { type: 'ident' }>,
  rowCtx: RowCtx,
  aliasMap?: Map<string, string>
): unknown {
  const jsKey = snakeToCamel(tok.column);
  if (tok.table) {
    const actualTable = aliasMap?.get(tok.table) ?? tok.table;
    const row = rowCtx[actualTable];
    if (!row) return null;
    if (jsKey in row) return row[jsKey];
    if (tok.column in row) return row[tok.column];
    return null;
  }
  for (const row of Object.values(rowCtx)) {
    if (!row) continue;
    if (jsKey in row) return row[jsKey];
    if (tok.column in row) return row[tok.column];
  }
  return null;
}

function toComparable(val: unknown): number | string | boolean | null {
  if (val === undefined || val === null) return null;
  if (val instanceof Date) return val.getTime();
  if (typeof val === 'number' || typeof val === 'boolean') return val;
  return String(val);
}

function equalsVal(a: unknown, b: unknown): boolean {
  const ca = toComparable(a);
  const cb = toComparable(b);
  if (ca === null || cb === null) return ca === cb;
  return ca === cb;
}

function compareVal(a: unknown, b: unknown): number {
  const ca = toComparable(a);
  const cb = toComparable(b);
  if (ca === null && cb === null) return 0;
  if (ca === null) return -1;
  if (cb === null) return 1;
  if (ca < cb) return -1;
  if (ca > cb) return 1;
  return 0;
}

function ilikeMatch(text: unknown, pattern: unknown, caseInsensitive: boolean): boolean {
  if (text === null || text === undefined || pattern === null || pattern === undefined) {
    return false;
  }
  const str = String(text);
  const pat = String(pattern)
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/%/g, '.*')
    .replace(/_/g, '.');
  const re = new RegExp(`^${pat}$`, caseInsensitive ? 'i' : '');
  return re.test(str);
}

type CompiledPredicate = (rowCtx: RowCtx, aliasMap?: Map<string, string>) => boolean;

function compilePredicateSql(sqlStr: string, params: unknown[]): CompiledPredicate {
  const tokens = tokenizeSql(sqlStr);
  if (tokens.length === 0) return () => true;
  let pos = 0;
  const peek = () => tokens[pos];
  const consume = () => tokens[pos++];

  type ValGetter = (rowCtx: RowCtx, aliasMap?: Map<string, string>) => unknown;

  function parseValueExpr(): ValGetter {
    const tok = consume();
    if (!tok) return () => null;
    if (tok.type === 'param') {
      const val = params[tok.index];
      return () => val;
    }
    if (tok.type === 'string' || tok.type === 'number') {
      const val = tok.value;
      return () => val;
    }
    if (tok.type === 'ident') {
      return (rowCtx, aliasMap) => resolveIdent(tok, rowCtx, aliasMap);
    }
    if (tok.type === 'kw') {
      if (tok.value === 'true') return () => true;
      if (tok.value === 'false') return () => false;
      if (tok.value === 'null') return () => null;
      const val = tok.value;
      return () => val;
    }
    return () => null;
  }

  function parseOrExpr(): CompiledPredicate {
    const parts: CompiledPredicate[] = [parseAndExpr()];
    while (peek()?.type === 'kw' && (peek() as { type: 'kw'; value: string }).value === 'or') {
      consume();
      parts.push(parseAndExpr());
    }
    if (parts.length === 1) return parts[0];
    return (ctx, aliasMap) => {
      for (const fn of parts) {
        if (fn(ctx, aliasMap)) return true;
      }
      return false;
    };
  }

  function parseAndExpr(): CompiledPredicate {
    const parts: CompiledPredicate[] = [parseNotExpr()];
    while (peek()?.type === 'kw' && (peek() as { type: 'kw'; value: string }).value === 'and') {
      consume();
      parts.push(parseNotExpr());
    }
    if (parts.length === 1) return parts[0];
    return (ctx, aliasMap) => {
      for (const fn of parts) {
        if (!fn(ctx, aliasMap)) return false;
      }
      return true;
    };
  }

  function parseNotExpr(): CompiledPredicate {
    if (peek()?.type === 'kw' && (peek() as { type: 'kw'; value: string }).value === 'not') {
      consume();
      const inner = parseNotExpr();
      return (ctx, aliasMap) => !inner(ctx, aliasMap);
    }
    return parsePrimaryExpr();
  }

  function parsePrimaryExpr(): CompiledPredicate {
    const tok = peek();
    if (!tok) return () => true;
    if (tok.type === 'lparen') {
      consume();
      const res = parseOrExpr();
      if (peek()?.type === 'rparen') consume();
      return res;
    }

    const leftGetter = parseValueExpr();
    const next = peek();
    if (!next) return (ctx, aliasMap) => Boolean(leftGetter(ctx, aliasMap));

    if (next.type === 'kw' && next.value === 'is') {
      consume();
      let negated = false;
      if (peek()?.type === 'kw' && (peek() as { type: 'kw'; value: string }).value === 'not') {
        consume();
        negated = true;
      }
      if (peek()?.type === 'kw' && (peek() as { type: 'kw'; value: string }).value === 'null') {
        consume();
        return (ctx, aliasMap) => {
          const lv = leftGetter(ctx, aliasMap);
          const isNull = lv === null || lv === undefined;
          return negated ? !isNull : isNull;
        };
      }
      return () => true;
    }

    if (next.type === 'kw' && next.value === 'in') {
      consume();
      if (peek()?.type === 'lparen') consume();
      const staticSet = new Set<number | string | boolean | null>();
      const dynamicGetters: ValGetter[] = [];
      while (peek() && peek()!.type !== 'rparen') {
        if (peek()!.type === 'comma') {
          consume();
          continue;
        }
        const curTok = peek()!;
        const getter = parseValueExpr();
        if (curTok.type === 'param' || curTok.type === 'string' || curTok.type === 'number') {
          staticSet.add(toComparable(getter({})));
        } else {
          dynamicGetters.push(getter);
        }
      }
      if (peek()?.type === 'rparen') consume();
      return (ctx, aliasMap) => {
        const lv = toComparable(leftGetter(ctx, aliasMap));
        if (staticSet.has(lv)) return true;
        for (const dg of dynamicGetters) {
          if (equalsVal(lv, dg(ctx, aliasMap))) return true;
        }
        return false;
      };
    }

    if (next.type === 'kw' && (next.value === 'ilike' || next.value === 'like')) {
      const caseInsensitive = next.value === 'ilike';
      consume();
      const rightGetter = parseValueExpr();
      return (ctx, aliasMap) => ilikeMatch(leftGetter(ctx, aliasMap), rightGetter(ctx, aliasMap), caseInsensitive);
    }

    if (next.type === 'op') {
      const op = next.value;
      consume();
      const rightGetter = parseValueExpr();
      switch (op) {
        case '=':
          return (ctx, aliasMap) => equalsVal(leftGetter(ctx, aliasMap), rightGetter(ctx, aliasMap));
        case '!=':
        case '<>':
          return (ctx, aliasMap) => !equalsVal(leftGetter(ctx, aliasMap), rightGetter(ctx, aliasMap));
        case '>':
          return (ctx, aliasMap) => compareVal(leftGetter(ctx, aliasMap), rightGetter(ctx, aliasMap)) > 0;
        case '>=':
          return (ctx, aliasMap) => compareVal(leftGetter(ctx, aliasMap), rightGetter(ctx, aliasMap)) >= 0;
        case '<':
          return (ctx, aliasMap) => compareVal(leftGetter(ctx, aliasMap), rightGetter(ctx, aliasMap)) < 0;
        case '<=':
          return (ctx, aliasMap) => compareVal(leftGetter(ctx, aliasMap), rightGetter(ctx, aliasMap)) <= 0;
        default:
          return () => false;
      }
    }

    return (ctx, aliasMap) => Boolean(leftGetter(ctx, aliasMap));
  }

  return parseOrExpr();
}

function compilePredicate(expr: SQL): CompiledPredicate {
  const { sql: sqlStr, params } = dialect.sqlToQuery(expr);
  return compilePredicateSql(sqlStr, params);
}

function tryExtractEquiJoinSpec(on: SQL, joinTableName: string): {
  outerTable: string;
  outerIdent: Extract<Token, { type: 'ident' }>;
  joinIdent: Extract<Token, { type: 'ident' }>;
} | null {
  const { sql: sqlStr } = dialect.sqlToQuery(on);
  const tokens = tokenizeSql(sqlStr);
  const stripped =
    tokens.length === 5 && tokens[0].type === 'lparen' && tokens[4].type === 'rparen'
      ? tokens.slice(1, 4)
      : tokens;
  if (
    stripped.length === 3 &&
    stripped[0].type === 'ident' &&
    stripped[1].type === 'op' &&
    stripped[1].value === '=' &&
    stripped[2].type === 'ident' &&
    stripped[0].table &&
    stripped[2].table
  ) {
    if (stripped[0].table === joinTableName && stripped[2].table !== joinTableName) {
      return { outerTable: stripped[2].table, outerIdent: stripped[2], joinIdent: stripped[0] };
    }
    if (stripped[2].table === joinTableName && stripped[0].table !== joinTableName) {
      return { outerTable: stripped[0].table, outerIdent: stripped[0], joinIdent: stripped[2] };
    }
  }
  return null;
}

function evaluatePredicateSql(
  sqlStr: string,
  params: unknown[],
  rowCtx: RowCtx,
  aliasMap?: Map<string, string>
): boolean {
  return compilePredicateSql(sqlStr, params)(rowCtx, aliasMap);
}

function sortContexts(contexts: RowCtx[], orderExprs: Array<SQL | Column>): RowCtx[] {
  if (orderExprs.length === 0) return contexts;
  const parsedSpecs = orderExprs.map((expr) => {
    if (is(expr, SQL)) {
      const { sql: s } = dialect.sqlToQuery(expr);
      const tokens = tokenizeSql(s);
      const ident = tokens.find((t): t is Extract<Token, { type: 'ident' }> => t.type === 'ident');
      const isDesc = tokens.some((t) => t.type === 'kw' && t.value === 'desc');
      return { ident, isDesc };
    }
    const col = expr as Column;
    const tableName = getTableName(col.table);
    return {
      ident: { type: 'ident' as const, table: tableName, column: col.name },
      isDesc: false,
    };
  });

  return [...contexts].sort((a, b) => {
    for (const spec of parsedSpecs) {
      if (!spec.ident) continue;
      const av = resolveIdent(spec.ident, a);
      const bv = resolveIdent(spec.ident, b);
      const cmp = compareVal(av, bv);
      if (cmp !== 0) {
        return spec.isDesc ? -cmp : cmp;
      }
    }
    return 0;
  });
}

function evalSelectSqlExpr(
  sqlExpr: SQL,
  groupRows: RowCtx[],
  stores: Map<string, Row[]>
): unknown {
  const { sql: rawSql, params } = dialect.sqlToQuery(sqlExpr);
  const s = rawSql.trim();

  // Case 1: exists(select 1 from <table> <alias> where ...)
  const existsMatch = s.match(/^exists\s*\(\s*select\s+1\s+from\s+([a-zA-Z0-9_]+)(?:\s+([a-zA-Z0-9_]+))?\s+where\s+([\s\S]+)\)$/i);
  if (existsMatch) {
    const [, tbl, alias, whereClause] = existsMatch;
    const rows = stores.get(tbl) ?? [];
    const outerCtx = groupRows[0] ?? {};
    const aliasMap = new Map<string, string>();
    if (alias) aliasMap.set(alias, tbl);
    return rows.some((r) =>
      evaluatePredicateSql(whereClause, params, { ...outerCtx, [tbl]: r }, aliasMap)
    );
  }

  // Case 2: (select count(*)::int from <table> <alias> where ...)
  const subCountMatch = s.match(/^\(\s*select\s+count\(\*\)(?:::int)?\s+from\s+([a-zA-Z0-9_]+)(?:\s+([a-zA-Z0-9_]+))?\s+where\s+([\s\S]+)\)$/i);
  if (subCountMatch) {
    const [, tbl, alias, whereClause] = subCountMatch;
    const rows = stores.get(tbl) ?? [];
    const outerCtx = groupRows[0] ?? {};
    const aliasMap = new Map<string, string>();
    if (alias) aliasMap.set(alias, tbl);
    return rows.filter((r) =>
      evaluatePredicateSql(whereClause, params, { ...outerCtx, [tbl]: r }, aliasMap)
    ).length;
  }

  // Case 3: count(*) filter (where ...)
  const filterMatch = s.match(/^count\(\*\)\s+filter\s*\(\s*where\s+([\s\S]+)\)(?:::int)?$/i);
  if (filterMatch) {
    const [, whereClause] = filterMatch;
    return groupRows.filter((ctx) => evaluatePredicateSql(whereClause, params, ctx)).length;
  }

  // Case 4: count(distinct ...)
  const distinctMatch = s.match(/^count\(\s*distinct\s+([\s\S]+)\)(?:::int)?$/i);
  if (distinctMatch) {
    const tokens = tokenizeSql(distinctMatch[1]);
    const ident = tokens.find((t): t is Extract<Token, { type: 'ident' }> => t.type === 'ident');
    if (!ident) return groupRows.length;
    const set = new Set<unknown>();
    for (const ctx of groupRows) {
      const val = resolveIdent(ident, ctx);
      if (val !== null && val !== undefined) set.add(val);
    }
    return set.size;
  }

  // Case 5: count(*)::int
  if (/^count\(\*\)(?:::int)?$/i.test(s)) {
    return groupRows.length;
  }

  return null;
}

function isAggregateSelection(fields: Record<string, unknown> | undefined): boolean {
  if (!fields) return false;
  for (const val of Object.values(fields)) {
    if (is(val, SQL)) {
      const { sql: raw } = dialect.sqlToQuery(val);
      const trimmed = raw.trim();
      if (/^count\s*\(/i.test(trimmed)) {
        return true;
      }
    }
  }
  return false;
}

function projectRow(
  fields: Record<string, unknown> | undefined,
  primaryTable: PgTable,
  groupRows: RowCtx[],
  stores: Map<string, Row[]>
): Row {
  const ctx = groupRows[0] ?? {};
  if (!fields) {
    const meta = getMeta(primaryTable);
    const row = ctx[meta.tableName] ?? {};
    return { ...row };
  }

  const out: Row = {};
  for (const [alias, expr] of Object.entries(fields)) {
    if (is(expr, SQL)) {
      out[alias] = evalSelectSqlExpr(expr, groupRows, stores);
    } else if (expr && typeof expr === 'object' && 'name' in expr && 'table' in expr) {
      const col = expr as Column;
      const tblName = getTableName(col.table);
      const meta = getMeta(col.table as PgTable);
      const jsKey = meta.sqlToJs.get(col.name) ?? snakeToCamel(col.name);
      out[alias] = ctx[tblName]?.[jsKey] ?? null;
    } else {
      out[alias] = expr ?? null;
    }
  }
  return out;
}

export function createMockDb() {
  const stores = new Map<string, Row[]>();

  function getTableRows(table: PgTable): Row[] {
    const name = getTableName(table);
    let rows = stores.get(name);
    if (!rows) {
      rows = [];
      stores.set(name, rows);
    }
    return rows;
  }

  function findConflictRow(
    table: PgTable,
    candidate: Row,
    target?: Column | Column[]
  ): Row | undefined {
    const meta = getMeta(table);
    const rows = getTableRows(table);

    if (target) {
      const targetArr = Array.isArray(target) ? target : [target];
      const keys = targetArr.map((c) => meta.sqlToJs.get(c.name) ?? snakeToCamel(c.name));
      return rows.find((existing) =>
        keys.every((k) => existing[k] !== null && existing[k] !== undefined && equalsVal(existing[k], candidate[k]))
      );
    }

    for (const keySet of meta.uniqueKeySets) {
      const match = rows.find((existing) =>
        keySet.every((k) => existing[k] !== null && existing[k] !== undefined && equalsVal(existing[k], candidate[k]))
      );
      if (match) return match;
    }
    return undefined;
  }

  function applyUpdateValues(table: PgTable, existing: Row, setObj: Row): void {
    const meta = getMeta(table);
    for (const [k, v] of Object.entries(setObj)) {
      if (is(v, SQL)) {
        const { sql: rawSql } = dialect.sqlToQuery(v);
        const plusMatch = rawSql.match(/^\s*"[^"]+"\."([^"]+)"\s*\+\s*(\d+)\s*$/);
        if (plusMatch) {
          const jsKey = meta.sqlToJs.get(plusMatch[1]) ?? snakeToCamel(plusMatch[1]);
          existing[k] = Number(existing[jsKey] ?? 0) + Number(plusMatch[2]);
        }
      } else if (v !== undefined) {
        existing[k] = v;
      }
    }
  }

  const mockDb = {
    select(fields?: Record<string, unknown>) {
      let fromTable: PgTable | null = null;
      const joins: Array<{ type: 'inner' | 'left'; table: PgTable; on: SQL }> = [];
      let whereExpr: SQL | undefined;
      let groupCols: Array<Column | SQL> = [];
      let orderExprs: Array<Column | SQL> = [];
      let limitVal: number | undefined;
      let offsetVal: number | undefined;

      const executeSelect = (): Row[] => {
        if (!fromTable) return [];
        const primaryName = getTableName(fromTable);
        let contexts: RowCtx[] = getTableRows(fromTable).map((r) => ({ [primaryName]: r }));

        for (const j of joins) {
          const jName = getTableName(j.table);
          const jRows = getTableRows(j.table);
          const nextContexts: RowCtx[] = [];
          const equiSpec = tryExtractEquiJoinSpec(j.on, jName);
          if (equiSpec) {
            const jBucket = new Map<number | string | boolean, Row[]>();
            for (const jr of jRows) {
              const keyVal = toComparable(resolveIdent(equiSpec.joinIdent, { [jName]: jr }));
              if (keyVal !== null) {
                const arr = jBucket.get(keyVal);
                if (arr) arr.push(jr);
                else jBucket.set(keyVal, [jr]);
              }
            }
            for (const ctx of contexts) {
              const outerVal = toComparable(resolveIdent(equiSpec.outerIdent, ctx));
              const matched = outerVal !== null ? jBucket.get(outerVal) : undefined;
              if (matched && matched.length > 0) {
                for (const jr of matched) {
                  nextContexts.push({ ...ctx, [jName]: jr });
                }
              } else if (j.type === 'left') {
                nextContexts.push({ ...ctx, [jName]: null });
              }
            }
          } else {
            const compiledOn = compilePredicate(j.on);
            for (const ctx of contexts) {
              const matched = jRows.filter((jr) =>
                compiledOn({ ...ctx, [jName]: jr })
              );
              if (matched.length > 0) {
                for (const jr of matched) {
                  nextContexts.push({ ...ctx, [jName]: jr });
                }
              } else if (j.type === 'left') {
                nextContexts.push({ ...ctx, [jName]: null });
              }
            }
          }
          contexts = nextContexts;
        }

        if (whereExpr) {
          const compiledWhere = compilePredicate(whereExpr);
          contexts = contexts.filter((ctx) => compiledWhere(ctx));
        }

        let groups: RowCtx[][];
        if (groupCols.length > 0) {
          const groupMap = new Map<string, RowCtx[]>();
          for (const ctx of contexts) {
            const keyParts = groupCols.map((c) => {
              if (is(c, SQL)) return '';
              const tblName = getTableName(c.table);
              const meta = getMeta(c.table as PgTable);
              const jsKey = meta.sqlToJs.get(c.name) ?? snakeToCamel(c.name);
              return String(ctx[tblName]?.[jsKey] ?? '__null__');
            });
            const key = keyParts.join('||');
            const arr = groupMap.get(key) ?? [];
            arr.push(ctx);
            groupMap.set(key, arr);
          }
          groups = Array.from(groupMap.values());
        } else if (isAggregateSelection(fields)) {
          groups = [contexts];
        } else {
          groups = contexts.map((c) => [c]);
        }

        if (orderExprs.length > 0 && groupCols.length === 0 && !isAggregateSelection(fields)) {
          const sorted = sortContexts(
            groups.map((g) => g[0]),
            orderExprs
          );
          groups = sorted.map((c) => [c]);
        }

        const start = offsetVal ?? 0;
        const end = limitVal !== undefined ? start + limitVal : undefined;
        const sliced = groups.slice(start, end);

        return sliced.map((g) => projectRow(fields, fromTable!, g, stores));
      };

      const builder = {
        from(table: PgTable) {
          fromTable = table;
          return builder;
        },
        innerJoin(table: PgTable, on: SQL) {
          joins.push({ type: 'inner', table, on });
          return builder;
        },
        leftJoin(table: PgTable, on: SQL) {
          joins.push({ type: 'left', table, on });
          return builder;
        },
        where(cond: SQL | undefined) {
          whereExpr = cond;
          return builder;
        },
        groupBy(...cols: Array<Column | SQL>) {
          groupCols = cols;
          return builder;
        },
        orderBy(...cols: Array<Column | SQL>) {
          orderExprs = cols;
          return builder;
        },
        limit(n: number) {
          limitVal = n;
          return builder;
        },
        offset(n: number) {
          offsetVal = n;
          return builder;
        },
        then<TResult1 = Row[], TResult2 = never>(
          onfulfilled?: ((value: Row[]) => TResult1 | PromiseLike<TResult1>) | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
        ) {
          return Promise.resolve().then(executeSelect).then(onfulfilled, onrejected);
        },
      };
      return builder;
    },

    insert(table: PgTable) {
      let inputRows: Row[] = [];
      let conflictMode: 'none' | 'nothing' | 'update' = 'none';
      let conflictTarget: Column | Column[] | undefined;
      let conflictSet: Row | undefined;
      let returnFields: Record<string, unknown> | undefined;
      let hasReturning = false;

      const executeInsert = (): Row[] => {
        const rows = getTableRows(table);
        const resultRows: Row[] = [];

        for (const raw of inputRows) {
          const candidate = applyDefaults(table, raw);
          const existing = findConflictRow(table, candidate, conflictTarget);
          if (existing) {
            if (conflictMode === 'nothing') {
              continue;
            }
            if (conflictMode === 'update' && conflictSet) {
              applyUpdateValues(table, existing, conflictSet);
              resultRows.push(existing);
              continue;
            }
            throw new Error(`Duplicate key violates unique constraint on ${getTableName(table)}`);
          }
          rows.push(candidate);
          resultRows.push(candidate);
        }

        if (!hasReturning) return [];
        const tName = getTableName(table);
        return resultRows.map((r) => projectRow(returnFields, table, [{ [tName]: r }], stores));
      };

      const builder = {
        values(vals: Row | Row[]) {
          inputRows = Array.isArray(vals) ? vals : [vals];
          return builder;
        },
        onConflictDoNothing(cfg?: { target?: Column | Column[] }) {
          conflictMode = 'nothing';
          conflictTarget = cfg?.target;
          return builder;
        },
        onConflictDoUpdate(cfg: { target: Column | Column[]; set: Row }) {
          conflictMode = 'update';
          conflictTarget = cfg.target;
          conflictSet = cfg.set;
          return builder;
        },
        returning(fields?: Record<string, unknown>) {
          hasReturning = true;
          returnFields = fields;
          return builder;
        },
        then<TResult1 = Row[], TResult2 = never>(
          onfulfilled?: ((value: Row[]) => TResult1 | PromiseLike<TResult1>) | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
        ) {
          return Promise.resolve().then(executeInsert).then(onfulfilled, onrejected);
        },
      };
      return builder;
    },

    update(table: PgTable) {
      let setObj: Row = {};
      let whereExpr: SQL | undefined;
      let returnFields: Record<string, unknown> | undefined;
      let hasReturning = false;

      const executeUpdate = (): Row[] => {
        const tName = getTableName(table);
        const rows = getTableRows(table);
        const updated: Row[] = [];
        const compiledWhere = whereExpr ? compilePredicate(whereExpr) : null;
        for (const r of rows) {
          if (!compiledWhere || compiledWhere({ [tName]: r })) {
            applyUpdateValues(table, r, setObj);
            updated.push(r);
          }
        }
        if (!hasReturning) return [];
        return updated.map((r) => projectRow(returnFields, table, [{ [tName]: r }], stores));
      };

      const builder = {
        set(vals: Row) {
          setObj = vals;
          return builder;
        },
        where(cond: SQL | undefined) {
          whereExpr = cond;
          return builder;
        },
        returning(fields?: Record<string, unknown>) {
          hasReturning = true;
          returnFields = fields;
          return builder;
        },
        then<TResult1 = Row[], TResult2 = never>(
          onfulfilled?: ((value: Row[]) => TResult1 | PromiseLike<TResult1>) | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
        ) {
          return Promise.resolve().then(executeUpdate).then(onfulfilled, onrejected);
        },
      };
      return builder;
    },

    delete(table: PgTable) {
      let whereExpr: SQL | undefined;
      let returnFields: Record<string, unknown> | undefined;
      let hasReturning = false;

      const executeDelete = (): Row[] => {
        const tName = getTableName(table);
        const rows = getTableRows(table);
        const kept: Row[] = [];
        const removed: Row[] = [];
        const compiledWhere = whereExpr ? compilePredicate(whereExpr) : null;
        for (const r of rows) {
          if (!compiledWhere || compiledWhere({ [tName]: r })) {
            removed.push(r);
          } else {
            kept.push(r);
          }
        }
        stores.set(tName, kept);
        if (!hasReturning) return [];
        return removed.map((r) => projectRow(returnFields, table, [{ [tName]: r }], stores));
      };

      const builder = {
        where(cond: SQL | undefined) {
          whereExpr = cond;
          return builder;
        },
        returning(fields?: Record<string, unknown>) {
          hasReturning = true;
          returnFields = fields;
          return builder;
        },
        then<TResult1 = Row[], TResult2 = never>(
          onfulfilled?: ((value: Row[]) => TResult1 | PromiseLike<TResult1>) | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
        ) {
          return Promise.resolve().then(executeDelete).then(onfulfilled, onrejected);
        },
      };
      return builder;
    },

    async transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
      return fn(mockDb);
    },

    async execute(_query: unknown): Promise<{ rows: Row[] }> {
      return { rows: [] };
    },
  };

  return mockDb;
}
