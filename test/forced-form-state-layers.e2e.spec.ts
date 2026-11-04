import { expect, test, type Page, type CDPSession } from '@playwright/test';
import {
  captureStyleMap,
  diffStyleMaps,
  diffStyleMapDirs,
  hashDeterminismMap,
  saveStyleMap,
  type StyleMap,
} from '../dist/index.js';
import { markInteractiveElements, clearInteractiveMarks } from '../dist/capture/browser.js';
import { pixelDiffSurface } from '../dist/pixel-diff.js';
import { assessCertificationEvidence } from '../dist/verdict.js';
import { mock } from 'node:test';
import filesystem from 'node:fs';
import path from 'node:path';
import { captureStateLayerScreenshots, captureSurfaceScreenshots } from '../dist/capture/forced-states.js';

type StateProtocolParameters = { expression?: string; forcedPseudoClasses?: string[] };

function interceptStateProtocol(
  page: Page,
  observer: (method: string, parameters: StateProtocolParameters, forward: () => Promise<unknown>) => Promise<unknown>,
): () => void {
  const context = page.context();
  const createSession = context.newCDPSession.bind(context);
  const sessionObserver = mock.method(
    context,
    'newCDPSession',
    async (...argumentsList: Parameters<typeof createSession>) => {
      const session = await createSession(...argumentsList);
      const send = session.send.bind(session);
      // SAFETY: the observer forwards the capture driver's protocol method and unchanged parameter object.
      session.send = (async (method: string, parameters: StateProtocolParameters = {}) =>
        // SAFETY: the protocol method originates from the typed capture driver.
        observer(method, parameters, () =>
          send(method as Parameters<typeof send>[0], parameters),
        )) as CDPSession['send'];
      return session;
    },
  );
  return () => sessionObserver.mock.restore();
}

function isFormBaselineRead(method: string, parameters: StateProtocolParameters): boolean {
  const expression = parameters.expression?.split('\n//# sourceURL=')[0];
  return (
    method === 'Runtime.evaluate' &&
    !!expression?.startsWith('(function snapSessionBaseline(') &&
    expression.includes(', false, window[') &&
    expression.endsWith(', true)')
  );
}

async function captureForm(page: Page, selector: string, color: string, body: string): Promise<StyleMap> {
  await page.setContent(`<!doctype html><style>${selector}{color:${color}}</style>${body}`);

  return captureStyleMap(page, { stabilize: false, forcedStateScope: 'stylesheet' });
}

test('states-disabled captures omit absent target metadata and remain directly hashable', async ({ page }) => {
  await page.setContent('<!doctype html><input type="checkbox">');
  const captured = await captureStyleMap(page, { captureStates: false });
  expect(captured.stateLayers).toEqual([]);
  expect(captured).not.toHaveProperty('stateTargets');
  expect(hashDeterminismMap(captured)).toMatch(/^[a-f0-9]{64}$/);
});

for (const [state, selector, body, changedTarget] of [
  ['checked', 'input:checked', '<input type="checkbox">', 'input'],
  ['checked', 'input:checked + label', '<input type="checkbox"><label>Choice</label>', 'label'],
  ['checked', 'main:has(input:checked) h2', '<main><h2>Choice</h2><input type="checkbox"></main>', 'h2'],
  ['disabled', 'button:disabled', '<button>Continue</button>', 'button'],
  ['placeholder-shown', 'input:placeholder-shown', '<input placeholder="Hint" value="Filled">', 'input'],
] as const) {
  test(`${selector} changes surface in the ${state} layer`, async ({ page }) => {
    const before = await captureForm(page, selector, 'rgb(10, 20, 30)', body);
    const after = await captureForm(page, selector, 'rgb(40, 50, 60)', body);
    expect(before.statesSkipped).toBeFalsy();
    expect(after.statesSkipped).toBeFalsy();
    const findings = diffStyleMaps(before, after);
    expect(findings.some((finding) => finding.kind === 'style')).toBe(false);
    expect(
      findings.some(
        (finding) =>
          finding.kind === 'state' &&
          finding.state === state &&
          finding.sub?.includes(changedTarget) &&
          finding.props.some(
            (property) =>
              property.prop === 'color' &&
              property.before === 'rgb(10, 20, 30)' &&
              property.after === 'rgb(40, 50, 60)',
          ),
      ),
    ).toBe(true);
    const identical = await captureForm(page, selector, 'rgb(40, 50, 60)', body);
    expect(diffStyleMaps(after, identical)).toEqual([]);
  });
}

