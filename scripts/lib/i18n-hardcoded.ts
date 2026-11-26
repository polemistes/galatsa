// SPDX-License-Identifier: GPL-3.0-or-later

// Pure logic for the hard-coded text check (scripts/check-i18n.ts): finds text that a
// user would see, written directly in user interface code instead of coming from the
// translation files. It parses the file with the TypeScript compiler, so text in
// comments, type names and imports is never mistaken for user text.
//
// User-visible text is a string (or the literal parts of a template string) that
// contains at least one letter, in one of these places:
//
//   1. JSX text:                         <button>Save</button>
//   2. JSX children in braces:           <p>{busy ? "Saving" : "Saved"}</p>
//   3. Text attributes (TEXT_ATTRIBUTES): <img alt="Logo" />, aria-label, title, ...
//   4. Text properties and names (isTextName), in object literals, variable
//      declarations and assignments:     { label: "Save" }, el.textContent = "Save",
//                                        const emptyMessage = "Nothing here"
//   5. Arguments of DOM and browser APIs that show text (TEXT_CALLS):
//                                        alert("Saved"), ctx.fillText("Hi", 0, 0),
//                                        el.setAttribute("title", "Close")
//
// Not user text: strings without letters ("–", "100", "·"), and message keys in the
// form "namespace:key" (for example "editor:toolbar.save").
//
// Opting out: a comment `i18n-ignore: <reason>` on the same line or the line above
// skips that line, and `i18n-ignore-file: <reason>` anywhere in a comment skips the
// file. The reason is required. In JSX, write the comment as {/* i18n-ignore: ... */}.
//
// The check sees text where it is written, not where it ends up: a string stored in
// a variable with an ordinary name and shown later is not found.

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

/** JSX attributes whose value is shown to users or read aloud by screen readers. */
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
 * Names that hold user text by convention: label, title, tooltip and so on, and
 * names ending in Label, Title, Text, Message and so on (saveLabel, emptyMessage).
 */
export function isTextName(name: string): boolean {
  if (TEXT_PROPERTIES.includes(name) || TEXT_ATTRIBUTES.includes(name)) return true;
  if (/^(?:text|ariaLabel)$/.test(name)) return true;
  return /[a-z0-9](?:Label|Title|Tooltip|Placeholder|Caption|Heading|Description|Message|Text|Hint)$/.test(
    name,
  );
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
  ["append", "all"],
  ["prepend", "all"],
  ["replaceChildren", "all"],
  ["replaceWith", "all"],
]);

/** Constructors whose first argument is shown to users. */
const TEXT_CONSTRUCTORS: readonly string[] = ["Notification", "Option"];

