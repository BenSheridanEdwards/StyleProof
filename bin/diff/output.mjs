// Console helpers shared by the styleproof-diff output modules.

export const print = (...lines) => lines.forEach((line) => console.log(line));
/** A titled block: the title opens a paragraph, its lines follow. */
export const printSection = (title, lines = []) => print(`\n${title}`, ...lines);
export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