test('form discovery and screenshots force only applicable controls and restore rest', async ({
  page,
}, testInformation) => {
  await page.setContent(`<!doctype html><style>
    input:checked { outline: 3px solid red }
    button:disabled { color: red }
    input:placeholder-shown { color: blue }
  </style><input type="checkbox"><input type="checkbox" checked><button>Continue</button>
  <button disabled>Unavailable</button><input placeholder="Hint" value="Filled"><input placeholder="Hint">`);

  const marked = await page.evaluate(markInteractiveElements, {
    selector: 'input, button',
    skipSel: '',
    attr: 'data-styleproof-state-id',
  });

  expect(marked.map((control) => control.formStateLayers)).toEqual([
    ['checked', 'disabled'],
    ['disabled'],
    ['disabled'],
    [],
    ['disabled', 'placeholder-shown'],
    ['disabled'],
  ]);
  await page.evaluate(clearInteractiveMarks, 'data-styleproof-state-id');
  const paths = await captureStateLayerScreenshots(page, testInformation.outputPath('form'));
  expect(paths).toHaveLength(6);
  expect(await page.locator('[data-styleproof-state-id]').count()).toBe(0);
  expect(await page.locator('input[type=checkbox]:checked').count()).toBe(1);
  expect(await page.locator('button:disabled').count()).toBe(1);
  expect(await page.locator('input:placeholder-shown').count()).toBe(1);
});

test('pages without form controls retain exactly the legacy force and read cost', async ({ page }) => {
  await page.setContent('<!doctype html><a href="#">Open</a><div role="button">Continue</div>');
  const original = page.context().newCDPSession.bind(page.context());
  const forcedClasses: string[][] = [];
  let scopeReads = 0;
  page.context().newCDPSession = async (...argumentsList: Parameters<typeof original>) => {
    const session = await original(...argumentsList);
    const send = session.send.bind(session);
    // SAFETY: this observer forwards all protocol commands unchanged after recording known fields.
    session.send = (async (method: string, parameters: NonNullable<Parameters<CDPSession['send']>[1]>) => {
      if (
        method === 'CSS.forcePseudoState' &&
        'forcedPseudoClasses' in parameters &&
        Array.isArray(parameters.forcedPseudoClasses) &&
        parameters.forcedPseudoClasses.length
      )
        forcedClasses.push(parameters.forcedPseudoClasses);

      if (
        method === 'Runtime.evaluate' &&
        String('expression' in parameters ? parameters.expression : '').includes('targetMissing: true')
      )
        scopeReads++;

      // SAFETY: the observer forwards the unchanged protocol method received from Playwright.
      return send(method as Parameters<typeof send>[0], parameters);
    }) as CDPSession['send'];

    return session;
  };

  try {
    const captured = await captureStyleMap(page, { stabilize: false });
    expect(captured.statesSkipped).toBeFalsy();
    expect(forcedClasses).toEqual([
      ['hover'],
      ['focus', 'focus-visible'],
      ['active'],
      ['hover'],
      ['focus', 'focus-visible'],
      ['active'],
    ]);
    expect(scopeReads).toBe(8); // Two resting reads plus the six legacy forced reads.
  } finally {
    page.context().newCDPSession = original;
  }
});

test('form reads cannot make a legacy-complete budget set statesSkipped', async ({ page }) => {
  await page.setContent('<!doctype html><style>button:disabled{color:red}</style><button>Continue</button>');

  const captured = await captureStyleMap(page, {
    stabilize: false,
    maxForcedStateScanWork: 16,
    maxFormStateScanWork: 1,
  });
  expect(captured.statesSkipped).toBeFalsy();
  expect(captured.stateLayers).not.toContain('disabled');
  expect(Object.values(captured.states).every((variations) => !('disabled' in variations))).toBe(true);
  expect(Object.values(captured.states).some((variations) => 'focus' in variations)).toBe(true);
});

