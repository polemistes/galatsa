// SPDX-License-Identifier: GPL-3.0-or-later

// Pure logic for the hard-coded text check (scripts/check-i18n.ts): finds text that a
// user would see, written directly in user interface code instead of coming from the
// translation files. Scripts are parsed with the TypeScript compiler, so text in
// comments, type names and imports is never mistaken for user text. HTML pages are
// read with a small tokenizer (findHardcodedHtmlText).
//
// User-visible text is a string (or the literal parts of a template string) that
// contains at least one letter, in one of these places:
//
//   1. JSX text:                         <button>Save</button>
//   2. JSX children in braces:           <p>{busy ? "Saving" : "Saved"}</p>
//      Not inside <style> and <script>, whose content is CSS or code.
//   3. JSX attributes that hold text: the names in TEXT_ATTRIBUTES (alt,
//      aria-label, title, ...), names that hold text by convention (isTextName:
//      text, confirmLabel, emptyText, ...), the children prop, and value on
//      <input type="submit|button|reset">:
//                                        <Button text="Save" confirmLabel="Sure?" />
//   4. Text properties and names (isTextName), in object literals, variable
//      declarations and assignments:     { label: "Save" }, el.textContent = "Save",
//                                        const emptyMessage = "Nothing here"
//   5. Values returned by functions, methods and getters with such a name:
//                                        function statusText() { return "Saved"; }
//   6. Arguments of DOM and browser APIs that show text (TEXT_CALLS):
//                                        alert("Saved"), ctx.fillText("Hi", 0, 0),
//                                        el.setAttribute("title", "Close")
//      and text options of such APIs (TEXT_OPTIONS):
//                                        new Notification(title, { body: "Done" })
//
// A value in one of these places is followed through the file where that is cheap
// and certain: both sides of ?:, &&, ||, ?? and +, array elements, string methods
// such as ["Undo", "Redo"].join(" / "), String(x), a local constant
// (text={label} with const label = "Save"), a property of a local object literal
// (text={names.save} with const names = { save: "Save" }), and the return values of
// a local function (<span>{status()}</span>).
//
// Not user text: strings without letters ("–", "100", "·"), message keys in the
// form "namespace:key" (for example "editor:toolbar.save"), and strings that are
// only a URL or an e-mail address ("https://example.com/x.png").
//
// Names are only a guess. A name that holds text by convention (places 3 to 5 with
// a name like errorMessage, plainText or sortDescription, as opposed to the fixed
// attribute and property names such as title or textContent) often holds a code
// instead: "ENOENT", "text/plain", "ascending". For those names a value that looks
// like a code is not reported (looksLikeCode): one ASCII word without spaces that
// is all lower case, all upper case (three letters or more), camelCase, or
// contains a digit or one of / _ . : + = # @ -. A capitalised word ("Save"), anything
// with a space and anything with letters outside ASCII ("Lagre…", "søk") is still
// text. In the fixed text places (JSX text, title, aria-label, textContent, ...)
// every value with a letter is reported, codes included.
//
// Opting out: a comment `i18n-ignore: <reason>` on the same line or alone on the
// line above skips that line, and `i18n-ignore-file: <reason>` in a comment skips
// the file. The reason is required. Only real comments count, not the same words
// inside a string. In JSX, write the comment as {/* i18n-ignore: ... */}; in HTML as
// <!-- i18n-ignore: ... -->.
//
// The check sees text where it is written, not where it ends up: a string passed
// through a parameter, an import or a variable that is reassigned is not followed.
//
// Svelte components (findHardcodedSvelteText) are parsed with svelte/compiler: text
// in the markup, expressions in the markup and text attributes are text places as
// in JSX, and the <script> blocks and every expression of the markup are checked
// as one TypeScript script with the rules above. Runes that stand for their first
// argument ($state, $derived) are followed like the value itself.

import { parse as parseSvelte } from "svelte/compiler";
import ts from "typescript";

export interface Finding {
  /** 1-based line and column. */
  readonly line: number;
  readonly column: number;
  /** The text found, shortened, or a description of the problem. */
  readonly text: string;
  readonly reason: string;
}

export interface ScanOptions {
  /** More attribute (JSX prop) names whose string value is shown to users. */
  readonly textAttributes?: readonly string[];
  /** More function names whose first argument is shown to users. */
  readonly textCalls?: readonly string[];
}

/** JSX and HTML attributes whose value is shown to users or read by screen readers. */
export const TEXT_ATTRIBUTES: readonly string[] = [
  "alt",
  "aria-braillelabel",
  "aria-brailleroledescription",
  "aria-description",
  "aria-label",
  "aria-placeholder",
  "aria-roledescription",
  "aria-valuetext",
  "caption",
  "description",
  "heading",
  "hint",
  "label",
  "legend",
  "message",
  "placeholder",
  "summary",
  "title",
  "tooltip",
];

/** DOM properties whose value is shown to users. */
const TEXT_PROPERTIES: readonly string[] = [
  "textContent",
  "innerText",
  "innerHTML",
  "outerHTML",
  "nodeValue",
  "ariaLabel",
  "ariaDescription",
  "ariaPlaceholder",
  "ariaRoleDescription",
  "ariaValueText",
];

/**
 * Standard DOM and React props whose names end like a text name but which hold a
 * fixed keyword, not text.
 */
const NOT_TEXT_NAMES: readonly string[] = ["enterKeyHint", "enterkeyhint"];

/** <input> types whose value attribute is the button's visible label. */
const BUTTON_INPUT_TYPES: readonly string[] = ["submit", "button", "reset"];

/**
 * Names that hold user text by convention: label, title, tooltip and so on, and
 * names ending in Label, Title, Text, Message and so on (saveLabel, emptyMessage).
 */
export function isTextName(name: string): boolean {
  return textNameKind(name) !== undefined;
}

/**
 * "fixed" for the attribute and property names that always hold text, "convention"
 * for names that hold text by their ending (saveLabel, emptyMessage), undefined
 * otherwise.
 */
export function textNameKind(name: string): "fixed" | "convention" | undefined {
  if (TEXT_PROPERTIES.includes(name) || TEXT_ATTRIBUTES.includes(name)) return "fixed";
  if (/^(?:text|ariaLabel)$/.test(name)) return "fixed";
  if (NOT_TEXT_NAMES.includes(name)) return undefined;
  return /[a-z0-9](?:Label|Title|Tooltip|Placeholder|Caption|Heading|Description|Message|Text|Hint)$/.test(
    name,
  )
    ? "convention"
    : undefined;
}