const MESSAGE_KEY = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*:[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const ENTITY = /&(?:[A-Za-z]+|#\d+|#x[0-9A-Fa-f]+);/g;

/** True if the text would be read as words by a user. */
export function isUserText(text: string): boolean {
  const trimmed = text.trim();
  if (MESSAGE_KEY.test(trimmed)) return false;
  return /\p{L}/u.test(trimmed.replace(ENTITY, " "));
}

const IGNORE_LINE = /i18n-ignore(?!-file)(:\s*\S)?/;
const IGNORE_FILE = /(?:\/\/|\/\*)\s*i18n-ignore-file:\s*\S/;
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\{\s*\/\*)/;

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

/** Finds hard-coded user-visible text in one user interface source file. */
export function findHardcodedText(
  fileName: string,
  source: string,
  options: ScanOptions = {},
): Finding[] {
  if (IGNORE_FILE.test(source)) return [];

  const attributes = new Set([...TEXT_ATTRIBUTES, ...(options.textAttributes ?? [])]);
  const calls = new Map(TEXT_CALLS);
  for (const name of options.textCalls ?? []) calls.set(name, [0]);

  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(fileName),
  );
  const lines = source.split(/\r?\n/);
  const findings: Finding[] = [];

  const report = (position: number, text: string, reason: string): void => {
    const { line, character } = file.getLineAndCharacterOfPosition(position);
    const here = lines[line] ?? "";
    const above = line > 0 ? (lines[line - 1] ?? "") : "";
    // The line above counts only if it holds nothing but the comment, so a trailing
    // opt-out on one line does not also cover the next.
    const candidates = COMMENT_LINE.test(above) ? [here, above] : [here];
    for (const candidate of candidates) {
      const ignore = IGNORE_LINE.exec(candidate);
      if (ignore === null) continue;
      if (ignore[1] !== undefined) return;
      findings.push({
        line: line + 1,
        column: character + 1,
        text: shorten(text),
        reason: "i18n-ignore needs a reason: write `i18n-ignore: <why this is not text>`",
      });
      return;
    }
    findings.push({ line: line + 1, column: character + 1, text: shorten(text), reason });
  };

  // Strings in an expression that end up as the expression's value: literals,
  // template strings, both sides of ?:, &&, ||, ?? and +, and array elements.
  const checkValue = (expression: ts.Expression, reason: string): void => {
    if (
      ts.isStringLiteral(expression) ||
      ts.isNoSubstitutionTemplateLiteral(expression)
    ) {
      if (isUserText(expression.text))
        report(expression.getStart(), expression.text, reason);
    } else if (ts.isTemplateExpression(expression)) {
      const literal =
        expression.head.text +
        expression.templateSpans.map((s) => ` ${s.literal.text}`).join("");
      if (isUserText(literal)) report(expression.getStart(), literal, reason);
    } else if (ts.isConditionalExpression(expression)) {
      checkValue(expression.whenTrue, reason);
      checkValue(expression.whenFalse, reason);
    } else if (ts.isBinaryExpression(expression)) {
      const op = expression.operatorToken.kind;
      if (
        op === ts.SyntaxKind.AmpersandAmpersandToken ||
        op === ts.SyntaxKind.BarBarToken ||
        op === ts.SyntaxKind.QuestionQuestionToken ||
        op === ts.SyntaxKind.PlusToken
      ) {
        checkValue(expression.left, reason);
        checkValue(expression.right, reason);
      }
    } else if (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isSatisfiesExpression(expression) ||
      ts.isNonNullExpression(expression)
    ) {
      checkValue(expression.expression, reason);
    } else if (ts.isArrayLiteralExpression(expression)) {
      for (const element of expression.elements) checkValue(element, reason);
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      if (isUserText(node.text)) {
        const offset = node.text.search(/\S/);
        report(node.getStart() + Math.max(offset, 0), node.text, "text in JSX");
      }
    } else if (ts.isJsxExpression(node) && node.expression !== undefined) {
      if (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent)) {
        checkValue(node.expression, "text in JSX");
      }
    } else if (ts.isJsxAttribute(node)) {
      const name = ts.isIdentifier(node.name)
        ? node.name.text
        : `${node.name.namespace.text}:${node.name.name.text}`;
      if (attributes.has(name) && node.initializer !== undefined) {
        const reason = `text in the "${name}" attribute`;
        if (ts.isStringLiteral(node.initializer)) checkValue(node.initializer, reason);
        else if (ts.isJsxExpression(node.initializer) && node.initializer.expression) {
          checkValue(node.initializer.expression, reason);
        }
      }
    } else if (ts.isPropertyAssignment(node)) {
      const name = nameOf(node.name);
      if (name !== undefined && isTextName(name)) {
        checkValue(node.initializer, `text in the "${name}" property`);
      }
    } else if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      const name = nameOf(node.name);
      if (name !== undefined && isTextName(name)) {
        checkValue(node.initializer, `text in the "${name}" variable`);
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
      if (name !== undefined && isTextName(name)) {
        checkValue(node.right, `text assigned to "${name}"`);
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
        if (positions !== undefined) {
          node.arguments.forEach((argument, index) => {
            if (positions === "all" || positions.includes(index)) {
              checkValue(argument, `text passed to ${name}()`);
            }
          });
        }
      }
    } else if (ts.isNewExpression(node)) {
      const name = calleeName(node.expression);
      const first = node.arguments?.[0];
      if (name !== undefined && TEXT_CONSTRUCTORS.includes(name) && first !== undefined) {
        checkValue(first, `text passed to new ${name}()`);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(file);
  return findings;
}

/**
 * Finds catalogs written inline, as object literals passed to defineMessages().
 * Catalogs must live in message files (src/messages/nb.ts and en.ts), where the
 * check can compare the languages.
 */
export function findInlineCatalogs(fileName: string, source: string): Finding[] {
  if (!source.includes("defineMessages")) return [];
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(fileName),
  );
  const findings: Finding[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && calleeName(node.expression) === "defineMessages") {
      const catalogs = node.arguments[1];
      if (catalogs !== undefined && ts.isObjectLiteralExpression(catalogs)) {
        for (const property of catalogs.properties) {
          if (
            ts.isPropertyAssignment(property) &&
            ts.isObjectLiteralExpression(property.initializer)
          ) {
            const { line, character } = file.getLineAndCharacterOfPosition(
              property.getStart(),
            );
            findings.push({
              line: line + 1,
              column: character + 1,
              text: property.name.getText(file),
              reason:
                "catalog written inline; put it in a message file (src/messages/<language>.ts)",
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return findings;
}