test('inherited disability, radio checks, and filled textarea applicability use resting browser state', async ({
  page,
}) => {
  await page.setContent(`<!doctype html><fieldset disabled><input><button>Unavailable</button></fieldset>
    <input type="radio"><input type="radio" checked>
    <textarea placeholder="Hint">Filled</textarea><textarea placeholder="Hint"></textarea>`);

  const marked = await page.evaluate(markInteractiveElements, {
    selector: 'input, button, textarea',
    skipSel: '',
    attr: 'data-styleproof-state-id',
  });

  expect(marked.map((control) => control.formStateLayers)).toEqual([
    [],
    [],
    ['checked', 'disabled'],
    ['disabled'],
    ['disabled', 'placeholder-shown'],
    ['disabled'],
  ]);
  await page.evaluate(clearInteractiveMarks, 'data-styleproof-state-id');
});

test('relational form selectors cannot widen the legacy sweep beyond its existing budget', async ({ page }) => {
  await page.setContent(`<!doctype html><style>
    button:hover{color:rgb(10,20,30)}
    main:has(button:disabled) p{color:red}
  </style><main><button>Continue</button>${'<p>Context</p>'.repeat(100)}</main>`);

  const captured = await captureStyleMap(page, {
    stabilize: false,
    forcedStateScope: 'stylesheet',
    maxForcedStateScanWork: 8,
    maxFormStateScanWork: 8,
  });

  expect(captured.statesSkipped).toBeFalsy();
  expect(captured.stateLayers).not.toContain('disabled');
  expect(Object.values(captured.states).some((variations) => 'hover' in variations)).toBe(true);
});

test('wider form scopes replace a shared subtree baseline before reading sibling deltas', async ({ page }) => {
  await page.setContent(`<!doctype html><style>input:checked + label{color:rgb(10,20,30)}</style>
    ${'<input type="checkbox"><label>Choice</label>'.repeat(3)}<p>Unchanged context</p>`);
  const captured = await captureStyleMap(page, { stabilize: false, forcedStateScope: 'stylesheet' });
  expect(captured.statesSkipped).toBeFalsy();
  expect(captured.stateLayers).toContain('checked');
  const controls = Object.values(captured.states).filter((variations) => variations.checked);
  expect(controls).toHaveLength(3);
  for (const variations of controls) {
    expect(Object.keys(variations.checked).some((elementPath) => elementPath.includes('label'))).toBe(true);
    expect(Object.keys(variations.checked).some((elementPath) => elementPath.includes('p:nth-child'))).toBe(false);
  }
});

test('a main-certifying seven-button 790-element page still certifies with form layers', async ({
  page,
}, testInformation) => {
  await page.setContent(`<!doctype html><style>button:disabled{color:red}</style>
    ${'<button>Continue</button>'.repeat(7)}${'<span>Context</span>'.repeat(781)}`);
  const before = await captureStyleMap(page, { stabilize: false });
  const after = await captureStyleMap(page, { stabilize: false });
  expect(Object.keys(before.elements).length).toBeGreaterThanOrEqual(790);
  expect(before.statesSkipped).toBeFalsy();
  expect(before.stateLayers).toContain('disabled');
  const beforeDirectory = testInformation.outputPath('before');
  const afterDirectory = testInformation.outputPath('after');
  saveStyleMap(path.join(beforeDirectory, 'form@1280.json'), before);
  saveStyleMap(path.join(afterDirectory, 'form@1280.json'), after);
  const comparison = diffStyleMapDirs(beforeDirectory, afterDirectory);
  expect(comparison.statesUncertified).toBe(0);
  expect(
    assessCertificationEvidence({
      sourceBinding: { status: 'bound' },
      coverage: { basis: 'complete' },
      determinism: { status: 'proven' },
      statesUncertified: comparison.statesUncertified,
    }).certifies,
  ).toBe(true);
});

