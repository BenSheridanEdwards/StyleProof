import { expect, test, type Page, type CDPSession } from '@playwright/test';
import { captureStyleMap, diffStyleMaps, type StyleMap } from '../dist/index.js';
import { markInteractiveElements, clearInteractiveMarks } from '../dist/capture/browser.js';
import { captureStateLayerScreenshots } from '../dist/capture/forced-states.js';

async function captureForm(page: Page, selector: string, color: string, body: string): Promise<StyleMap> {
  await page.setContent(`<!doctype html><style>${selector}{color:${color}}</style>${body}`);

  return captureStyleMap(page, { stabilize: false, forcedStateScope: 'stylesheet' });
}

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
  const captured = await captureStyleMap(page, { stabilize: false, maxForcedStateScanWork: 16 });
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
