import type { Props } from './types.js';

export type ChannelBody = { name: string; body?: string };
export type VisualChannelWindow = {
  __spChannelBodies?: ChannelBody[];
  __spReadChannels?: (elements: Element[], pseudos: string[]) => Map<Element, Record<string, Props>>;
};

/** Installed once per capture; serialized into the page, with no module closures. */
export function installVisualChannels(enabled: boolean): void {
  const target = window as Window & VisualChannelWindow;
  delete target.__spReadChannels;
  delete target.__spChannelBodies;
  if (!enabled) return;
  const bodies: ChannelBody[] = [];
  const ids = new Map<string, string>();
  target.__spChannelBodies = bodies;
  const reference = (name: string, body?: string): string => {
    const key = JSON.stringify([name, body]);
    let id = ids.get(key);
    if (id === undefined) {
      id = String(bodies.length);
      bodies.push({ name, ...(body === undefined ? {} : { body }) });
      ids.set(key, id);
    }
    return id;
  };
  const canonicalBody = (rule: CSSKeyframesRule): string =>
    Array.from(rule.cssRules)
      .map((child) => {
        const frame = child as CSSKeyframeRule;
        const selectors = frame.keyText
          .split(',')
          .map((key) => {
            const value = key.trim();
            return value === 'from' ? '0%' : value === 'to' ? '100%' : `${Number.parseFloat(value)}%`;
          })
          .sort((a, b) => Number.parseFloat(a) - Number.parseFloat(b));
        const declarations = Array.from(frame.style)
          .sort()
          .map(
            (property) =>
              `${property}: ${frame.style.getPropertyValue(property)}${frame.style.getPropertyPriority(property) ? ' !important' : ''};`,
          );
        return `${selectors.join(', ')} { ${declarations.join(' ')} }`;
      })
      .join(' ');

  type Winner = { id: string; layer: number[] };
  type Rules = { winners: Map<string, Winner>; unknown: boolean };
  // Normal cascade layers: later siblings win, and a parent's unlayered rules win over its children.
  const wins = (next: number[], previous: number[]): boolean => {
    for (let index = 0; index < Math.max(next.length, previous.length); index++) {
      const a = next[index] ?? Infinity;
      const b = previous[index] ?? Infinity;
      if (a !== b) return a > b;
    }
    return true;
  };
  const rulesFor = (root: Document | ShadowRoot): Rules => {
    const result: Rules = { winners: new Map(), unknown: false };
    for (const link of root.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet" i]')) {
      if (!link.sheet && !link.disabled && (!link.media || matchMedia(link.media).matches)) result.unknown = true;
    }
    const layers = new Map<string, Map<string, number>>();
    const visiting = new Set<CSSStyleSheet>();
    let anonymous = 0;
    const layerPath = (parent: string[], name: string): string[] => [
      ...parent,
      ...(name ? name.split('.') : [`#${anonymous++}`]),
    ];
    const rank = (path: string[]): number[] =>
      path.map((name, index) => {
        const key = JSON.stringify(path.slice(0, index));
        let siblings = layers.get(key);
        if (!siblings) layers.set(key, (siblings = new Map()));
        if (!siblings.has(name)) siblings.set(name, siblings.size);
        return siblings.get(name)!;
      });
    const visitImport = (rule: CSSImportRule, path: string[]): void => {
      if (rule.media.mediaText && !matchMedia(rule.media.mediaText).matches) return;
      const imported = rule as CSSImportRule & { supportsText?: string; layerName?: string | null };
      if (imported.supportsText && !CSS.supports(imported.supportsText)) return;
      const next = imported.layerName == null ? path : layerPath(path, imported.layerName);
      rank(next);
      sheet(rule.styleSheet, next);
    };
    const recordKeyframes = (rule: CSSKeyframesRule, path: string[]): void => {
      const layer = rank(path);
      const previous = result.winners.get(rule.name);
      if (!previous || wins(layer, previous.layer))
        result.winners.set(rule.name, { id: reference(rule.name, canonicalBody(rule)), layer });
    };
    const visitRule = (rule: CSSRule, path: string[]): void => {
      if (rule instanceof CSSKeyframesRule) return recordKeyframes(rule, path);
      if (rule instanceof CSSImportRule) return visitImport(rule, path);
      if (rule instanceof CSSMediaRule) {
        if (matchMedia(rule.conditionText).matches) visit(rule.cssRules, path);
        return;
      }
      if (rule instanceof CSSSupportsRule) {
        if (CSS.supports(rule.conditionText)) visit(rule.cssRules, path);
        return;
      }
      if (rule.constructor.name === 'CSSLayerStatementRule') {
        const names = (rule as CSSRule & { nameList: string[] }).nameList;
        for (const name of names) rank(layerPath(path, name));
        return;
      }
      if (rule.constructor.name === 'CSSLayerBlockRule') {
        const block = rule as CSSRule & { name: string; cssRules: CSSRuleList };
        const next = layerPath(path, block.name);
        rank(next);
        visit(block.cssRules, next);
        return;
      }
      // Container/scope conditions cannot be proved from a global CSSOM walk.
      if ('cssRules' in rule && /@(?:-[a-z]+-)?keyframes\b/i.test(rule.cssText)) result.unknown = true;
    };
    const visit = (rules: CSSRuleList, path: string[]): void => {
      for (const rule of Array.from(rules)) visitRule(rule, path);
    };
    const sheet = (styleSheet: CSSStyleSheet | null, path: string[]): void => {
      if (!styleSheet) {
        result.unknown = true;
        return;
      }
      if (styleSheet.disabled || visiting.has(styleSheet)) return;
      if (styleSheet.media.mediaText && !matchMedia(styleSheet.media.mediaText).matches) return;
      visiting.add(styleSheet);
      try {
        visit(styleSheet.cssRules, path);
      } catch {
        result.unknown = true;
      } finally {
        visiting.delete(styleSheet);
      }
    };
    for (const styleSheet of [...Array.from(root.styleSheets), ...root.adoptedStyleSheets]) sheet(styleSheet, []);
    return result;
  };
  // Animation names can be strings containing commas or escapes; do not split their contents.
  const splitNames = (text: string): string[] => {
    const tokens: string[] = [];
    let start = 0;
    let quote = '';
    for (let index = 0; index < text.length; index++) {
      const character = text[index];
      if (character === '\\') {
        index++;
        continue;
      }
      if (quote) {
        if (character === quote) quote = '';
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        continue;
      }
      if (character === ',') {
        tokens.push(text.slice(start, index));
        start = index + 1;
      }
    }
    tokens.push(text.slice(start));
    return tokens;
  };
  const escapeCharacter = (_: string, hex: string, character: string): string => {
    if (!hex) return character;
    const point = Number.parseInt(hex, 16);
    return !point || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff) ? '\ufffd' : String.fromCodePoint(point);
  };
  const namesOf = (text: string): string[] =>
    splitNames(text).flatMap((token) => {
      const value = token.trim();
      if (!value || value === 'none') return [];
      const unquoted = /^("|').*\1$/.test(value) ? value.slice(1, -1) : value;
      return [unquoted.replace(/\\([0-9a-f]{1,6})\s?|\\([^\r\n])/gi, escapeCharacter)];
    });
  const imageSource = (element: HTMLImageElement): string => {
    const source = element.currentSrc;
    const url = source ? new URL(source, document.baseURI) : undefined;
    return url && /^https?:$/.test(url.protocol) && url.origin === location.origin
      ? `${url.pathname}${url.search}${url.hash}`
      : source;
  };
  const layerProperties = (element: Element, pseudo: string, rules: Rules, shadow?: Rules): Props => {
    const values: Props = {};
    if (!pseudo && element instanceof HTMLImageElement) values['img currentSrc'] = imageSource(element);
    for (const name of namesOf(getComputedStyle(element, pseudo || null).animationName)) {
      const winner = rules.winners.get(name);
      const unknown = rules.unknown || shadow?.unknown || shadow?.winners.has(name);
      values[`animation keyframes (${name})`] = unknown || !winner ? reference(name) : winner.id;
    }
    return values;
  };
  target.__spReadChannels = (elements, pseudos) => {
    const output = new Map<Element, Record<string, Props>>();
    const roots = new Map<Document | ShadowRoot, Rules>();
    const rootRules = (root: Document | ShadowRoot): Rules => {
      let rules = roots.get(root);
      if (!rules) roots.set(root, (rules = rulesFor(root)));
      return rules;
    };
    const freeze = (window as Window & { __spFreeze?: CSSStyleSheet }).__spFreeze;
    const disabled = freeze?.disabled;
    // Read only names while unfrozen, then restore before any used styles/geometry are read.
    if (freeze) freeze.disabled = true;
    try {
      for (const element of elements) {
        const root = element.getRootNode() as Document | ShadowRoot;
        // Hosts can reference tree-scoped names, but their internals remain untraversed.
        const shadow = element.shadowRoot ? rootRules(element.shadowRoot) : undefined;
        const rules = rootRules(root);
        output.set(
          element,
          Object.fromEntries(
            ['', ...pseudos].map((pseudo) => [pseudo, layerProperties(element, pseudo, rules, shadow)]),
          ),
        );
      }
    } finally {
      if (freeze) freeze.disabled = disabled!;
    }
    return output;
  };
}