for (const [state, selector, beforeBody, afterBody] of [
  ['disabled', 'button:disabled', '<button>Continue</button>', '<button disabled>Continue</button>'],
  ['checked', 'input:checked', '<input type="checkbox">', '<input type="checkbox" checked>'],
  [
    'placeholder-shown',
    'input:placeholder-shown',
    '<input placeholder="Hint">',
    '<input placeholder="Hint" value="Filled">',
  ],
] as const) {
  test(`${state} applicability changes compare rest without false state drops or missing pixel layers`, async ({
    page,
  }, testInformation) => {
    const maps: StyleMap[] = [];
    const directories = [testInformation.outputPath('before'), testInformation.outputPath('after')];

    for (const [index, body] of [beforeBody, afterBody].entries()) {
      maps.push(await captureForm(page, selector, 'rgb(10, 20, 30)', body));
      filesystem.mkdirSync(directories[index], { recursive: true });
      await captureSurfaceScreenshots(page, path.join(directories[index], 'form@1280'));

      for (const layer of maps[index].stateLayers ?? [])
        expect(filesystem.existsSync(path.join(directories[index], `form@1280.${layer}.png`))).toBe(true);
    }

    expect(
      diffStyleMaps(maps[0], maps[1]).filter((finding) => finding.kind === 'state' && finding.state === state),
    ).toEqual([]);
    expect(pixelDiffSurface(directories[0], directories[1], 'form@1280', maps[0], maps[1]).uncompared).toEqual([]);

    if (state !== 'placeholder-shown')
      expect(diffStyleMaps(maps[0], maps[1]).some((finding) => finding.kind === 'style')).toBe(true);
  });
}

test('placeholder applicability excludes impossible input types and all hidden inputs', async ({ page }) => {
  const supported = ['', 'text', 'search', 'url', 'tel', 'email', 'password', 'number', 'invalid-type'];

  const unsupported = [
    'checkbox',
    'radio',
    'color',
    'date',
    'datetime-local',
    'month',
    'time',
    'week',
    'range',
    'file',
    'hidden',
  ];

  const inputValues: Record<string, string> = {
    date: '2026-01-01',
    'datetime-local': '2026-01-01T12:00',
    month: '2026-01',
    week: '2026-W01',
    time: '12:00',
  };

  await page.setContent(
    `<!doctype html>${[...supported, ...unsupported]
      .map(
        (type) =>
          `<input ${type ? `type="${type}"` : ''} placeholder="Hint" ${type === 'file' ? '' : `value="${inputValues[type] ?? '1'}"`}>`,
      )
      .join('')}<textarea placeholder="Hint">Filled</textarea>`,
  );

  const marked = await page.evaluate(markInteractiveElements, {
    selector: 'input, textarea',
    skipSel: '',
    attr: 'data-styleproof-state-id',
  });

  expect(marked).toHaveLength(supported.length + unsupported.length);

  for (const control of marked.slice(0, supported.length))
    expect(control.formStateLayers).toContain('placeholder-shown');

  for (const control of marked.slice(supported.length, -1))
    expect(control.formStateLayers).not.toContain('placeholder-shown');
  expect(marked.at(-1)?.formStateLayers).toContain('placeholder-shown');
  expect(await page.locator('input[type=hidden][data-styleproof-state-id]').count()).toBe(0);
  await page.evaluate(clearInteractiveMarks, 'data-styleproof-state-id');
});

test('a dropped form layer also drops its Typed OM margin proof', async ({ page }) => {
  await page.setContent(
    '<!doctype html><style>input:checked{margin-left:30px}input:disabled{margin-left:40px}</style><input type="checkbox"><input type="checkbox">',
  );
  const complete = await captureStyleMap(page, { stabilize: false });
  expect(
    Object.values(complete.stateComputedValueStyle ?? {}).some(
      (variations) => variations.checked && variations.disabled,
    ),
  ).toBe(true);
  const captured = await captureStyleMap(page, { stabilize: false, maxFormStateScanWork: 20 });
  expect(captured.stateLayers).not.toContain('checked');
  expect(
    Object.values(captured.stateComputedValueStyle ?? {}).every(
      (variations) => !variations.checked && !variations.disabled,
    ),
  ).toBe(true);
  expect(Object.values(captured.states).every((variations) => !variations.checked && !variations.disabled)).toBe(true);
});

