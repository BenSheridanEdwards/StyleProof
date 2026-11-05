/** Deliberate raw-text over-approximation: lexical contents are not excluded. */
const FUNCTION_STAR = /function(?:\s|\/\*(?:[^*]|\*(?!\/))*\*\/|\/\/[^\r\n\u2028\u2029]*)*\*/;
const METHOD_STAR = /\*\s*(?:#?[\w$]+|\[[^\]\n]*\]|'[^'\n]*'|"[^"\n]*"|\d[\w.]*)\s*(?:<[^()\n]*>\s*)?\(/;

export function sourceContainsGenerator(text: string): boolean {
  return FUNCTION_STAR.test(text) || METHOD_STAR.test(text);
}
