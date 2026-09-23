/* Angular source analysis on the real TypeScript AST: environment literals, reads of
   `environment.x`, whether each read runs before bootstrap, rewrites and provider wiring. */
import * as path from "path";
import * as ts from "typescript";
import { exists, readText } from "../../core/files";

export class Unparsed {
  constructor(public raw: string) {
    this.raw = raw.replace(/\s+/g, " ").trim();
  }
}
export type Val = string | number | boolean | null | Val[] | { [k: string]: Val } | Unparsed;
export type Obj = { [k: string]: Val };

const parse = (file: string, text: string) =>
  ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

function unwrap(e: ts.Expression): ts.Expression {
  while (ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isParenthesizedExpression(e) || ts.isTypeAssertionExpression(e))
    e = e.expression;
  return e;
}

function literal(e: ts.Expression, sf: ts.SourceFile): Val {
  e = unwrap(e);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  if (ts.isNumericLiteral(e)) return Number(e.text);
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(e.operand)) return -Number(e.operand.text);
  if (e.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (e.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (e.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e) && e.text === "undefined")) return null;
  if (ts.isArrayLiteralExpression(e)) return e.elements.map((x) => (ts.isSpreadElement(x) ? new Unparsed(x.getText(sf)) : literal(x, sf)));
  if (ts.isObjectLiteralExpression(e)) return objectLiteral(e, sf);
  return new Unparsed(e.getText(sf));
}

function propName(n: ts.PropertyName): string | null {
  if (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  return null;
}

function objectLiteral(o: ts.ObjectLiteralExpression, sf: ts.SourceFile): Obj {
  const out: Obj = {};
  for (const p of o.properties) {
    if (ts.isPropertyAssignment(p)) {
      const k = propName(p.name);
      if (k !== null) out[k] = literal(p.initializer, sf);
    } else if (ts.isShorthandPropertyAssignment(p)) {
      out[p.name.text] = new Unparsed(p.name.text);
    } else if (ts.isMethodDeclaration(p) || ts.isGetAccessorDeclaration(p)) {
      const k = propName(p.name);
      if (k !== null) out[k] = new Unparsed(p.getText(sf));
    }
  }
  return out;
}

/** The exported object literal of an environment file: [export name, object] or [null, null]. */
export function parseEnvironmentFile(file: string): [string | null, Obj | null] {
  const sf = parse(file, readText(file));
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st) || !st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    for (const d of st.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.initializer) {
        const init = unwrap(d.initializer);
        if (ts.isObjectLiteralExpression(init)) return [d.name.text, objectLiteral(init, sf)];
      }
    }
  }
  return [null, null];
}

export const containsUnparsed = (v: Val): boolean =>
  v instanceof Unparsed || (Array.isArray(v) ? v.some(containsUnparsed) : v !== null && typeof v === "object" && Object.values(v).some(containsUnparsed));

export const isPlainObj = (v: Val): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Unparsed);

export function showValue(v: Val, limit = 48, ell = "…"): string {
  const t = v instanceof Unparsed ? `<${v.raw}>` : JSON.stringify(v);
  return t.length <= limit ? t : t.slice(0, limit - 1) + ell;
}

export function tsKey(k: string) {
  return /^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k);
}

export function tsType(v: Val, indent = "  "): string {
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number") return "number";
  if (typeof v === "string") return "string";
  if (v === null || v instanceof Unparsed) return "unknown";
  if (Array.isArray(v)) {
    const kinds = new Set(v.map((x) => tsType(x, indent)));
    return kinds.size === 1 ? `${[...kinds][0]}[]` : "unknown[]";
  }
  const entries = Object.entries(v);
  if (!entries.length) return "Record<string, unknown>";
  const inner = indent + "  ";
  return "{\n" + entries.map(([k, x]) => `${inner}${tsKey(k)}: ${tsType(x, inner)};`).join("\n") + "\n" + indent + "}";
}

export const flatJoin = (parts: string[]) => parts[0] + parts.slice(1).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");

export function flatten(obj: Obj, prefix: string[] = []): [string[], Val][] {
  const out: [string[], Val][] = [];
  for (const [k, v] of Object.entries(obj)) {
    const p = [...prefix, k];
    if (isPlainObj(v) && Object.keys(v).length) out.push(...flatten(v, p));
    else out.push([p, v]);
  }
  return out;
}

