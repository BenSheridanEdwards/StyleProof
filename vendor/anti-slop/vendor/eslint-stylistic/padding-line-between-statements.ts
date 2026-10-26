// Vendored from ESLint Stylistic; see UPSTREAM.md and LICENSE in this directory.
import type { ESTree, Context as RuleContext, SourceCode, Token as SyntaxToken, Comment, CreateRule, Location } from '@oxlint/plugins'
type ASTNode = ESTree.Node
type Token = SyntaxToken | Comment
import type {
  PaddingType,
  SelectorOption,
  StatementMatcher,
} from './padding-line-options.d.ts'
import {
  isClosingBraceToken,
  isFunction,
  isNotSemicolonToken,
  isParenthesized,
  isSemicolonToken,
  isSingleLine,
  isTokenOnSameLine,
  isTopLevelExpressionStatement,
  LINEBREAKS,
  skipChainExpression,
} from './padding-line-ast.ts'

const CJS_EXPORT = /^(?:module\s*\.\s*)?exports(?:\s*\.|\s*\[|$)/u
const CJS_IMPORT = /^require\(/u

/**
 * This rule is a replica of padding-line-between-statements.
 *
 * Ideally we would want to extend the rule support typescript specific support.
 * But since not all the state is exposed by the eslint and eslint has frozen stylistic rules,
 * (see - https://eslint.org/blog/2020/05/changes-to-rules-policies for details.)
 * we are forced to re-implement the rule here.
 *
 * We have tried to keep the implementation as close as possible to the eslint implementation, to make
 * patching easier for future contributors.
 *
 * Reference rule - https://github.com/eslint/eslint/blob/main/lib/rules/padding-line-between-statements.js
 */

type NodeTest = (
  node: ASTNode,
  sourceCode: SourceCode,
) => boolean

export interface NodeTestObject {
  test: NodeTest
}

/**
 * A policy entry may name a caller-defined statement type (registered through
 * `createPaddingLineRule`) anywhere the upstream statement types are accepted.
 */
export type PolicyStatementOption<Extra extends string = never> =
  | StatementMatcher
  | Extra
  | [StatementMatcher | Extra, ...(StatementMatcher | Extra)[]]

export type PolicyOptions<Extra extends string = never> = {
  blankLine: PaddingType
  prev: PolicyStatementOption<Extra>
  next: PolicyStatementOption<Extra>
}[]

const LT = `[${Array.from(LINEBREAKS).join('')}]`
const PADDING_LINE_SEQUENCE = new RegExp(
  String.raw`^(\s*?${LT})\s*${LT}(\s*;?)$`,
  'u',
)

function isSelectorOption(option: PolicyStatementOption<string>): option is SelectorOption {
  return typeof option === 'object' && !Array.isArray(option)
}

/**
 * Creates tester which check if a node starts with specific keyword with the
 * appropriate AST_NODE_TYPES.
 * @param keyword The keyword to test.
 * @returns the created tester.
 * @private
 */
function newKeywordTester(
  type: string | string[],
  keyword: string,
): NodeTestObject {
  return {
    test(node, sourceCode): boolean {
      const isSameKeyword = sourceCode.getFirstToken(node)?.value === keyword
      const isSameType = Array.isArray(type)
        ? type.includes(node.type)
        : type === node.type

      return isSameKeyword && isSameType
    },
  }
}

/**
 * Creates tester which check if a node is specific type.
 * @param type The node type to test.
 * @returns the created tester.
 * @private
 */
function newNodeTypeTester(type: string): NodeTestObject {
  return {
    test: (node): boolean => node.type === type,
  }
}

/**
 * Checks the given node is an expression statement of IIFE.
 * @param node The node to check.
 * @returns `true` if the node is an expression statement of IIFE.
 * @private
 */
function isIIFEStatement(node: ASTNode): boolean {
  if (node.type === 'ExpressionStatement') {
    let expression = skipChainExpression(node.expression)
    if (expression.type === 'UnaryExpression')
      expression = skipChainExpression(expression.argument)

    if (expression.type === 'CallExpression') {
      let node: ASTNode = expression.callee
      while (node.type === 'SequenceExpression') {
        const lastExpression = node.expressions.at(-1)
        if (lastExpression === undefined)
          throw new Error('Padding rule invariant: sequence expression is empty')
        node = lastExpression
      }

      return isFunction(node)
    }
  }
  return false
}

/**
 * Checks the given node is a CommonJS require statement
 * @param node The node to check.
 * @returns `true` if the node is a CommonJS require statement.
 * @private
 */
function isCJSRequire(node: ASTNode): boolean {
  if (node.type === 'VariableDeclaration') {
    const declaration = node.declarations[0]
    if (declaration?.init) {
      let call = declaration?.init
      while (call.type === 'MemberExpression')
        call = call.object

      if (
        call.type === 'CallExpression'
        && call.callee.type === 'Identifier'
      ) {
        return call.callee.name === 'require'
      }
    }
  }
  return false
}

/**
 * Checks whether the given node is a block-like statement.
 * This checks the last token of the node is the closing brace of a block.
 * @param sourceCode The source code to get tokens.
 * @param node The node to check.
 * @returns `true` if the node is a block-like statement.
 * @private
 */
function isBlockLikeStatement(
  node: ASTNode,
  sourceCode: SourceCode,
): boolean {
  // do-while with a block is a block-like statement.
  if (
    node.type === 'DoWhileStatement'
    && node.body.type === 'BlockStatement'
  ) {
    return true
  }

  /**
   * IIFE is a block-like statement specially from
   * JSCS#disallowPaddingNewLinesAfterBlocks.
   */
  if (isIIFEStatement(node))
    return true

  // Checks the last token is a closing brace of blocks.
  const lastToken = sourceCode.getLastToken(node, isNotSemicolonToken)
  const belongingNode
    = lastToken && isClosingBraceToken(lastToken)
      ? sourceCode.getNodeByRangeIndex(lastToken.range[0])
      : null

  return (
    !!belongingNode
    && (belongingNode.type === 'BlockStatement'
      || belongingNode.type === 'SwitchStatement')
  )
}

/**
 * Check whether the given node is a directive or not.
 * @param node The node to check.
 * @param sourceCode The source code object to get tokens.
 * @returns `true` if the node is a directive.
 */
function isDirective(
  node: ASTNode,
  sourceCode: SourceCode,
): boolean {
  return (
    isTopLevelExpressionStatement(node)
    && node.expression.type === 'Literal'
    && typeof node.expression.value === 'string'
    && !isParenthesized(node.expression, sourceCode)
  )
}

/**
 * Check whether the given node is a part of directive prologue or not.
 * @param node The node to check.
 * @param sourceCode The source code object to get tokens.
 * @returns `true` if the node is a part of directive prologue.
 */
function isDirectivePrologue(
  node: ASTNode,
  sourceCode: SourceCode,
): boolean {
  if (
    isDirective(node, sourceCode)
    && node.parent
    && 'body' in node.parent
    && Array.isArray(node.parent.body)
  ) {
    for (const sibling of node.parent.body) {
      if (sibling === node)
        break

      if (!isDirective(sibling, sourceCode))
        return false
    }
    return true
  }
  return false
}

/**
 * Checks the given node is a CommonJS export statement
 * @param node The node to check.
 * @returns `true` if the node is a CommonJS export statement.
 * @private
 */
function isCJSExport(node: ASTNode): boolean {
  if (node.type === 'ExpressionStatement') {
    const expression = node.expression
    if (expression.type === 'AssignmentExpression') {
      let left = expression.left
      if (left.type === 'MemberExpression') {
        while (left.object.type === 'MemberExpression')
          left = left.object

        return (
          left.object.type === 'Identifier'
          && (left.object.name === 'exports'
            || (left.object.name === 'module'
              && left.property.type === 'Identifier'
              && left.property.name === 'exports'))
        )
      }
    }
  }
  return false
}

/**
 * Check whether the given node is an expression
 * @param node The node to check.
 * @param sourceCode The source code object to get tokens.
 * @returns `true` if the node is an expression
 */
function isExpression(
  node: ASTNode,
  sourceCode: SourceCode,
): boolean {
  return (
    node.type === 'ExpressionStatement'
    && !isDirectivePrologue(node, sourceCode)
  )
}

/**
 * Gets the actual last token.
 *
 * If a semicolon is semicolon-less style's semicolon, this ignores it.
 * For example:
 *
 *     foo()
 *     ;[1, 2, 3].forEach(bar)
 * @param sourceCode The source code to get tokens.
 * @param node The node to get.
 * @returns The actual last token.
 * @private
 */
function getActualLastToken(
  node: ASTNode,
  sourceCode: SourceCode,
): Token | null {
  const semiToken = sourceCode.getLastToken(node)!
  const prevToken = sourceCode.getTokenBefore(semiToken)
  const nextToken = sourceCode.getTokenAfter(semiToken)
  const isSemicolonLessStyle
    = prevToken
      && nextToken
      && prevToken.range[0] >= node.range[0]
      && isSemicolonToken(semiToken)
      && !isTokenOnSameLine(prevToken, semiToken)
      && isTokenOnSameLine(semiToken, nextToken)

  return isSemicolonLessStyle ? prevToken : semiToken
}

/**
 * This returns the concatenation of the first 2 captured strings.
 * @param _ Unused. Whole matched string.
 * @param trailingSpaces The trailing spaces of the first line.
 * @param indentSpaces The indentation spaces of the last line.
 * @returns The concatenation of trailingSpaces and indentSpaces.
 * @private
 */
function replacerToRemovePaddingLines(
  _: string,
  trailingSpaces: string,
  indentSpaces: string,
): string {
  return trailingSpaces + indentSpaces
}

function getReportLoc(node: ASTNode, sourceCode: SourceCode): Location {
  if (isSingleLine(node))
    return node.loc

  const line = node.loc.start.line
  const sourceLine = sourceCode.lines[line - 1]
  if (sourceLine === undefined)
    throw new Error('Padding rule invariant: statement source line is missing')

  return {
    start: node.loc.start,
    end: {
      line,
      column: sourceLine.length,
    },
  }
}

/**
 * Check and report statements for `any` configuration.
 * It does nothing.
 *
 * @private
 */
function verifyForAny(): void {
  // Empty
}

/**
 * Check and report statements for `never` configuration.
 * This autofix removes blank lines between the given 2 statements.
 * However, if comments exist between 2 blank lines, it does not remove those
 * blank lines automatically.
 * @param context The rule context to report.
 * @param _ Unused. The previous node to check.
 * @param nextNode The next node to check.
 * @param paddingLines The array of token pairs that blank
 * lines exist between the pair.
 *
 * @private
 */
function verifyForNever(
  context: RuleContext,
  _: ASTNode,
  nextNode: ASTNode,
  paddingLines: [Token, Token][],
): void {
  if (paddingLines.length === 0)
    return

  context.report({
    node: nextNode,