test('resting drift after form forcing discards every form layer and its proof', async ({ page }) => {
  await page.setContent('<!doctype html><style>button:disabled{margin-left:30px}</style><button>Continue</button>');
  const original = page.context().newCDPSession.bind(page.context());
  const warnings: string[] = [];
  const warningSpy = mock.method(console, 'warn', (message: unknown) => warnings.push(String(message)));
  page.context().newCDPSession = async (...argumentsList: Parameters<typeof original>) => {
    const session = await original(...argumentsList);
    const send = session.send.bind(session);
    let formForced = false;
    // SAFETY: this observer forwards the same protocol method and parameters, then mutates a fixture style once.
    session.send = (async (method: string, parameters: { forcedPseudoClasses?: string[] }) => {
      // SAFETY: the unchanged protocol method was supplied by the capture driver.
      const result = await send(method as Parameters<typeof send>[0], parameters);

      if (method === 'CSS.forcePseudoState' && parameters.forcedPseudoClasses?.includes('disabled')) formForced = true;

      if (method === 'CSS.forcePseudoState' && formForced && parameters.forcedPseudoClasses?.length === 0) {
        formForced = false;
        await page.evaluate(() => {
          document.body.style.backgroundColor = 'rgb(1, 2, 3)';
        });
      }

      return result;
    }) as CDPSession['send'];

    return session;
  };

  try {
    const captured = await captureStyleMap(page, { stabilize: false });
    expect(captured.statesSkipped).toBeFalsy();
    expect(captured.stateLayers).toEqual(['hover', 'focus', 'active']);
    expect(warnings.some((warning) => warning.includes('resting styles changed after form-state'))).toBe(true);
    expect(Object.values(captured.stateComputedValueStyle ?? {}).every((variations) => !variations.disabled)).toBe(
      true,
    );
  } finally {
    page.context().newCDPSession = original;
    warningSpy.mock.restore();
  }
});

test('stylesheet scope is analysed once and emits one fallback warning', async ({ page }) => {
  await page.setContent(
    '<!doctype html><style>main:has(input:checked) label{color:red}</style><main><input type="checkbox"><label>Choice</label></main>',
  );
  const warnings: string[] = [];
  const warningSpy = mock.method(console, 'warn', (message: unknown) => warnings.push(String(message)));
  const evaluate = page.evaluate.bind(page);
  let analyses = 0;

  const evaluationSpy = mock.method(page, 'evaluate', (operation, ...parameters) => {
    if (operation.name === 'analyzeForcedStateScope') analyses++;

    return evaluate(operation, ...parameters);
  });

  try {
    await captureStyleMap(page, { stabilize: false, forcedStateScope: 'stylesheet' });
    expect(analyses).toBe(1);
    expect(warnings.filter((warning) => warning.includes('fell back to whole-document'))).toHaveLength(1);
    expect(warnings.some((warning) => warning.includes('whole-document form-state reads'))).toBe(true);
  } finally {
    evaluationSpy.mock.restore();
    warningSpy.mock.restore();
  }
});

test('a stylesheet-widened 1500-element twelve-checkbox page retains main certification', async ({
  page,
}, testInformation) => {
  await page.setContent(`<!doctype html><style>label:has(input:checked){color:red}</style>
    ${'<label><input type="checkbox">Choice</label>'.repeat(12)}${'<span>Context</span>'.repeat(1474)}`);
  const warnings: string[] = [];
  const warningSpy = mock.method(console, 'warn', (message: unknown) => warnings.push(String(message)));
  try {
    const before = await captureStyleMap(page, { stabilize: false, forcedStateScope: 'stylesheet' });
    const after = await captureStyleMap(page, { stabilize: false, forcedStateScope: 'stylesheet' });
    expect(Object.keys(before.elements).length).toBeGreaterThanOrEqual(1500);
    expect(before.statesSkipped).toBeFalsy();
    expect(before.stateLayers).not.toContain('checked');
    expect(before.stateLayerOmissions?.checked).toBe('form-scan-work');
    expect(warnings.some((warning) => warning.includes('Raise maxFormStateScanWork'))).toBe(true);
    const beforeDirectory = testInformation.outputPath('before');
    const afterDirectory = testInformation.outputPath('after');
    saveStyleMap(path.join(afterDirectory, 'form@1280.json'), after);
    const legacy = { ...before };
    delete legacy.stateLayers;
    delete legacy.stateLayerOmissions;
    delete legacy.stateTargets;
    for (const beforeMap of [before, legacy]) {
      saveStyleMap(path.join(beforeDirectory, 'form@1280.json'), beforeMap);
      const comparison = diffStyleMapDirs(beforeDirectory, afterDirectory);
      expect(comparison.statesUncertified).toBe(0);
      expect(comparison.counts).toEqual({ dom: 0, style: 0, state: 0 });
      expect(
        assessCertificationEvidence({
          sourceBinding: { status: 'bound' },
          coverage: { basis: 'complete' },
          determinism: { status: 'proven' },
          statesUncertified: comparison.statesUncertified,
        }).certifies,
      ).toBe(true);
    }
  } finally {
    warningSpy.mock.restore();
  }
});