// ---- imports -------------------------------------------------------------------------
export function isEnvModule(spec: string) {
  const last = spec.replace(/\/+$/, "").split("/").pop() ?? "";
  return /^environment(\.[\w-]+)?$/.test(last);
}

function envImports(sf: ts.SourceFile): { decl: ts.ImportDeclaration; locals: string[] }[] {
  const res: { decl: ts.ImportDeclaration; locals: string[] }[] = [];
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !isEnvModule(st.moduleSpecifier.text)) continue;
    const nb = st.importClause?.namedBindings;
    const locals: string[] = [];
    if (nb && ts.isNamedImports(nb))
      for (const el of nb.elements) if ((el.propertyName ?? el.name).text === "environment" && !el.isTypeOnly) locals.push(el.name.text);
    if (locals.length) res.push({ decl: st, locals });
  }
  return res;
}

export function tsRelImport(fromFile: string, target: string) {
  const r = path.relative(path.dirname(fromFile), target.replace(/\.ts$/, "")).split(path.sep).join("/");
  return r.startsWith(".") ? r : "./" + r;
}

function insertImport(text: string, file: string, line: string): string {
  const sf = parse(file, text);
  const imports = sf.statements.filter(ts.isImportDeclaration);
  const pos = imports.length ? imports[imports.length - 1].getEnd() : 0;
  return pos ? text.slice(0, pos) + "\n" + line + text.slice(pos) : line + "\n" + text;
}

// ---- reads of environment.x -----------------------------------------------------------
export type Reason = "eager" | "bootstrap" | "whole" | "flat-parent" | "unknown" | "spec";
export interface Usage {
  file: string; // repo-relative
  line: number;
  code: string;
  key: string;
  status: "build-time" | "manual" | "rewritable" | "rewritten" | "to-rewrite";
  reason?: Reason;
}
export type Edit = [start: number, end: number, text: string];

/** 'deferred' when the code only runs when a function/method/constructor runs (after bootstrap). */
export function timing(node: ts.Node): "eager" | "deferred" {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isFunctionLike(n) && !ts.isConstructorTypeNode(n) && !ts.isFunctionTypeNode(n)) return "deferred";
    if (ts.isClassStaticBlockDeclaration(n) || ts.isDecorator(n)) return "eager";
    if (ts.isPropertyDeclaration(n)) {
      return n.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) ? "eager" : "deferred";
    }
  }
  return "eager";
}

function isReference(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
  if ((ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p) || ts.isPropertySignature(p)
    || ts.isGetAccessor(p) || ts.isSetAccessor(p) || ts.isEnumMember(p)) && p.name === id) return false;
  if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isExportSpecifier(p) || ts.isQualifiedName(p) && p.right === id) return false;
  if (ts.isVariableDeclaration(p) && p.name === id) return false;
  if (ts.isParameter(p) && p.name === id) return false;
  if (ts.isBindingElement(p) && (p.name === id || p.propertyName === id)) return false;
  if (ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) return false;
  return true;
}

export interface ScanInput {
  repo: string;
  files: string[];
  moved: Set<string>;
  kept: Set<string>;
  flatMap: Map<string, string> | null; // dotted source path -> flattened key (flatten mode)
  flattenedParents: Set<string>;
  bootstrapFiles: Set<string>;
}

