import type * as ChannelValues from './visual-channel-values.js';
import type { Props } from './types.js';

export type ChannelBody = { name: string; body?: string; status?: 'none' };
export type VisualChannelWindow = {
  __spChannelValues?: typeof ChannelValues;
  __spChannelNodes?: Map<number, Element>;
  __spChannelHosts?: WeakSet<Element>;
  __spChannelScopesVerified?: boolean;
  __spBeginChannelProof?: () => void;
  __spChannelRequests?: () => { id: number; name: string; pseudo: string }[];
  __spRecordChannelSource?: (name: string, text: string | undefined) => void;
  __spFinishChannelProof?: (verified: boolean) => void;
  __spChannelBodies?: ChannelBody[];
  __spReadChannels?: (elements: Element[], pseudos: string[]) => Map<Element, Record<string, Props>>;
};

/** Installed once per capture; serialized into the page, with no module closures. */
export function installVisualChannels(enabled: boolean): void {
  const target = window as Window & VisualChannelWindow;
  delete target.__spReadChannels;
  delete target.__spChannelBodies;
  delete target.__spBeginChannelProof;
  delete target.__spChannelRequests;
  delete target.__spRecordChannelSource;
  delete target.__spFinishChannelProof;
  delete target.__spChannelNodes;
  delete target.__spChannelHosts;
  delete target.__spChannelScopesVerified;
  if (!enabled) {
    delete target.__spChannelValues;
    return;
  }
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
  const values = target.__spChannelValues;
  if (!values) throw new Error('styleproof: visual channel values are unavailable');
  const fingerprints = new WeakMap<CSSKeyframesRule, string>();
  const sourceFingerprint = (rule: CSSKeyframesRule): string => {
    let text = fingerprints.get(rule);
    if (text === undefined) {
      text = JSON.stringify(
        Array.from(rule.cssRules).map((frame) => {
          const keyframe = frame as CSSKeyframeRule;
          return [keyframe.keyText, keyframe.style.cssText];
        }),
      );
      fingerprints.set(rule, text);
    }
    return text;
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
  type Winner = { rule: CSSKeyframesRule; layer: number[]; order: number };
  type Opaque = { layer: number[]; order: number; names?: Set<string> };
  type Rules = {
    winners: Map<string, Winner>;
    opaque: Opaque[];
    candidates: Map<string, CSSKeyframesRule[]>;
    collisions: Map<string, boolean>;
  };
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
    const result: Rules = { winners: new Map(), opaque: [], candidates: new Map(), collisions: new Map() };
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
      const candidates = result.candidates.get(rule.name) ?? [];
      candidates.push(rule);
      result.candidates.set(rule.name, candidates);
      const layer = rank(path);
      const position = order++;
      const previous = result.winners.get(rule.name);
      if (!previous || wins(layer, previous.layer)) result.winners.set(rule.name, { rule, layer, order: position });
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
  const completeModels = new WeakMap<CSSKeyframesRule, boolean>();
  const modelComplete = (rule: CSSKeyframesRule): boolean => {
    let complete = completeModels.get(rule);
    if (complete === undefined) {
      complete = !Array.from(rule.cssRules).some((frame) =>
        Array.from((frame as CSSKeyframeRule).style).some((property) => property.startsWith('--')),
      );
      completeModels.set(rule, complete);
    }
    return complete;
  };
  const sources = new Map<string, string | undefined>();
  let restoreFreeze: (() => void) | undefined;
  const untraversed = (element: Element): boolean => {
    const pending = [element];
    const seen = new Set<Element>();
    while (pending.length) {
      const node = pending.pop()!;
      if (seen.has(node)) continue;
      seen.add(node);
      if (node.getRootNode() instanceof ShadowRoot || node.shadowRoot || target.__spChannelHosts?.has(node))
        return true;
      if (node.assignedSlot) pending.push(node.assignedSlot);
      if (node.parentElement) pending.push(node.parentElement);
    }
    return false;
  };
  target.__spBeginChannelProof = () => {
    sources.clear();
    target.__spChannelNodes = new Map();
    target.__spChannelHosts = new WeakSet();
    target.__spChannelScopesVerified = false;
    const freeze = (window as Window & { __spFreeze?: CSSStyleSheet }).__spFreeze;
    const disabled = freeze?.disabled;
    if (freeze) freeze.disabled = true;
    restoreFreeze = () => {
      if (freeze) freeze.disabled = disabled!;
    };
  };
  target.__spChannelRequests = () => {
    const requests = new Map<string, { id: number; name: string; pseudo: string }>();
    for (const animation of document.getAnimations()) {
      if (animation instanceof CSSAnimation) animation.pause();
      if (!(animation instanceof CSSAnimation) || !(animation.effect instanceof KeyframeEffect)) continue;
      const element = animation.effect.target;
      if (!(element instanceof Element) || element.getRootNode() !== document || untraversed(element)) continue;
      const pseudo = animation.effect.pseudoElement ?? '';
      if (requests.has(animation.animationName) && pseudo) continue;
      const id = target.__spChannelNodes!.size;
      target.__spChannelNodes!.set(id, element);
      requests.set(animation.animationName, { id, name: animation.animationName, pseudo });
    }
    return [...requests.values()];
  };
  target.__spRecordChannelSource = (name, text) => {
    if (text === undefined) return;
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(text);
      const rule = sheet.cssRules[0];
      if (rule instanceof CSSKeyframesRule) sources.set(name, sourceFingerprint(rule));
    } catch {
      sources.delete(name);
    }
  };
  target.__spFinishChannelProof = (verified) => {
    target.__spChannelScopesVerified = verified;
    target.__spChannelNodes?.clear();
    restoreFreeze?.();
    restoreFreeze = undefined;
  };
  const collides = (rules: Rules, name: string, winner: Winner): boolean => {
    let collision = rules.collisions.get(name);
    if (collision === undefined) {
      const expected = sourceFingerprint(winner.rule);
      collision = (rules.candidates.get(name) ?? []).some(
        (rule) => rule !== winner.rule && sourceFingerprint(rule) === expected,
      );
      rules.collisions.set(name, collision);
    }
    return collision;
  };
  type PseudoAnimations = WeakMap<Element, Map<string, CSSAnimation[]>>;
  const engineBody = (animations: CSSAnimation[] | undefined): string | undefined => {
    if (!animations?.length) return undefined;
    const bodies: string[] = [];
    try {
      for (const animation of animations) {
        const body = values.canonicalEngineKeyframes((animation.effect as KeyframeEffect).getKeyframes());
        if (body === undefined) return undefined;
        bodies.push(body);
      }
    } catch {
      return undefined;
    }
    return bodies.length === 1 ? bodies[0] : '[' + bodies.join(',') + ']';
  };
  const liveAnimations = (
    element: Element,
    pseudo: string,
    index: PseudoAnimations | undefined,
  ): CSSAnimation[] | undefined => {
    if (pseudo) return index?.get(element)?.get(pseudo) ?? (index ? [] : undefined);
    try {
      return element
        .getAnimations({ subtree: false })
        .filter(
          (animation): animation is CSSAnimation =>
            animation instanceof CSSAnimation &&
            animation.effect instanceof KeyframeEffect &&
            animation.effect.target === element &&
            !animation.effect.pseudoElement,
        );
    } catch {
      return undefined;
    }
  };
  const layerProperties = (
    element: Element,
    pseudo: string,
    rules: Rules,
    pseudoAnimations: WeakMap<Element, Map<string, CSSAnimation[]>> | undefined,
  ): Props => {
    const properties: Props = {};
    if (!pseudo && element instanceof HTMLImageElement)
      properties['img currentSrc'] = values.normalizeImageSource(
        element.currentSrc,
        location.origin,
        document.baseURI,
        element.complete,
      );
    const names = new Set(namesOf(getComputedStyle(element, pseudo || null).animationName));
    if (!names.size) return properties;
    const animations = liveAnimations(element, pseudo, pseudoAnimations);
    for (const name of names) {
      const winner = rules.winners.get(name);
      const live = animations?.filter((animation) => animation.animationName === name);
      const resolved = values.resolveEngineBody({
        body: engineBody(live),
        hasLive: animations === undefined || !!live?.length,
        expected: winner ? sourceFingerprint(winner.rule) : undefined,
        matched: sources.get(name),
        ambiguous: untraversed(element) || ambiguous(rules, name) || (!!winner && collides(rules, name, winner)),
        verified: target.__spChannelScopesVerified === true,
        complete: !winner || modelComplete(winner.rule),
      });
      properties[`animation keyframes (${name})`] = reference(name, resolved);
    }
    return properties;
  };
  target.__spReadChannels = (elements, pseudos) => {
    const output = new Map<Element, Record<string, Props>>();
    const freeze = (window as Window & { __spFreeze?: CSSStyleSheet }).__spFreeze;
    const disabled = freeze?.disabled;
    // Read only names while unfrozen, then restore before any used styles/geometry are read.
    if (freeze) freeze.disabled = true;
    try {
      // Chromium excludes pseudo animations from Element.getAnimations({subtree:false}).
      // Index one flat engine read by the originating element, avoiding subtree scans per pseudo.
      let pseudoAnimations: WeakMap<Element, Map<string, CSSAnimation[]>> | undefined = new WeakMap();
      try {
        for (const animation of document.getAnimations()) {
          if (animation instanceof CSSAnimation) animation.pause();
          if (
            !(animation instanceof CSSAnimation) ||
            !(animation.effect instanceof KeyframeEffect) ||
            !animation.effect.pseudoElement
          )
            continue;
          const element = animation.effect.target;
          if (!(element instanceof Element)) continue;
          const byPseudo = pseudoAnimations.get(element) ?? new Map<string, CSSAnimation[]>();
          const pseudo = animation.effect.pseudoElement;
          const animations = byPseudo.get(pseudo) ?? [];
          animations.push(animation);
          byPseudo.set(pseudo, animations);
          pseudoAnimations.set(element, byPseudo);
        }
      } catch {
        pseudoAnimations = undefined;
      }
      for (const element of elements) {
        const root = element.getRootNode() as Document | ShadowRoot;
        const rules = rootRules(root);
        output.set(
          element,
          Object.fromEntries(
            ['', ...pseudos].map((pseudo) => [pseudo, layerProperties(element, pseudo, rules, pseudoAnimations)]),
          ),
        );
      }
    } finally {
      if (freeze) freeze.disabled = disabled!;
    }
    return output;
  };
}