test('a missing shared form baseline skips every form force and retains legacy proof', async ({ page }) => {
  await page.setContent(`<!doctype html><style>input:hover{margin-left:30px}label:has(input:checked){color:red}</style>
    ${'<label><input type="checkbox">Choice</label>'.repeat(3)}`);
  const warnings: string[] = [];
  const warningSpy = mock.method(console, 'warn', (message: unknown) => warnings.push(String(message)));
  let formForces = 0;
  const restore = interceptStateProtocol(page, async (method, parameters, forward) => {
    if (isFormBaselineRead(method, parameters)) return { result: { value: false } };
    if (
      method === 'CSS.forcePseudoState' &&
      parameters.forcedPseudoClasses?.some((stateName) =>
        ['checked', 'disabled', 'placeholder-shown'].includes(stateName),
      )
    )
      formForces++;
    return forward();
  });
  try {
    const captured = await captureStyleMap(page, { stabilize: false, forcedStateScope: 'stylesheet' });
    expect(formForces).toBe(0);
    expect(captured.stateLayerOmissions?.checked).toBe('shared-baseline-unavailable');
    expect(captured.stateLayers).toEqual(['hover', 'focus', 'active']);
    expect(warnings.some((warning) => warning.includes('no shared resting baseline for form-state reads'))).toBe(true);
    expect(Object.values(captured.stateComputedValueStyle ?? {}).some((variations) => variations.hover)).toBe(true);
  } finally {
    restore();
    warningSpy.mock.restore();
  }
});

test('unavailable form Typed OM never erases legacy proof or invents form proof', async ({ page }) => {
  await page.setContent(`<!doctype html><style>input:hover{margin-left:30px}label:has(input:checked){margin-left:40px}</style>
    ${'<label><input type="checkbox">Choice</label>'.repeat(3)}`);
  const restore = interceptStateProtocol(page, async (method, parameters, forward) => {
    if (isFormBaselineRead(method, parameters))
      await page.evaluate(() => {
        Object.defineProperty(Element.prototype, 'computedStyleMap', { value: undefined, configurable: true });
      });
    return forward();
  });
  try {
    const captured = await captureStyleMap(page, { stabilize: false, forcedStateScope: 'stylesheet' });
    expect(captured.stateLayers).toContain('checked');
    expect(Object.values(captured.states).some((variations) => variations.checked)).toBe(true);
    expect(Object.values(captured.stateComputedValueStyle ?? {}).some((variations) => variations.hover)).toBe(true);
    expect(
      Object.values(captured.stateComputedValueStyle ?? {}).every(
        (variations) => !variations.checked && !variations.disabled,
      ),
    ).toBe(true);
  } finally {
    restore();
  }
});

test('inapplicable form screenshot layers copy the resting PNG without more screenshots', async ({
  page,
}, testInformation) => {
  await page.setContent('<!doctype html><a href="#">Continue</a>');
  const screenshotSpy = mock.method(page, 'screenshot', page.screenshot.bind(page));
  const stem = testInformation.outputPath('form@1280');
  try {
    await captureSurfaceScreenshots(page, stem);
    expect(screenshotSpy.mock.callCount()).toBe(4);
    for (const stateName of ['checked', 'disabled', 'placeholder-shown'])
      expect(filesystem.readFileSync(`${stem}.${stateName}.png`).equals(filesystem.readFileSync(`${stem}.png`))).toBe(
        true,
      );
  } finally {
    screenshotSpy.mock.restore();
  }
});

test('a tiny form allowance clamps cached baseline charges and reports budget exhaustion', async ({ page }) => {
  await page.setContent(`<!doctype html>${'<button><span>Continue</span></button>'.repeat(3)}`);
  const warnings: string[] = [];
  const warningSpy = mock.method(console, 'warn', (message: unknown) => warnings.push(String(message)));
  try {
    const captured = await captureStyleMap(page, {
      stabilize: false,
      forcedStateScope: 'stylesheet',
      maxFormStateScanWork: 1,
    });
    expect(captured.statesSkipped).toBeFalsy();
    expect(captured.stateLayers).not.toContain('disabled');
    expect(warnings.some((warning) => warning.includes('exhausted maxFormStateScanWork=1'))).toBe(true);
    expect(warnings.some((warning) => warning.includes('resting styles changed'))).toBe(false);
  } finally {
    warningSpy.mock.restore();
  }
});