export function scanUsages(inp: ScanInput): { usages: Usage[]; edits: Map<string, Edit[]> } {
  const usages: Usage[] = [];
  const edits = new Map<string, Edit[]>();
  for (const file of inp.files) {
    const text = readText(file);
    if (!/\benvironment\b/.test(text)) continue;
    const sf = parse(file, text);
    const imps = envImports(sf);
    if (!imps.length) continue;
    const locals = new Set(imps.flatMap((i) => i.locals));
    const isSpec = /\.spec\.tsx?$/.test(file);
    const relFile = path.relative(inp.repo, file).split(path.sep).join("/");

    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node)) return;
      if (ts.isIdentifier(node) && locals.has(node.text) && isReference(node)) {
        const lc = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        const lineText = text.split(/\r?\n/)[lc.line]?.trim() ?? "";
        // walk up the member chain: environment.a.b?.c
        const chain: ts.PropertyAccessExpression[] = [];
        let cur: ts.Node = node;
        while (ts.isPropertyAccessExpression(cur.parent) && cur.parent.expression === cur && ts.isIdentifier(cur.parent.name)) {
          chain.push(cur.parent);
          cur = cur.parent;
        }
        const segs = chain.map((c) => c.name.text);
        const u: Usage = { file: relFile, line: lc.line + 1, code: lineText, key: segs.join(".") || node.text, status: "manual" };
        usages.push(u);
        if (!segs.length) {
          u.reason = "whole";
        } else if (inp.kept.has(segs[0])) {
          u.status = "build-time";
        } else {
          let edit: Edit | null = null;
          if (inp.flatMap) {
            for (let k = segs.length; k >= 1; k--) {
              const flat = inp.flatMap.get(segs.slice(0, k).join("."));
              if (flat !== undefined) {
                const target = chain[k - 1];
                const sep = target.questionDotToken ? "?." : ".";
                edit = [node.getStart(sf), target.getEnd(), `runtimeConfig()${sep}${flat}`];
                break;
              }
            }
            if (!edit) u.reason = inp.flattenedParents.has(segs[0]) ? "flat-parent" : "unknown";
          } else if (inp.moved.has(segs[0])) {
            edit = [node.getStart(sf), node.getEnd(), "runtimeConfig()"];
          } else {
            u.reason = "unknown";
          }
          if (edit) {
            if (isSpec) u.reason = "spec";
            else if (inp.bootstrapFiles.has(file)) u.reason = "bootstrap";
            else if (timing(node) === "eager") u.reason = "eager";
            else {
              u.status = "rewritable";
              if (!edits.has(file)) edits.set(file, []);
              edits.get(file)!.push(edit);
            }
          }
        }
        // don't descend into the chain we just handled
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { usages, edits };
}

/** Apply edits, drop the environment import if unused, add the runtimeConfig import. */
export function applyRewrites(text: string, edits: Edit[], serviceFile: string, file: string): string {
  for (const [a, b, r] of [...edits].sort((x, y) => y[0] - x[0])) text = text.slice(0, a) + r + text.slice(b);
  let sf = parse(file, text);
  for (const { decl, locals } of envImports(sf).reverse()) {
    const stillUsed = new Set<string>();
    const visit = (n: ts.Node) => {
      if (ts.isImportDeclaration(n)) return;
      if (ts.isIdentifier(n) && locals.includes(n.text) && isReference(n)) stillUsed.add(n.text);
      ts.forEachChild(n, visit);
    };
    visit(sf);
    const clause = decl.importClause!;
    const named = clause.namedBindings as ts.NamedImports;
    const keep = named.elements.filter((el) => !(locals.includes(el.name.text) && !stillUsed.has(el.name.text)));
    if (keep.length === named.elements.length) continue;
    if (!keep.length && !clause.name) {
      let end = decl.getEnd();
      if (text[end] === "\r") end++;
      if (text[end] === "\n") end++;
      text = text.slice(0, decl.getStart(sf)) + text.slice(end);
    } else {
      const specs = keep.map((el) => el.getText(sf)).join(", ");
      text = text.slice(0, named.getStart(sf)) + (specs ? `{ ${specs} }` : "{}") + text.slice(named.getEnd());
    }
    sf = parse(file, text);
  }
  if (!/\bimport\s*\{[^}]*\bruntimeConfig\b/.test(text))
    text = insertImport(text, file, `import { runtimeConfig } from '${tsRelImport(file, serviceFile)}';`);
  return text;
}

// ---- bootstrap wiring -------------------------------------------------------------------
export interface BootstrapTarget {
  target: string | null;
  kind: "standalone" | "ngmodule" | null;
  main: string | null;
}