/**
 * True if a string looks like a code, a keyword or an identifier rather than
 * words: one ASCII word without spaces that contains a digit or one of
 * / _ . : + = # @ -, or is all lower case, all upper case (three letters or more) or
 * camelCase. "ENOENT", "text/plain", "ascending", "en-US", "fooBar" are codes;
 * "Save", "OK", "Sign-in", "Saved." and "søk" are not.
 */
export function looksLikeCode(text: string): boolean {
  const word = text.trim();
  if (!/^[\x21-\x7e]+$/.test(word) || !/[A-Za-z]/.test(word)) return false;
  if (/^[A-Z][a-z]*(?:-[A-Za-z]+)*[.!?:]?$/.test(word)) return false; // Save, Sign-in, Done.
  if (/[0-9/_.:+=#@-]/.test(word)) return true;
  const letters = word.replace(/[^A-Za-z]/g, "");
  if (letters === letters.toLowerCase()) return true;
  if (letters === letters.toUpperCase()) return letters.length >= 3;
  return /[a-z][A-Z]/.test(word);
}

/** Calls whose arguments are shown to users: function name to argument positions. */
const TEXT_CALLS: ReadonlyMap<string, readonly number[] | "all"> = new Map<
  string,
  readonly number[] | "all"
>([
  ["alert", [0]],
  ["confirm", [0]],
  ["prompt", [0, 1]],
  ["createTextNode", [0]],
  ["fillText", [0]],
  ["strokeText", [0]],
  ["insertAdjacentText", [1]],
  ["showNotification", [0]],
  // DOM methods that insert strings as text nodes. FormData, URLSearchParams and
  // Headers also have an append(name, value); see isNameValueReceiver.
  ["append", "all"],
  ["prepend", "all"],
  ["before", "all"],
  ["after", "all"],
  ["replaceChildren", "all"],
  ["replaceWith", "all"],
]);

/** DOM insertion methods that FormData, URLSearchParams or Headers share by name. */
const SHARED_NAME_CALLS: readonly string[] = ["append"];

/** Types with an append(name, value) that is not text: form fields, query, headers. */
const NAME_VALUE_TYPES: readonly string[] = ["FormData", "URLSearchParams", "Headers"];

/**
 * Receiver names that, by convention, hold a FormData, URLSearchParams or Headers
 * object: form, formData, params, searchParams, query, headers and the like.
 */
const NAME_VALUE_RECEIVER =
  /^(?:fd|form|formData|params|query|headers|body)$|[a-z0-9](?:Form|FormData|Params|Query|Headers|Body)$/;

/** Constructors whose first argument is shown to users. */
const TEXT_CONSTRUCTORS: readonly string[] = ["Notification", "Option"];

/**
 * Calls and constructors with an options object whose properties are shown to
 * users: name to the argument position and the property names.
 */
const TEXT_OPTIONS: ReadonlyMap<string, readonly [number, readonly string[]]> = new Map<
  string,
  readonly [number, readonly string[]]
>([
  ["Notification", [1, ["body"]]],
  ["showNotification", [1, ["body"]]],
]);

/** Svelte runes whose value is their first argument: $state("Save") is "Save". */
const SVELTE_VALUE_RUNES: readonly string[] = ["$state", "$derived"];

/** String methods whose result contains the text of the string they are called on. */
const STRING_METHODS: readonly string[] = [
  "concat",
  "join",
  "padEnd",
  "padStart",
  "repeat",
  "replace",
  "replaceAll",
  "slice",
  "substring",
  "toLocaleLowerCase",
  "toLocaleUpperCase",
  "toLowerCase",
  "toString",
  "toUpperCase",
  "trim",
  "trimEnd",
  "trimStart",
];

const MESSAGE_KEY = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*:[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
/** A string that is only a URL or an e-mail address. */
const URL_ONLY =
  /^(?:[a-z][a-z0-9+.-]*:\/\/\S+|(?:mailto|tel|data|blob):\S+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+)$/i;
const ENTITY = /&(?:[A-Za-z]+|#\d+|#x[0-9A-Fa-f]+);/g;

/** True if the text would be read as words by a user. */
export function isUserText(text: string): boolean {
  const trimmed = text.trim();
  if (MESSAGE_KEY.test(trimmed) || URL_ONLY.test(trimmed)) return false;
  return /\p{L}/u.test(trimmed.replace(ENTITY, " "));
}

const IGNORE_LINE = /i18n-ignore(?!-file)(:\s*\S)?/;
const IGNORE_FILE = /i18n-ignore-file:\s*\S/;
const MISSING_REASON =
  "i18n-ignore needs a reason: write `i18n-ignore: <why this is not text>`";

function scriptKind(fileName: string): ts.ScriptKind {
  if (fileName.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (fileName.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.[mc]?js$/.test(fileName)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function nameOf(
  node: ts.PropertyName | ts.BindingName | ts.MemberName,
): string | undefined {
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return node.text;
  return undefined;
}

function calleeName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

function shorten(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 57)}...` : flat;
}

function jsxAttributeName(name: ts.JsxAttributeName): string {
  return ts.isIdentifier(name) ? name.text : `${name.namespace.text}:${name.name.text}`;
}

/** An i18n-ignore comment: the lines it covers and whether it gives a reason. */
interface IgnoreComment {
  /** 0-based lines the comment starts and ends on. */
  readonly first: number;
  readonly last: number;
  /** True if nothing but the comment (and a JSX "{") is on its first line. */
  readonly alone: boolean;
  readonly hasReason: boolean;
}

/**
 * Applies the i18n-ignore comments of a file to the findings at given positions.
 * A comment covers the line (or lines) it is on and, if it stands alone on its
 * line, the next line.
 */
class Ignores {
  private readonly comments: IgnoreComment[] = [];
  readonly findings: Finding[] = [];
  private readonly seen = new Set<number>();

  private readonly lineOf: (position: number) => [number, number];

  constructor(lineOf: (position: number) => [number, number]) {
    this.lineOf = lineOf;
  }

  addComment(first: number, last: number, alone: boolean, text: string): void {
    const match = IGNORE_LINE.exec(text);
    if (match === null) return;
    this.comments.push({ first, last, alone, hasReason: match[1] !== undefined });
  }

  report(position: number, text: string, reason: string): void {
    if (this.seen.has(position)) return; // reached twice, for example through a constant
    this.seen.add(position);
    const [line, column] = this.lineOf(position);
    const comment = this.comments.find(
      (c) => (line >= c.first && line <= c.last) || (c.alone && line === c.last + 1),
    );
    if (comment?.hasReason === true) return;
    this.findings.push({
      line: line + 1,
      column: column + 1,
      text: shorten(text),
      reason: comment === undefined ? reason : MISSING_REASON,
    });
  }
}

/** Every comment in a parsed file, JSX comments included, once each. */
function commentsOf(file: ts.SourceFile): ts.CommentRange[] {
  const text = file.text;
  const found = new Map<number, ts.CommentRange>();
  const add = (ranges: ts.CommentRange[] | undefined): void => {
    for (const range of ranges ?? []) found.set(range.pos, range);
  };
  // The trivia before a node starts at node.pos. TypeScript calls comments before
  // the first line break there "trailing" and those after it "leading", so both
  // are read.
  const around = (position: number): void => {
    add(ts.getTrailingCommentRanges(text, position));
    add(ts.getLeadingCommentRanges(text, position));
  };
  const visit = (node: ts.Node): void => {
    around(node.pos);
    around(node.end);
    // {/* comment */} in JSX: an expression container with only a comment inside.
    if (ts.isJsxExpression(node) && node.expression === undefined) {
      around(node.getStart(file) + 1);
    }
    ts.forEachChild(node, visit);
  };
  around(0);
  visit(file);
  return [...found.values()];
}

/** Finds hard-coded user-visible text in one user interface file (script, HTML or Svelte). */
export function findHardcodedText(
  fileName: string,
  source: string,
  options: ScanOptions = {},
): Finding[] {
  if (/\.html?$/i.test(fileName)) return findHardcodedHtmlText(source, options);
  if (/\.svelte$/i.test(fileName)) return findHardcodedSvelteText(source, options);
  const scan = scanScript(fileName, source, scriptKind(fileName), options);
  return scan === null ? [] : sorted(scan.ignores.findings);
}

/** 0-based line and column of each position in a text. */
function lineIndex(source: string): (position: number) => [number, number] {
  const lineStarts = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === "\n") lineStarts.push(i + 1);
  }
  return (position) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if ((lineStarts[middle] ?? 0) <= position) low = middle;
      else high = middle - 1;
    }
    return [low, position - (lineStarts[low] ?? 0)];
  };
}

/** A script scanned with the rules above. */
interface ScriptScan {
  readonly file: ts.SourceFile;
  readonly ignores: Ignores;
  /** Reports the text an expression of `file` ends up as (see checkValue). */
  readonly checkValue: (
    expression: ts.Expression,
    reason: string,
    lenient?: boolean,
  ) => void;
}

/**
 * Where the parsed text comes from, when it is not the file itself: the
 * position in the original file of each position in the parsed text, and the
 * original file's text (for lines and columns).
 */
interface SourceMapping {
  readonly original: string;
  readonly position: (parsed: number) => number;
}

/**
 * Scans a script with every rule above, and returns how to check further
 * expressions of it (for Svelte markup), or null if the file opts out with
 * i18n-ignore-file.
 */
function scanScript(
  fileName: string,
  source: string,
  kind: ts.ScriptKind,
  options: ScanOptions,
  mapping?: SourceMapping,
): ScriptScan | null {
  const attributes = new Set([...TEXT_ATTRIBUTES, ...(options.textAttributes ?? [])]);
  const calls = new Map(TEXT_CALLS);
  for (const name of options.textCalls ?? []) calls.set(name, [0]);

  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const original = mapping?.original ?? source;
  const toOriginal = mapping?.position ?? ((position: number) => position);
  const lineOf = lineIndex(original);
  const lines = original.split(/\r?\n/);
  const ignores = new Ignores((position) => lineOf(toOriginal(position)));
  for (const range of commentsOf(file)) {
    const text = source.slice(range.pos, range.end);
    if (IGNORE_FILE.test(text)) return null;
    const [firstLine, firstColumn] = lineOf(toOriginal(range.pos));
    const [lastLine] = lineOf(toOriginal(range.end));
    const before = (lines[firstLine] ?? "").slice(0, firstColumn);
    ignores.addComment(firstLine, lastLine, /^\s*\{?\s*$/.test(before), text);
  }
  const report = ignores.report.bind(ignores);

  // Strings in an expression that end up as the expression's value. `seen` stops
  // cycles through constants and functions that refer to each other.
  // `lenient`: the place is a text place only by a name's convention, so values
  // that look like codes are not reported (see looksLikeCode).
  const checkValue = (
    expression: ts.Expression,
    reason: string,
    lenient = false,
    seen: Set<ts.Node> = new Set(),
  ): void => {
    if (seen.has(expression)) return;
    seen.add(expression);
    const again = (next: ts.Expression): void => checkValue(next, reason, lenient, seen);
    const shown = (text: string): boolean =>
      isUserText(text) && !(lenient && looksLikeCode(text));
    if (
      ts.isStringLiteral(expression) ||
      ts.isNoSubstitutionTemplateLiteral(expression)
    ) {
      if (shown(expression.text)) report(expression.getStart(), expression.text, reason);
    } else if (ts.isTemplateExpression(expression)) {
      const literal =
        expression.head.text +
        expression.templateSpans.map((s) => ` ${s.literal.text}`).join("");
      if (shown(literal)) report(expression.getStart(), literal, reason);
      for (const span of expression.templateSpans) again(span.expression);
    } else if (ts.isConditionalExpression(expression)) {
      again(expression.whenTrue);
      again(expression.whenFalse);
    } else if (ts.isBinaryExpression(expression)) {
      const op = expression.operatorToken.kind;
      if (
        op === ts.SyntaxKind.AmpersandAmpersandToken ||
        op === ts.SyntaxKind.BarBarToken ||
        op === ts.SyntaxKind.QuestionQuestionToken ||
        op === ts.SyntaxKind.PlusToken
      ) {
        again(expression.left);
        again(expression.right);
      }
    } else if (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isSatisfiesExpression(expression) ||
      ts.isNonNullExpression(expression) ||
      ts.isTypeAssertionExpression(expression)
    ) {
      again(expression.expression);
    } else if (ts.isArrayLiteralExpression(expression)) {
      for (const element of expression.elements) {
        if (!ts.isOmittedExpression(element) && !ts.isSpreadElement(element)) {
          again(element);
        }
      }
    } else if (ts.isCallExpression(expression)) {
      const callee = expression.expression;
      if (ts.isPropertyAccessExpression(callee)) {
        if (STRING_METHODS.includes(callee.name.text)) {
          again(callee.expression);
          if (callee.name.text === "concat") expression.arguments.forEach(again);
        }
      } else if (ts.isIdentifier(callee)) {
        if (
          (callee.text === "String" || SVELTE_VALUE_RUNES.includes(callee.text)) &&
          expression.arguments[0] !== undefined
        ) {
          again(expression.arguments[0]);
        }
        const declaration = resolve(callee);
        const fn = declaration && functionOf(declaration);
        if (fn !== undefined && !seen.has(fn)) {
          seen.add(fn);
          for (const value of returnedValues(fn)) again(value);
        }
      }
    } else if (ts.isIdentifier(expression)) {
      const declaration = resolve(expression);
      if (
        declaration !== undefined &&
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer !== undefined &&
        functionOf(declaration) === undefined
      ) {
        again(declaration.initializer);
      }
    } else if (
      ts.isPropertyAccessExpression(expression) ||
      ts.isElementAccessExpression(expression)
    ) {
      const property = ts.isPropertyAccessExpression(expression)
        ? expression.name.text
        : ts.isStringLiteralLike(expression.argumentExpression)
          ? expression.argumentExpression.text
          : undefined;
      const object = literalObjectOf(expression.expression);
      const value = property === undefined ? undefined : propertyValue(object, property);
      if (value !== undefined) again(value);
    }
  };

  // Text properties of an options argument: new Notification(title, { body }).
  const checkOptions = (
    name: string,
    args: readonly ts.Expression[],
    what: string,
  ): void => {
    const rule = TEXT_OPTIONS.get(name);
    const argument = rule === undefined ? undefined : args[rule[0]];
    if (rule === undefined || argument === undefined) return;
    const object = literalObjectOf(argument);
    for (const property of rule[1]) {
      const value = propertyValue(object, property);
      if (value !== undefined) {
        checkValue(value, `text in the "${property}" option of ${what}`);
      }
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      if (isUserText(node.text) && !inRawJsxElement(node)) {
        const offset = node.text.search(/\S/);
        report(node.getStart() + Math.max(offset, 0), node.text, "text in JSX");
      }
    } else if (ts.isJsxExpression(node) && node.expression !== undefined) {
      if (
        (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent)) &&
        !inRawJsxElement(node)
      ) {
        checkValue(node.expression, "text in JSX");
      }
    } else if (ts.isJsxAttribute(node)) {
      const name = jsxAttributeName(node.name);
      const fixed =
        attributes.has(name) ||
        textNameKind(name) === "fixed" ||
        name === "children" ||
        (name === "value" && isButtonInput(node));
      const shown = fixed || textNameKind(name) === "convention";
      if (shown && node.initializer !== undefined) {
        const reason = `text in the "${name}" attribute`;
        if (ts.isStringLiteral(node.initializer)) {
          checkValue(node.initializer, reason, !fixed);
        } else if (ts.isJsxExpression(node.initializer) && node.initializer.expression) {
          checkValue(node.initializer.expression, reason, !fixed);
        }
      }
    } else if (ts.isPropertyAssignment(node)) {
      const name = nameOf(node.name);
      const kind = name === undefined ? undefined : textNameKind(name);
      if (kind !== undefined) {
        checkValue(
          node.initializer,
          `text in the "${name}" property`,
          kind === "convention",
        );
      }
    } else if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      const name = nameOf(node.name);
      const kind = name === undefined ? undefined : textNameKind(name);
      if (kind !== undefined) {
        checkValue(
          node.initializer,
          `text in the "${name}" variable`,
          kind === "convention",
        );
      }
    } else if (
      (ts.isPropertyDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isBindingElement(node)) &&
      node.initializer !== undefined
    ) {
      // Class fields (label = "Save") and default values ({ text = "Save" }).
      const key =
        ts.isBindingElement(node) && node.propertyName !== undefined
          ? node.propertyName
          : node.name;
      const name =
        ts.isObjectBindingPattern(key) || ts.isArrayBindingPattern(key)
          ? undefined
          : nameOf(key);
      const kind = name === undefined ? undefined : textNameKind(name);
      if (kind !== undefined) {
        checkValue(
          node.initializer,
          `text in the "${name}" default value`,
          kind === "convention",
        );
      }
    } else if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.EqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken)
    ) {
      const target = node.left;
      const name =
        ts.isPropertyAccessExpression(target) || ts.isIdentifier(target)
          ? calleeName(target)
          : ts.isElementAccessExpression(target) &&
              ts.isStringLiteral(target.argumentExpression)
            ? target.argumentExpression.text
            : undefined;
      const kind = name === undefined ? undefined : textNameKind(name);
      if (kind !== undefined) {
        checkValue(node.right, `text assigned to "${name}"`, kind === "convention");
      }
    } else if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if (name === "setAttribute") {
        const [attribute, value] = node.arguments;
        if (
          attribute !== undefined &&
          value !== undefined &&
          ts.isStringLiteral(attribute) &&
          attributes.has(attribute.text)
        ) {
          checkValue(value, `text in the "${attribute.text}" attribute`);
        }
      } else if (name !== undefined) {
        const positions = calls.get(name);
        const skip =
          SHARED_NAME_CALLS.includes(name) &&
          ts.isPropertyAccessExpression(node.expression) &&
          isNameValueReceiver(node.expression.expression);
        if (positions !== undefined && !skip) {
          node.arguments.forEach((argument, index) => {
            if (positions === "all" || positions.includes(index)) {
              checkValue(argument, `text passed to ${name}()`);
            }
          });
        }
        checkOptions(name, node.arguments, `${name}()`);
      }
    } else if (ts.isNewExpression(node)) {
      const name = calleeName(node.expression);
      const first = node.arguments?.[0];
      if (name !== undefined && TEXT_CONSTRUCTORS.includes(name) && first !== undefined) {
        checkValue(first, `text passed to new ${name}()`);
      }
      if (name !== undefined) checkOptions(name, node.arguments ?? [], `new ${name}()`);
    }
    // Functions, methods and getters named like text: what they return is text.
    const fnName = textFunctionName(node);
    if (fnName !== undefined) {
      const fn = node as ts.FunctionLikeDeclaration;
      const lenient = textNameKind(fnName) === "convention";
      for (const value of returnedValues(fn)) {
        checkValue(value, `text returned by "${fnName}"`, lenient);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(file);
  return {
    file,
    ignores,
    checkValue: (expression, reason, lenient = false) =>
      checkValue(expression, reason, lenient),
  };
}

function sorted(findings: readonly Finding[]): Finding[] {
  return [...findings].sort((a, b) => a.line - b.line || a.column - b.column);
}

/** Elements whose JSX children are CSS or code, not text. */
const RAW_JSX_ELEMENTS: readonly string[] = ["style", "script"];

/** True if a JSX child is directly inside <style> or <script>. */
function inRawJsxElement(node: ts.Node): boolean {
  const parent = node.parent;
  return (
    ts.isJsxElement(parent) &&
    RAW_JSX_ELEMENTS.includes(parent.openingElement.tagName.getText())
  );
}

/** True if a JSX "value" attribute belongs to <input type="submit|button|reset">. */
function isButtonInput(attribute: ts.JsxAttribute): boolean {
  const element = attribute.parent.parent;
  if (!ts.isJsxOpeningElement(element) && !ts.isJsxSelfClosingElement(element)) {
    return false;
  }
  if (element.tagName.getText() !== "input") return false;
  return element.attributes.properties.some(
    (other) =>
      ts.isJsxAttribute(other) &&
      jsxAttributeName(other.name) === "type" &&
      other.initializer !== undefined &&
      ts.isStringLiteral(other.initializer) &&
      BUTTON_INPUT_TYPES.includes(other.initializer.text.toLowerCase()),
  );
}

/** The name of a function-like node whose name says it returns text. */
function textFunctionName(node: ts.Node): string | undefined {
  let name: string | undefined;
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node)) &&
    node.name !== undefined
  ) {
    name = nameOf(node.name);
  } else if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    (ts.isVariableDeclaration(node.parent) || ts.isPropertyAssignment(node.parent)) &&
    node.parent.initializer === node
  ) {
    name = nameOf(node.parent.name);
  }
  return name !== undefined && isTextName(name) ? name : undefined;
}

/** The function a declaration holds: a function declaration or a variable with one. */
function functionOf(declaration: ts.Node): ts.FunctionLikeDeclaration | undefined {
  if (ts.isFunctionDeclaration(declaration)) return declaration;
  if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) {
    let init: ts.Expression = declaration.initializer;
    while (ts.isParenthesizedExpression(init)) init = init.expression;
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init;
  }
  return undefined;
}

/** The expressions a function returns (not those of functions nested in it). */
function returnedValues(fn: ts.FunctionLikeDeclaration): ts.Expression[] {
  const body = fn.body;
  if (body === undefined) return [];
  if (!ts.isBlock(body)) return [body];
  const values: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression !== undefined) {
      values.push(node.expression);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return values;
}

/**
 * The declaration an identifier refers to, if it is a variable or function declared
 * in an enclosing block of the same file. A parameter, a catch variable or an import
 * gives undefined: their values are not known here.
 */
function resolve(identifier: ts.Identifier): ts.Node | undefined {
  const name = identifier.text;
  for (let node: ts.Node | undefined = identifier.parent; node; node = node.parent) {
    if (ts.isFunctionLike(node)) {
      const shadowed = node.parameters.some((parameter) =>
        bindsName(parameter.name, name),
      );
      if (shadowed) return undefined;
    }
    if (ts.isCatchClause(node) && node.variableDeclaration !== undefined) {
      if (bindsName(node.variableDeclaration.name, name)) return undefined;
    }
    if (
      (ts.isForOfStatement(node) ||
        ts.isForInStatement(node) ||
        ts.isForStatement(node)) &&
      node.initializer !== undefined &&
      ts.isVariableDeclarationList(node.initializer) &&
      node.initializer.declarations.some((d) => bindsName(d.name, name))
    ) {
      return undefined;
    }
    if (ts.isBlock(node) || ts.isSourceFile(node) || ts.isModuleBlock(node)) {
      for (const statement of node.statements) {
        if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
              return declaration;
            }
            if (bindsName(declaration.name, name)) return undefined; // destructured
          }
        } else if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) {
          return statement;
        } else if (ts.isImportDeclaration(statement)) {
          const clause = statement.importClause;
          if (clause !== undefined && importBinds(clause, name)) return undefined;
        }
      }
    }
  }
  return undefined;
}

function bindsName(binding: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(binding)) return binding.text === name;
  return binding.elements.some(
    (element) => !ts.isOmittedExpression(element) && bindsName(element.name, name),
  );
}

function importBinds(clause: ts.ImportClause, name: string): boolean {
  if (clause.name?.text === name) return true;
  const bindings = clause.namedBindings;
  if (bindings === undefined) return false;
  if (ts.isNamespaceImport(bindings)) return bindings.name.text === name;
  return bindings.elements.some((element) => element.name.text === name);
}

/** The object literal an expression stands for, through local constants. */
function literalObjectOf(
  expression: ts.Expression,
): ts.ObjectLiteralExpression | undefined {
  let current: ts.Expression = expression;
  for (let depth = 0; depth < 10; depth += 1) {
    while (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current)
    ) {
      current = current.expression;
    }
    if (ts.isObjectLiteralExpression(current)) return current;
    if (!ts.isIdentifier(current)) return undefined;
    const declaration = resolve(current);
    if (
      declaration === undefined ||
      !ts.isVariableDeclaration(declaration) ||
      declaration.initializer === undefined
    ) {
      return undefined;
    }
    current = declaration.initializer;
  }
  return undefined;
}

function propertyValue(
  object: ts.ObjectLiteralExpression | undefined,
  property: string,
): ts.Expression | undefined {
  for (const element of object?.properties ?? []) {
    if (ts.isPropertyAssignment(element) && nameOf(element.name) === property) {
      return element.initializer;
    }
  }
  return undefined;
}

/**
 * True if the receiver of an append() call is a FormData, URLSearchParams or
 * Headers object rather than a DOM node: built with `new FormData()` (or declared
 * with that type) in this file, reached as `.searchParams` or `.headers`, or named
 * like one (form, params, query, headers).
 */
function isNameValueReceiver(receiver: ts.Expression): boolean {
  if (ts.isNewExpression(receiver)) {
    const name = calleeName(receiver.expression);
    return name !== undefined && NAME_VALUE_TYPES.includes(name);
  }
  if (ts.isPropertyAccessExpression(receiver)) {
    // document.body, frame.contentDocument.body: DOM nodes, not request bodies.
    const owner = calleeName(receiver.expression);
    if (owner !== undefined && /^(?:document|ownerDocument)$|Document$/.test(owner)) {
      return false;
    }
    return (
      NAME_VALUE_RECEIVER.test(receiver.name.text) ||
      receiver.name.text === "searchParams"
    );
  }
  if (!ts.isIdentifier(receiver)) return false;
  if (NAME_VALUE_RECEIVER.test(receiver.text)) return true;
  const declaration = resolveBinding(receiver);
  if (declaration === undefined) return false;
  const type = declaration.type;
  if (type !== undefined && ts.isTypeReferenceNode(type)) {
    if (NAME_VALUE_TYPES.includes(type.typeName.getText())) return true;
  }
  const init = ts.isVariableDeclaration(declaration)
    ? declaration.initializer
    : undefined;
  return init !== undefined && ts.isNewExpression(init) && isNameValueReceiver(init);
}

/** Like resolve(), but also returns parameters, for their declared type. */
function resolveBinding(
  identifier: ts.Identifier,
): ts.VariableDeclaration | ts.ParameterDeclaration | undefined {
  const name = identifier.text;
  for (let node: ts.Node | undefined = identifier.parent; node; node = node.parent) {
    if (ts.isFunctionLike(node)) {
      const parameter = node.parameters.find(
        (p) => ts.isIdentifier(p.name) && p.name.text === name,
      );
      if (parameter !== undefined) return parameter;
    }
  }
  const declaration = resolve(identifier);
  return declaration !== undefined && ts.isVariableDeclaration(declaration)
    ? declaration
    : undefined;
}

// HTML ---------------------------------------------------------------------------

/** Elements whose content is not shown as text. */
const HTML_RAW_TEXT = ["script", "style", "template", "textarea"];

/**
 * Finds hard-coded text in an HTML page: text between tags (the <title> and
 * <noscript> included, <script> and <style> excluded), text attributes (title,
 * alt, placeholder, aria-label, ...) and the value of button-like inputs.
 */
export function findHardcodedHtmlText(
  source: string,
  options: ScanOptions = {},
): Finding[] {
  const attributes = new Set([...TEXT_ATTRIBUTES, ...(options.textAttributes ?? [])]);
  const lineOf = lineIndex(source);
  const ignores = new Ignores(lineOf);

  for (const match of source.matchAll(/<!--([\s\S]*?)-->/g)) {
    const text = match[1] ?? "";
    if (IGNORE_FILE.test(text)) return [];
    const start = match.index;
    const [first, column] = lineOf(start);
    const [last] = lineOf(start + match[0].length);
    const before = source.slice(start - column, start);
    ignores.addComment(first, last, /^\s*$/.test(before), text);
  }

  // Tags, comments and the text between them.
  const token =
    /<!--[\s\S]*?-->|<![^>]*>|<\/?([A-Za-z][A-Za-z0-9-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*\/?>/g;
  const attribute = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  const report = ignores.report.bind(ignores);
  const text = (from: number, to: number): void => {
    const chunk = source.slice(from, to);
    if (isUserText(chunk)) {
      report(from + Math.max(chunk.search(/\S/), 0), chunk, "text in HTML");
    }
  };
  let position = 0;
  let rawUntil: string | undefined;
  let inlineScript = false;
  const extra: Finding[] = [];
  for (const match of source.matchAll(token)) {
    const start = match.index;
    const tag = match[1]?.toLowerCase();
    const closing = match[0].startsWith("</");
    if (rawUntil !== undefined) {
      if (closing && tag === rawUntil) {
        if (inlineScript) extra.push(...inlineScriptText(position, start));
        rawUntil = undefined;
        inlineScript = false;
        position = start + match[0].length;
      }
      continue;
    }
    text(position, start);
    position = start + match[0].length;
    if (tag === undefined || closing) continue;
    if (HTML_RAW_TEXT.includes(tag) && !match[0].endsWith("/>")) rawUntil = tag;

    const values = new Map<string, { value: string; at: number }>();
    const attributeText = match[2] ?? "";
    const attributesAt = start + 1 + (match[1]?.length ?? 0);
    for (const found of attributeText.matchAll(attribute)) {
      const name = (found[1] ?? "").toLowerCase();
      const value = found[2] ?? found[3] ?? found[4];
      if (value === undefined) continue;
      const valueAt = attributesAt + found.index + found[0].indexOf(value);
      values.set(name, { value, at: valueAt });
    }
    const type = values.get("type")?.value.toLowerCase();
    inlineScript =
      rawUntil === "script" &&
      !values.has("src") &&
      (type === undefined || /^(?:module|(?:text|application)\/javascript)$/.test(type));
    const buttonInput =
      tag === "input" &&
      BUTTON_INPUT_TYPES.includes(values.get("type")?.value.toLowerCase() ?? "");
    for (const [name, { value, at }] of values) {
      const shown = attributes.has(name) || (name === "value" && buttonInput);
      if (shown && isUserText(value))
        report(at, value, `text in the "${name}" attribute`);
    }
  }
  if (rawUntil === undefined) text(position, source.length);
  return sorted([...ignores.findings, ...extra]);

  // A <script> without src is checked like a script file, with its own comments.
  function inlineScriptText(from: number, to: number): Finding[] {
    const [line, column] = lineOf(from);
    return findHardcodedText("inline.ts", source.slice(from, to), options).map(
      (finding) => ({
        ...finding,
        line: line + finding.line,
        column: finding.line === 1 ? column + finding.column : finding.column,
      }),
    );
  }
}

// Svelte components ---------------------------------------------------------------

/** A node of Svelte's template syntax tree, as svelte/compiler's parse gives it. */
interface SvelteNode {
  readonly type: string;
  /** Where it is in the source; fragments have no position. */
  readonly start: number;
  readonly end: number;
  readonly [key: string]: unknown;
}

function isSvelteNode(value: unknown): value is SvelteNode {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

/** Elements whose children in Svelte markup are CSS or code, not text. */
const SVELTE_RAW_ELEMENTS: readonly string[] = ["script", "style"];

/** An expression of the markup, as it will be found in the scanned script. */
interface MarkupExpression {
  /** Where it is in the component's source. */
  readonly start: number;
  readonly end: number;
  /**
   * The source copied into the script: the expression, or the inside of its
   * braces, so that comments next to it count.
   */
  readonly from: number;
  readonly to: number;
  /** For text places: the reason and whether the place is text only by a name's convention. */
  readonly text?: { readonly reason: string; readonly lenient: boolean };
}

/**
 * Finds hard-coded text in a Svelte component. The markup is read with
 * svelte/compiler's parser:
 *
 *   - text in the markup:                      <button>Save</button>
 *   - expressions in the markup and {@html}:   <p>{busy ? "Saving" : "Saved"}</p>
 *   - text attributes and props, as in JSX (TEXT_ATTRIBUTES, names that hold
 *     text by convention, value on button-like inputs), whether written as
 *     text, as an expression or as both:       <img alt="Logo" title={"Hi " + name} />
 *
 * The <script> blocks are checked with the TypeScript rules above, and so is
 * every expression of the markup (event handlers, block conditions, {@const}),
 * as part of one script, so that the markup's expressions follow the script's
 * constants and functions, as in a .tsx file. A comment
 * <!-- i18n-ignore: <reason> --> in the markup works as in HTML, and comments
 * in the scripts and inside expressions as in TypeScript.
 */
export function findHardcodedSvelteText(
  source: string,
  options: ScanOptions = {},
): Finding[] {
  let root: SvelteNode;
  try {
    root = parseSvelte(source, { modern: true }) as unknown as SvelteNode;
  } catch (error) {
    const at = (error as { start?: { line?: number; column?: number } }).start;
    return [
      {
        line: at?.line ?? 1,
        column: (at?.column ?? 0) + 1,
        text: shorten(String((error as { message?: unknown }).message ?? error)),
        reason: "the component cannot be parsed",
      },
    ];
  }
  const attributes = new Set([...TEXT_ATTRIBUTES, ...(options.textAttributes ?? [])]);

  // The script: the <script> blocks where they are, everything else blanked
  // (line breaks kept), then each markup expression as a statement of its own.
  const scripts: Array<[number, number]> = [];
  for (const key of ["instance", "module"]) {
    const block = root[key];
    if (isSvelteNode(block) && isSvelteNode(block["content"])) {
      scripts.push([block["content"].start, block["content"].end]);
    }
  }
  const inScript = (position: number): boolean =>
    scripts.some(([from, to]) => position >= from && position < to);
  let script = "";
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]!;
    script += inScript(i) || char === "\n" || char === "\r" ? char : " ";
  }

  const comments: SvelteNode[] = [];
  const texts: Array<{ node: SvelteNode; reason: string; lenient: boolean }> = [];
  const expressions: MarkupExpression[] = [];
  const declarations: Array<[number, number]> = [];

  const addExpression = (
    value: unknown,
    text?: { readonly reason: string; readonly lenient: boolean },
    braces?: SvelteNode,
  ): void => {
    if (!isSvelteNode(value) || typeof value.start !== "number") return;
    const inside =
      braces !== undefined &&
      source[braces.start] === "{" &&
      source[braces.end - 1] === "}" &&
      braces.start < value.start &&
      value.end < braces.end;
    const from = inside ? braces.start + 1 : value.start;
    const to = inside ? braces.end - 1 : value.end;
    expressions.push({
      start: value.start,
      end: value.end,
      from,
      to,
      ...(text ? { text } : {}),
    });
  };

  const attribute = (node: SvelteNode, element: SvelteNode): void => {
    if (node.type === "UseDirective") {
      // An action named like text (use:tooltip={...}) shows what it is given.
      const name = String(node["name"]);
      const kind = textNameKind(name) ?? (attributes.has(name) ? "fixed" : undefined);
      addExpression(
        node["expression"],
        kind === undefined
          ? undefined
          : {
              reason: `text given to the "${name}" action`,
              lenient: kind === "convention",
            },
      );
      return;
    }
    if (node.type !== "Attribute") {
      // Other directives (bind:, on:, class:, style:, ...) and spreads: code, not a
      // place for text; their expressions are checked as code.
      addExpression(node["expression"]);
      return;
    }
    const name = String(node["name"]);
    const fixed =
      attributes.has(name) ||
      textNameKind(name) === "fixed" ||
      (name === "value" && isButtonElement(element));
    const shown = fixed || textNameKind(name) === "convention";
    const reason = `text in the "${name}" attribute`;
    const parts = Array.isArray(node["value"])
      ? (node["value"] as unknown[])
      : [node["value"]];
    for (const part of parts) {
      if (!isSvelteNode(part)) continue;
      if (part.type === "Text") {
        if (shown) texts.push({ node: part, reason, lenient: !fixed });
      } else if (part.type === "ExpressionTag") {
        addExpression(
          part["expression"],
          shown ? { reason, lenient: !fixed } : undefined,
          part,
        );
      }
    }
  };

  const visit = (node: unknown, raw: boolean): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item, raw);
      return;
    }
    if (!isSvelteNode(node)) return;
    switch (node.type) {
      case "Fragment":
        visit(node["nodes"], raw);
        return;
      case "Text":
        if (!raw) texts.push({ node, reason: "text in markup", lenient: false });
        return;
      case "Comment":
        comments.push(node);
        return;
      case "ExpressionTag":
      case "HtmlTag":
        addExpression(
          node["expression"],
          raw ? undefined : { reason: "text in markup", lenient: false },
          node.type === "ExpressionTag" ? node : undefined,
        );
        return;
      case "ConstTag": {
        const declaration = node["declaration"];
        if (isSvelteNode(declaration))
          declarations.push([declaration.start, declaration.end]);
        return;
      }
      default:
        break;
    }
    if (Array.isArray(node["attributes"])) {
      for (const item of node["attributes"] as unknown[]) {
        if (isSvelteNode(item)) attribute(item, node);
      }
      const name = typeof node["name"] === "string" ? node["name"].toLowerCase() : "";
      visit(node["fragment"], raw || SVELTE_RAW_ELEMENTS.includes(name));
      // <svelte:element this={...}> and <svelte:component this={...}>.
      addExpression(node["tag"]);
      addExpression(node["expression"]);
      return;
    }
    // Blocks: their expressions are code; their fragments hold markup.
    for (const [key, value] of Object.entries(node)) {
      if (key === "type" || key === "start" || key === "end") continue;
      if (isSvelteNode(value) && value.type === "Fragment") visit(value, raw);
      else if (
        isSvelteNode(value) &&
        ["expression", "test", "key", "argument"].includes(key)
      ) {
        addExpression(value);
      }
    }
  };
  visit(root["fragment"], false);

  // Append the markup's expressions and {@const} declarations to the script.
  const segments: Array<{ at: number; from: number; length: number }> = [];
  const append = (from: number, to: number, before: string, after: string): number => {
    script += before;
    const at = script.length;
    script += source.slice(from, to) + after;
    segments.push({ at, from, length: to - from });
    return at;
  };
  for (const [from, to] of declarations) append(from, to, "\n", ";");
  const placed = expressions.map((e) => ({
    ...e,
    at: append(e.from, e.to, "\n;(", "\n);") + (e.start - e.from),
  }));
  const position = (parsed: number): number => {
    if (parsed < source.length) return parsed;
    const segment = segments.find((s) => parsed >= s.at && parsed <= s.at + s.length);
    return segment === undefined ? source.length : segment.from + (parsed - segment.at);
  };

  const scan = scanScript("component.svelte.ts", script, ts.ScriptKind.TS, options, {
    original: source,
    position,
  });
  if (scan === null) return [];
  const lineOf = lineIndex(source);
  const lines = source.split(/\r?\n/);
  for (const comment of comments) {
    const text = String(comment["data"] ?? "");
    if (IGNORE_FILE.test(text)) return [];
    const [first, column] = lineOf(comment.start);
    const [last] = lineOf(comment.end);
    const before = (lines[first] ?? "").slice(0, column);
    scan.ignores.addComment(first, last, /^\s*$/.test(before), text);
  }

  for (const { node, reason, lenient } of texts) {
    const data = String(node["data"] ?? "");
    if (isUserText(data) && !(lenient && looksLikeCode(data))) {
      scan.ignores.report(node.start + Math.max(data.search(/\S/), 0), data, reason);
    }
  }
  // Find each appended expression in the parsed script by where it starts.
  const byStart = new Map<number, ts.Expression>();
  const collect = (node: ts.Node): void => {
    if (ts.isParenthesizedExpression(node) && ts.isExpressionStatement(node.parent)) {
      byStart.set(node.expression.getStart(scan.file), node.expression);
    }
    ts.forEachChild(node, collect);
  };
  collect(scan.file);
  for (const expression of placed) {
    if (expression.text === undefined) continue;
    const found = byStart.get(expression.at);
    if (found !== undefined) {
      scan.checkValue(found, expression.text.reason, expression.text.lenient);
    }
  }
  return sorted(scan.ignores.findings);
}

/** <input type="submit|button|reset">, whose value is its visible label. */
function isButtonElement(element: SvelteNode): boolean {
  if (element["name"] !== "input" || !Array.isArray(element["attributes"])) return false;
  return (element["attributes"] as unknown[]).some((item) => {
    if (!isSvelteNode(item) || item.type !== "Attribute" || item["name"] !== "type")
      return false;
    const value = item["value"];
    const parts = Array.isArray(value) ? value : [];
    return (
      parts.length === 1 &&
      isSvelteNode(parts[0]) &&
      parts[0].type === "Text" &&
      BUTTON_INPUT_TYPES.includes(String(parts[0]["data"]).toLowerCase())
    );
  });
}

// Message bundles ----------------------------------------------------------------

export interface BundleRules {
  /** The package's messages folder, relative to the package ("src/messages"). */
  readonly messages: string;
  /** The interface languages; each catalog comes from <messages>/<language>.ts. */
  readonly locales: readonly string[];
}

/**
 * Finds defineMessages() calls that the catalog check cannot see: a call outside
 * the package's messages folder, a catalog written inline as an object literal, or
 * a catalog that is not imported from the message file of its language
 * (<messages>/<language>.ts). `fileName` is relative to the package.
 */
export function findBundleProblems(
  fileName: string,
  source: string,
  rules: BundleRules,
): Finding[] {
  if (!source.includes("defineMessages") && !source.includes("namespace")) return [];
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(fileName),
  );
  const findings: Finding[] = [];
  const add = (node: ts.Node, text: string, reason: string): void => {
    const { line, character } = file.getLineAndCharacterOfPosition(node.getStart(file));
    findings.push({ line: line + 1, column: character + 1, text, reason });
  };
  const folder = fileName.includes("/")
    ? fileName.slice(0, fileName.lastIndexOf("/"))
    : ".";
  const inMessages = folder === rules.messages;

  // Local names of defineMessages (import { defineMessages as dm } counts) and the
  // module each default or named import comes from.
  const defineNames = new Set(["defineMessages"]);
  const defaultFrom = new Map<string, string>();
  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const from = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (clause?.name !== undefined) defaultFrom.set(clause.name.text, from);
    const bindings = clause?.namedBindings;
    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if ((element.propertyName ?? element.name).text === "defineMessages") {
          defineNames.add(element.name.text);
        }
      }
    }
  }

  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node) && isHandWrittenBundle(node)) {
      add(
        node,
        shorten(node.getText(file)),
        `a message bundle written by hand; create it with defineMessages() in ${rules.messages}/index.ts, where the check compares the languages`,
      );
    }
    const name = ts.isCallExpression(node) ? calleeName(node.expression) : undefined;
    if (ts.isCallExpression(node) && name !== undefined && defineNames.has(name)) {
      if (!inMessages) {
        add(
          node,
          name,
          `defineMessages() outside ${rules.messages}; create bundles in ${rules.messages}/index.ts, where the check compares the languages`,
        );
      }
      const catalogs = node.arguments[1];
      if (catalogs === undefined || !ts.isObjectLiteralExpression(catalogs)) {
        if (catalogs !== undefined) {
          add(catalogs, catalogs.getText(file), "catalogs must be given as { nb, en }");
        }
      } else {
        for (const property of catalogs.properties) {
          checkCatalogProperty(property);
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  const checkCatalogProperty = (property: ts.ObjectLiteralElementLike): void => {
    const language = property.name === undefined ? undefined : nameOf(property.name);
    const shown = property.name?.getText(file) ?? property.getText(file);
    if (
      ts.isPropertyAssignment(property) &&
      ts.isObjectLiteralExpression(property.initializer)
    ) {
      add(
        property,
        shown,
        `catalog written inline; put it in a message file (${rules.messages}/<language>.ts)`,
      );
      return;
    }
    const value = ts.isShorthandPropertyAssignment(property)
      ? property.name
      : ts.isPropertyAssignment(property)
        ? property.initializer
        : undefined;
    const expected = language === undefined ? undefined : `./${language}.ts`;
    const from =
      value !== undefined && ts.isIdentifier(value)
        ? defaultFrom.get(value.text)
        : undefined;
    if (language === undefined || !rules.locales.includes(language)) {
      add(property, shown, `not an interface language (${rules.locales.join(", ")})`);
    } else if (inMessages && from !== expected) {
      add(
        property,
        shown,
        `the ${language} catalog must be the default export of ${expected}, imported in this file`,
      );
    }
  };

  visit(file);
  return findings;
}

/**
 * True for an object literal that looks like a message bundle: a "namespace" given
 * as a string and a "messages" property. defineMessages() builds its result from
 * variables ({ namespace, messages }), which does not count.
 */
function isHandWrittenBundle(node: ts.ObjectLiteralExpression): boolean {
  let namespace = false;
  let messages = false;
  for (const property of node.properties) {
    const name = property.name === undefined ? undefined : nameOf(property.name);
    if (
      name === "namespace" &&
      ts.isPropertyAssignment(property) &&
      ts.isStringLiteralLike(property.initializer)
    ) {
      namespace = true;
    }
    if (name === "messages") messages = true;
  }
  return namespace && messages;
}
