import type * as ChannelValues from './visual-channel-values.js';
import type { Props } from './types.js';

export type ChannelBody = { name: string; body?: string; status?: 'none' };
export type VisualChannelWindow = {
  __spChannelValues?: typeof ChannelValues;
  __spChannelNodes?: Map<number, Element>;
  __spChannelHosts?: WeakSet<Element>;
  __spChannelScopesVerified?: boolean;
  __spBeginChannelProof?: (unfreeze?: boolean) => void;
  __spChannelHostsChecked?: boolean;
  __spChannelSheets?: Set<string>;
  __spChannelRequests?: () => { id: number; name: string; pseudo: string }[];
  __spRecordChannelSource?: (name: string, text: string | undefined) => void;
  __spFinishChannelProof?: (verified: boolean, sheets?: string[]) => void;
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
  delete target.__spChannelHostsChecked;
  delete target.__spChannelSheets;
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
  type Opaque = { layer: number[]; order: number; names?: Set<string>; engine?: string };
  type Rules = {
    winners: Map<string, Winner>;
    opaque: Opaque[];
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
    const opaque = (path: string[], names?: Set<string>, engine?: string): void => {
      result.opaque.push({ layer: rank(path), order: order++, ...(names ? { names } : {}), engine });
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
        opaque(path, undefined, styleSheet.href ?? undefined);
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
  const ambiguous = (rules: Rules, name: string, matched = false): boolean => {
    const winner = rules.winners.get(name);
    return rules.opaque.some(
      (opaque) =>
        !(matched && opaque.engine && target.__spChannelSheets?.has(opaque.engine)) &&
        couldContain(opaque, name) &&
        (!winner || !beatsOpaque(winner, opaque)),
    );
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
  const contextual = new WeakMap<CSSKeyframesRule, boolean>();
  const needsContext = (rule: CSSKeyframesRule): boolean => {
    let result = contextual.get(rule);
    if (result === undefined) {
      result = values.contextDependentKeyframes(
        Array.from(rule.cssRules, (frame) => {
          const { keyText, style } = frame as CSSKeyframeRule;
          return {
            keyText,
            cssText: style.cssText,
            properties: Array.from(style, (name) => [name, style.getPropertyValue(name)] as const),
          };
        }),
      );
      contextual.set(rule, result);
    }
    return result;
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
  type Model = { name: string; body?: string; active: boolean };
  type AnimationIndex = {
    targets: Map<Element, Map<string, Model[]>>;
    counts: WeakMap<Element, number>;
    inherited: WeakMap<Element, boolean>;
  };
  const readModel = (effect: KeyframeEffect): string | undefined => {
    try {
      return values.canonicalEngineKeyframes(effect.getKeyframes());
    } catch {
      return undefined;
    }
  };
  const readAnimationIndex = (): AnimationIndex | undefined => {
    const index: AnimationIndex = { targets: new Map(), counts: new WeakMap(), inherited: new WeakMap() };
    try {
      for (const animation of document.getAnimations()) {
        if (!(animation.effect instanceof KeyframeEffect)) continue;
        const element = animation.effect.target;
        if (!(element instanceof Element)) continue;
        const active = animation.playState === 'running' || animation.playState === 'paused';
        if (active) index.counts.set(element, (index.counts.get(element) ?? 0) + 1);
        if (!(animation instanceof CSSAnimation)) continue;
        const name = animation.animationName;
        const pseudo = animation.effect.pseudoElement ?? '';
        const byPseudo = index.targets.get(element) ?? new Map<string, Model[]>();
        const models = byPseudo.get(pseudo) ?? [];
        models.push({ name, body: readModel(animation.effect), active });
        byPseudo.set(pseudo, models);
        index.targets.set(element, byPseudo);
      }
      return index;
    } catch {
      return undefined;
    }
  };
  const activeAncestor = (element: Element | null, index: AnimationIndex): boolean => {
    const path: Element[] = [];
    let result = false;
    for (let node = element; node; node = node.parentElement) {
      const cached = index.inherited.get(node);
      if (cached !== undefined) {
        result = cached;
        break;
      }
      path.push(node);
      if ((index.counts.get(node) ?? 0) > 0) {
        result = true;
        break;
      }
    }
    for (const node of path) index.inherited.set(node, result);
    return result;
  };
  const otherInput = (element: Element, index: AnimationIndex, live: Model[] | undefined): boolean =>
    (index.counts.get(element) ?? 0) > (live?.some((model) => model.active) ? 1 : 0) ||
    activeAncestor(element.parentElement, index);
  let prepared: AnimationIndex | undefined;
  target.__spChannelHosts = new WeakSet();
  target.__spBeginChannelProof = (unfreeze = false) => {
    sources.clear();
    target.__spChannelNodes = new Map();
    target.__spChannelScopesVerified = false;
    const w = window as Window & { __spFreeze?: CSSStyleSheet; __spAssertFrozen?: () => void };
    const freeze = w.__spFreeze;
    const disabled = freeze?.disabled;
    if (unfreeze) {
      w.__spAssertFrozen?.();
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => sheet !== freeze);
      delete w.__spAssertFrozen;
    } else if (freeze) freeze.disabled = true;
    // Models and request identities are collected before the first protocol round trip.
    // Reading keyframes needs no pause, and never samples currentTime or progress.
    prepared = readAnimationIndex();
    restoreFreeze = () => {
      if (freeze) freeze.disabled = disabled!;
    };
  };
  target.__spChannelRequests = () => {
    const requests = new Map<string, { id: number; name: string; pseudo: string }>();
    for (const [element, byPseudo] of prepared?.targets ?? []) {
      if (element.getRootNode() !== document || untraversed(element)) continue;
      for (const [pseudo, models] of byPseudo)
        for (const { name } of models) {
          if (requests.has(name)) continue;
          const id = target.__spChannelNodes!.size;
          target.__spChannelNodes!.set(id, element);
          requests.set(name, { id, name, pseudo });
        }
    }
    return [...requests.values()];
  };
  target.__spRecordChannelSource = (name, text) => {
    if (text === undefined) return;
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(text);
      const rule = sheet.cssRules[0];
      if (rule instanceof CSSKeyframesRule) {
        sources.set(name, sourceFingerprint(rule));
      }
    } catch {
      sources.delete(name);
    }
  };
  target.__spFinishChannelProof = (verified, sheets) => {
    target.__spChannelSheets = new Set(sheets ?? []);
    target.__spChannelScopesVerified = verified;
    if (verified) target.__spChannelHostsChecked = true;
    target.__spChannelNodes?.clear();
    restoreFreeze?.();
    restoreFreeze = undefined;
  };
  const engineBody = (models: Model[] | undefined): string | undefined => {
    if (!models?.length || models.some((model) => model.body === undefined)) return undefined;
    return models.length === 1 ? models[0].body : '[' + models.map((model) => model.body).join(',') + ']';
  };
  const layerProperties = (
    element: Element,
    pseudo: string,
    rules: Rules,
    index: AnimationIndex | undefined,
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
    const animations = index?.targets.get(element)?.get(pseudo) ?? (index ? [] : undefined);
    for (const name of names) {
      const winner = rules.winners.get(name);
      const live = animations?.filter((animation) => animation.name === name);
      const resolved = values.resolveEngineBody({
        body: engineBody(live),
        hasLive: animations === undefined || !!live?.length,
        expected: winner ? sourceFingerprint(winner.rule) : undefined,
        matched: sources.get(name),
        ambiguous:
          untraversed(element) ||
          ambiguous(rules, name, !!live?.length && !!winner && sourceFingerprint(winner.rule) === sources.get(name)),
        verified: target.__spChannelScopesVerified === true,
        complete:
          !winner ||
          (modelComplete(winner.rule) && !(needsContext(winner.rule) && (!index || otherInput(element, index, live)))),
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
      const index = prepared ?? readAnimationIndex();
      prepared = undefined;
      for (const element of elements) {
        const root = element.getRootNode() as Document | ShadowRoot;
        const rules = rootRules(root);
        output.set(
          element,
          Object.fromEntries(
            ['', ...pseudos].map((pseudo) => [pseudo, layerProperties(element, pseudo, rules, index)]),
          ),
        );
      }
    } finally {
      if (freeze) freeze.disabled = disabled!;
    }
    return output;
  };
}