function resolveImport(fromFile: string, sf: ts.SourceFile, ident: string): string | null {
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const nb = st.importClause?.namedBindings;
    const names = nb && ts.isNamedImports(nb) ? nb.elements.map((e) => e.name.text) : [];
    if (st.importClause?.name?.text === ident || names.includes(ident)) {
      const mod = st.moduleSpecifier.text;
      if (!mod.startsWith(".")) return null;
      const base = path.resolve(path.dirname(fromFile), mod);
      for (const c of [base + ".ts", path.join(base, "index.ts"), base]) if (exists(c) && c.endsWith(".ts")) return c;
    }
  }
  return null;
}

export function findBootstrapTarget(main: string | null): BootstrapTarget {
  if (!main || !exists(main)) return { target: null, kind: null, main: null };
  const sf = parse(main, readText(main));
  let res: BootstrapTarget = { target: null, kind: null, main };
  const visit = (n: ts.Node) => {
    if (res.kind) return;
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
      if (name === "bootstrapApplication") {
        const cfg = n.arguments[1] ? unwrap(n.arguments[1]) : undefined;
        if (cfg && ts.isIdentifier(cfg)) res = { target: resolveImport(main, sf, cfg.text) ?? (localDecl(sf, cfg.text) ? main : null), kind: "standalone", main };
        else res = { target: main, kind: "standalone", main };
      } else if (name === "bootstrapModule" && n.arguments[0] && ts.isIdentifier(n.arguments[0])) {
        const id = (n.arguments[0] as ts.Identifier).text;
        res = { target: resolveImport(main, sf, id) ?? (localDecl(sf, id) ? main : null), kind: "ngmodule", main };
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return res;
}

function localDecl(sf: ts.SourceFile, ident: string) {
  return sf.statements.some((st) =>
    (ts.isClassDeclaration(st) && st.name?.text === ident) ||
    (ts.isVariableStatement(st) && st.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === ident)));
}

/** Insert provideRuntimeConfig() into the first `providers: [...]` array. */
export function planProviderEdit(target: string, serviceFile: string, comment: string): [string, "edited" | "present" | "no-providers"] {
  const text = readText(target);
  if (text.includes("provideRuntimeConfig")) return [text, "present"];
  const sf = parse(target, text);
  let arr: ts.ArrayLiteralExpression | null = null;
  const visit = (n: ts.Node) => {
    if (arr) return;
    if (ts.isPropertyAssignment(n) && propName(n.name) === "providers") {
      const init = unwrap(n.initializer);
      if (ts.isArrayLiteralExpression(init)) { arr = init; return; }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (!arr) return [text, "no-providers"];
  const a = arr as ts.ArrayLiteralExpression;
  const open = a.getStart(sf) + 1; // just after '['
  const entry = "provideRuntimeConfig()";
  let out: string;
  if (!a.elements.length) {
    out = text.slice(0, open) + entry + text.slice(open);
  } else {
    const first = a.elements[0].getStart(sf);
    const between = text.slice(open, first);
    if (between.includes("\n")) {
      const indent = between.slice(between.lastIndexOf("\n") + 1);
      out = text.slice(0, open) + "\n" + indent + `${entry}, // ${comment}` + text.slice(open);
    } else {
      const lineStart = text.lastIndexOf("\n", a.getStart(sf)) + 1;
      const baseIndent = /^[ \t]*/.exec(text.slice(lineStart))![0];
      const indent = baseIndent + "  ";
      out = text.slice(0, open) + "\n" + indent + `${entry}, // ${comment}\n` + indent + text.slice(first);
    }
  }
  out = insertImport(out, target, `import { provideRuntimeConfig } from '${tsRelImport(target, serviceFile)}';`);
  return [out, "edited"];
}

/** Code (not ours) that already fetches a config JSON at runtime. */
export function findConfigLoaders(files: string[], repo: string, ownPrefix: string): string[] {
  const hits: string[] = [];
  const re = /['"`][^'"`]*config[\w.-]*\.json['"`]/i;
  for (const f of files) {
    if (path.basename(f).startsWith(ownPrefix)) continue;
    const text = readText(f);
    if (!re.test(text) || !/\b(fetch|get|http|HttpClient)\b/.test(text)) continue;
    text.split(/\r?\n/).forEach((l, i) => {
      if (re.test(l)) hits.push(`${path.relative(repo, f).split(path.sep).join("/")}:${i + 1}: ${l.trim().slice(0, 80)}`);
    });
  }
  return hits;
}
