import type { Props } from './types.js';

export type ChannelBody = { name: string; body?: string; status?: 'none' };
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
  const reference = (name: string, body?: string | null): string => {
    const key = JSON.stringify([name, body === null ? 'none' : body === undefined ? 'unknown' : 'known', body]);
    let id = ids.get(key);
    if (id === undefined) {
      id = String(bodies.length);
      bodies.push({ name, ...(body === null ? { status: 'none' as const } : body === undefined ? {} : { body }) });
      ids.set(key, id);
    }
    return id;
  };
  const percentage = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?%$/i;
  const offsetOf = (text: string): string => {
    const value = text.trim();
    if (value === 'from') return '0%';
    if (value === 'to') return '100%';
    return percentage.test(value) ? `${Number(value.slice(0, -1))}%` : value;
  };
  const offsetOrder = (a: string, b: string): number => {
    const plainA = percentage.test(a),
      plainB = percentage.test(b);
    if (plainA && plainB) return Number.parseFloat(a) - Number.parseFloat(b);
    if (plainA !== plainB) return plainA ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  };
  type Frame = { offset: string; declarations: CSSStyleDeclaration };
  const mergeFrame = (frames: Map<string, Frame>, frame: CSSKeyframeRule): void => {
    for (const offset of frame.keyText.split(',').map(offsetOf)) {
      const key = JSON.stringify([
        offset,
        frame.style.getPropertyValue('animation-timing-function'),
        frame.style.getPropertyValue('animation-composition'),
      ]);
      let merged = frames.get(key);
      if (!merged) frames.set(key, (merged = { offset, declarations: document.createElement('span').style }));
      // Pending var() shorthands expose empty longhands. CSS text preserves them while applying the cascade.
      merged.declarations.cssText += ' ' + frame.style.cssText;
    }
  };
  // Split CSSOM text without splitting quoted/escaped content or function arguments.
  const splitTokens = (text: string, separator: string): string[] => {
    const tokens: string[] = [];
    let start = 0;
    let quote = '';
    let depth = 0;
    for (let index = 0; index < text.length; index++) {
      const character = text[index];
      if (character === '\\') {
        index++;
        continue;
      }
      if (quote) {
        if (character === quote) quote = '';
      } else if (character === '"' || character === "'") quote = character;
      else if ('([{'.includes(character)) depth++;
      else if (')]}'.includes(character)) depth--;
      else if (character === separator && !depth) {
        tokens.push(text.slice(start, index));
        start = index + 1;
      }
    }
    tokens.push(text.slice(start));
    return tokens;
  };
  const declarationText = (style: CSSStyleDeclaration): string =>
    splitTokens(style.cssText, ';')
      .map((declaration) => declaration.trim())
      .filter(Boolean)
      .sort()
      .map((declaration) => `${declaration};`)
      .join(' ');
  const canonicalBody = (rule: CSSKeyframesRule): string => {
    const frames = new Map<string, Frame>();
    for (const child of Array.from(rule.cssRules)) mergeFrame(frames, child as CSSKeyframeRule);
    return [...frames.values()]
      .sort((a, b) => offsetOrder(a.offset, b.offset))
      .map((frame) => `${frame.offset} { ${declarationText(frame.declarations)} }`)
      .join(' ');
  };

  type Winner = { id: string; layer: number[]; order: number };
  type Opaque = { layer: number[]; order: number; names?: Set<string> };
  type Rules = { winners: Map<string, Winner>; opaque: Opaque[] };
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
    const result: Rules = { winners: new Map(), opaque: [] };
    const layers = new Map<string, Map<string, number>>();
    const visiting = new Set<CSSStyleSheet>();
    let anonymous = 0;
    let order = 0;
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
    const opaque = (path: string[], names?: Set<string>): void => {
      result.opaque.push({ layer: rank(path), order: order++, ...(names ? { names } : {}) });
    };
    const conditionalRules = (rule: CSSRule): CSSRuleList | undefined => {
      if (typeof CSSContainerRule !== 'undefined' && rule instanceof CSSContainerRule) return rule.cssRules;
      if (typeof CSSScopeRule !== 'undefined' && rule instanceof CSSScopeRule) return rule.cssRules;
      if (rule instanceof CSSGroupingRule || rule instanceof CSSStyleRule) return rule.cssRules;
      return undefined;
    };
    const opaqueRules = (rules: CSSRuleList, path: string[]): void => {
      const names = new Set<string>();
      const collect = (children: CSSRuleList): void => {
        for (const child of Array.from(children)) {
          if (child instanceof CSSKeyframesRule) names.add(child.name);
          else if (child instanceof CSSImportRule) {
            if (!child.styleSheet) throw new Error('missing conditional import');
            collect(child.styleSheet.cssRules);
          } else {
            const nested = conditionalRules(child);
            if (nested) collect(nested);
          }
        }
      };
      try {
        collect(rules);
        if (names.size) opaque(path, names);
      } catch {
        opaque(path);
      }
    };
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
      const position = order++;
      const previous = result.winners.get(rule.name);
      if (!previous || wins(layer, previous.layer))
        result.winners.set(rule.name, { id: reference(rule.name, canonicalBody(rule)), layer, order: position });
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
      // Walk unsupported conditions for possible names, without serialising every ordinary style rule.
      const conditional = conditionalRules(rule);
      if (conditional?.length) opaqueRules(conditional, path);
    };
    const visit = (rules: CSSRuleList, path: string[]): void => {
      for (const rule of Array.from(rules)) visitRule(rule, path);
    };
    const sheet = (styleSheet: CSSStyleSheet | null, path: string[]): void => {
      if (!styleSheet) {
        opaque(path);
        return;
      }
      if (styleSheet.disabled || visiting.has(styleSheet)) return;
      if (styleSheet.media.mediaText && !matchMedia(styleSheet.media.mediaText).matches) return;
      visiting.add(styleSheet);
      try {
        visit(styleSheet.cssRules, path);
      } catch {
        opaque(path);
      } finally {
        visiting.delete(styleSheet);
      }
    };
    const seen = new Set<CSSStyleSheet>();
    // Missing links do not appear in styleSheets. Keep their position among readable owner nodes.
    for (const node of root.querySelectorAll<HTMLStyleElement | HTMLLinkElement>('style,link[rel~="stylesheet" i]')) {
      if (node.sheet) {
        seen.add(node.sheet);
        sheet(node.sheet, []);
      } else if (node instanceof HTMLLinkElement && !node.disabled && (!node.media || matchMedia(node.media).matches))
        opaque([]);
    }
    for (const styleSheet of Array.from(root.styleSheets)) if (!seen.has(styleSheet)) sheet(styleSheet, []);
    for (const styleSheet of root.adoptedStyleSheets) sheet(styleSheet, []);
    return result;
  };
  const roots = new Map<Document | ShadowRoot, Rules>();
  const rootRules = (root: Document | ShadowRoot): Rules => {
    let rules = roots.get(root);
    if (!rules) roots.set(root, (rules = rulesFor(root)));
    return rules;
  };
  const couldContain = (opaque: Opaque, name: string): boolean => !opaque.names || opaque.names.has(name);
  const beatsOpaque = (winner: Winner, opaque: Opaque): boolean => {
    if (!wins(winner.layer, opaque.layer)) return false;
    return !wins(opaque.layer, winner.layer) || winner.order > opaque.order;
  };
  const ambiguous = (rules: Rules, name: string): boolean => {
    const winner = rules.winners.get(name);
    return rules.opaque.some((opaque) => couldContain(opaque, name) && (!winner || !beatsOpaque(winner, opaque)));
  };
  const escapeCharacter = (_: string, hex: string, character: string): string => {
    if (!hex) return character;
    const point = Number.parseInt(hex, 16);
    return !point || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff) ? '\ufffd' : String.fromCodePoint(point);
  };
  const namesOf = (text: string): string[] =>
    splitTokens(text, ',').flatMap((token) => {
      const value = token.trim();
      if (!value || value === 'none') return [];
      const unquoted = /^("|').*\1$/.test(value) ? value.slice(1, -1) : value;
      return [unquoted.replace(/\\([0-9a-f]{1,6})\s?|\\([^\r\n])/gi, escapeCharacter)];
    });
  const imageSource = (element: HTMLImageElement): string => {
    const source = element.currentSrc;
    if (!source)
      return element.complete && !element.getAttribute('src') && !element.getAttribute('srcset') ? '(no source)' : '';
    const url = new URL(source, document.baseURI);
    if (url.protocol === 'blob:') return '(blob URL; not compared)';
    if (!/^https?:$/.test(url.protocol)) return source;
    const query = url.search.slice(1).split('&');
    const names = query.map((part) => (new URLSearchParams('?' + part).keys().next().value ?? '').toLowerCase());
    const has = (name: string): boolean => names.includes(name);
    const aws = has('x-amz-signature') || has('x-amz-credential');
    const google = has('x-goog-signature') || has('x-goog-credential');
    const signed = has('signature') || has('key-pair-id') || has('awsaccesskeyid');
    const sas = has('sig');
    const retained = query.filter((_, index) => {
      const name = names[index];
      if (name === 'token' || name === 'access_token') return false;
      if (aws && name.startsWith('x-amz-')) return false;
      if (google && name.startsWith('x-goog-')) return false;
      if (signed && /^(?:signature|key-pair-id|awsaccesskeyid|expires|policy)$/.test(name)) return false;
      return !(sas && /^(?:sig|se|sp|sv|st|sr|ss|srt|si|skt|ske|skoid|sktid|sks|skv|sdd|spr)$/.test(name));
    });
    // Keep the original spelling/order of every non-credential field; URLSearchParams.delete re-encodes it.
    if (retained.length !== query.length) url.search = retained.join('&');
    return url.origin === location.origin ? `${url.pathname}${url.search}${url.hash}` : url.href;
  };
  const layerProperties = (element: Element, pseudo: string, rules: Rules, scopes: Rules[]): Props => {
    const values: Props = {};
    if (!pseudo && element instanceof HTMLImageElement) values['img currentSrc'] = imageSource(element);
    for (const name of namesOf(getComputedStyle(element, pseudo || null).animationName)) {
      const winner = rules.winners.get(name);
      // A live name absent from readable rules may come from a closed root or a later stylesheet mutation.
      const unknown =
        (!winner &&
          element
            .getAnimations()
            .some((animation) => animation instanceof CSSAnimation && animation.animationName === name)) ||
        ambiguous(rules, name) ||
        scopes.some((scope) => scope.winners.has(name) || scope.opaque.some((item) => couldContain(item, name)));
      values[`animation keyframes (${name})`] = unknown ? reference(name) : (winner?.id ?? reference(name, null));
    }
    return values;
  };
  target.__spReadChannels = (elements, pseudos) => {
    const output = new Map<Element, Record<string, Props>>();
    const freeze = (window as Window & { __spFreeze?: CSSStyleSheet }).__spFreeze;
    const disabled = freeze?.disabled;
    // Read only names while unfrozen, then restore before any used styles/geometry are read.
    if (freeze) freeze.disabled = true;
    try {
      for (const element of elements) {
        const root = element.getRootNode() as Document | ShadowRoot;
        // Hosts/slotted nodes can reference tree-scoped names; stylesheet provenance is not captured.
        const scopes: Rules[] = [];
        if (element.shadowRoot) scopes.push(rootRules(element.shadowRoot));
        for (let slot = element.assignedSlot; slot; slot = slot.assignedSlot) {
          const slotRoot = slot.getRootNode();
          if (slotRoot instanceof ShadowRoot) scopes.push(rootRules(slotRoot));
        }
        const rules = rootRules(root);
        output.set(
          element,
          Object.fromEntries(
            ['', ...pseudos].map((pseudo) => [pseudo, layerProperties(element, pseudo, rules, scopes)]),
          ),
        );
      }
    } finally {
      if (freeze) freeze.disabled = disabled!;
    }
    return output;
  };
}
