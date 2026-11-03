// Run by the existing private CI browser fixture, never against a live backend.
// Agent counts are synthetic. Scrolling/activation use native CDP input events.
function readToolbar() {
  const toolbar = document.querySelector('.agent-toolbar');
  const list = toolbar?.querySelector('.agent-toolbar-agent-list');
  if (!list) throw new Error('Missing horizontal agent button viewport');
  const box = (element) => {
    const r = element.getBoundingClientRect();
    return {
      left: r.left,
      right: r.right,
      top: r.top,
      bottom: r.bottom,
      width: r.width,
      height: r.height,
    };
  };
  const viewport = box(list);
  const visible = (element) => {
    const b = box(element);
    return (
      b.width > 0 &&
      b.left >= viewport.left + list.clientLeft - 2 &&
      b.right <= viewport.left + list.clientLeft + list.clientWidth + 2
    );
  };
  const arrow = (direction) => {
    const e = toolbar.querySelector(`[aria-label="Scroll agents ${direction}"]`);
    return (
      e && {
        disabled: e.disabled,
        visible: e.getClientRects().length > 0,
        text: e.textContent.trim(),
        ...box(e),
      }
    );
  };
  const buttons = [...list.querySelectorAll('[data-agent-id]')].map((e) => ({
    id: e.dataset.agentId,
    name: e.textContent.trim(),
    selected: e.getAttribute('aria-pressed') === 'true',
    focused: e === document.activeElement,
    visible: visible(e),
    ...box(e),
  }));
  const fixed = [...toolbar.querySelectorAll('button')]
    .filter((e) => ['New Agent', 'Global'].includes(e.textContent.trim()))
    .map((e) => ({
      name: e.textContent.trim(),
      ...box(e),
    }));
  const opener = document.querySelector('[aria-label="Open system statistics"]');
  const openerBox = opener && box(opener);
  const openerHit =
    openerBox &&
    document.elementFromPoint(
      (openerBox.left + openerBox.right) / 2,
      (openerBox.top + openerBox.bottom) / 2,
    );
  return {
    buttons,
    fixed,
    viewport,
    toolbar: box(toolbar),
    left: arrow('left'),
    right: arrow('right'),
    hasSelect: !!toolbar.querySelector('select'),
    wrap: getComputedStyle(list).flexWrap,
    scrollLeft: list.scrollLeft,
    scrollWidth: list.scrollWidth,
    clientWidth: list.clientWidth,
    pageWidth: document.documentElement.scrollWidth,
    viewportWidth: innerWidth,
    statisticsOpener: opener && {
      ...openerBox,
      reachable: opener.contains(openerHit),
      hitTarget: openerHit?.getAttribute('aria-label') || openerHit?.tagName,
    },
    statistics:
      document.querySelector('.settings-utility-panel')?.getAttribute('aria-hidden') === 'false',
  };
}

export async function auditAgentToolbar({ c, evaluate, wait, pause, click, screenshot, results }) {
  const read = () => evaluate(`(${readToolbar.toString()})()`);
  const fail = (message, receipt) => {
    throw new Error(message + ' ' + JSON.stringify(receipt));
  };
  const resize = async (width) => {
    await c('Emulation.setDeviceMetricsOverride', {
      width,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await pause();
  };
  const statistics = async (open) => {
    if ((await read()).statistics !== open) {
      if (open) await nativeClick('[aria-label="Open system statistics"]');
      else
        await evaluate(
          `document.querySelector('[aria-label="Collapse system statistics"]').click()`,
        );
    }
    await wait(
      `document.querySelector('.settings-utility-panel').getAttribute('aria-hidden')==='${!open}'`,
    );
    await pause();
  };
  const nativeClick = async (selector) => {
    const point = await evaluate(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw new Error('Missing or disabled input target '+${JSON.stringify(selector)});const r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y);if(!r.width||!r.height||!e.contains(hit))throw new Error('Native input target is clipped '+JSON.stringify({selector:${JSON.stringify(selector)},x,y,rect:r.toJSON(),hit:hit?.closest('button')?.getAttribute('aria-label')||hit?.className||hit?.tagName}));return {x,y};})()`,
    );
    await c('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      button: 'left',
      clickCount: 1,
      ...point,
    });
    await c('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      button: 'left',
      clickCount: 1,
      ...point,
    });
    await pause();
  };
  const key = async (name) => {
    const codes = { Home: 36, End: 35, ArrowLeft: 37, ArrowRight: 39, Enter: 13, ' ': 32 };
    const code = { ' ': 'Space' }[name] || name;
    await c('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: name,
      code,
      windowsVirtualKeyCode: codes[name],
      ...(name === ' ' || name === 'Enter' ? { text: name === 'Enter' ? '\r' : ' ' } : {}),
    });
    await c('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: name,
      code,
      windowsVirtualKeyCode: codes[name],
    });
    await pause();
  };
  const assertSelected = async (id, context) => {
    await wait(
      `(()=>{const s=(${readToolbar.toString()})();return s.buttons.some(b=>b.id===${JSON.stringify(id)}&&b.selected&&b.visible);})()`,
    );
    const s = await read();
    if (s.buttons.filter((b) => b.selected).length !== 1)
      fail('Agent selection is not exclusive', { context, ...s });
    return s;
  };
  const scrollToEdge = async (direction, context) => {
    const start = await read();
    let current = start;
    const positions = [current.scrollLeft];
    // Each click must move; the bound exceeds the number of one-button pages.
    for (let i = 0; current[direction]?.visible && !current[direction].disabled; i++) {
      if (i > current.buttons.length + 2)
        fail('Agent arrows never reach the edge', { context, direction, positions });
      const before = current.scrollLeft;
      await nativeClick(`[aria-label="Scroll agents ${direction}"]`);
      await wait(
        `document.querySelector('.agent-toolbar-agent-list').scrollLeft ${direction === 'right' ? '>' : '<'} ${before + (direction === 'right' ? 1 : -1)}`,
      );
      // Allow smooth scrolling and the subsequent ResizeObserver/rAF state update to settle.
      await evaluate(
        `new Promise(resolve=>{const e=document.querySelector('.agent-toolbar-agent-list');let previous=e.scrollLeft,stable=0;const frame=()=>{const value=e.scrollLeft;stable=Math.abs(value-previous)<0.1?stable+1:0;previous=value;if(stable>=5)resolve();else requestAnimationFrame(frame);};requestAnimationFrame(frame);})`,
      );
      current = await read();
      positions.push(current.scrollLeft);
      if (current.buttons.some((b, index) => b.selected !== start.buttons[index].selected))
        fail('Scrolling changed the selected agent', { context, direction, start, current });
    }
    const edge = direction === 'right' ? current.buttons.at(-1) : current.buttons[0];
    if (!edge.visible)
      fail('Agent arrow did not reveal the endpoint', { context, direction, current });
    results.push({ agentArrowScroll: { ...context, direction, positions, endpoint: edge.id } });
    return current;
  };
  const checkGeometry = (s, context) => {
    const overflow = s.scrollWidth > s.clientWidth + 1;
    if (s.hasSelect || s.buttons.length !== context.count || s.wrap !== 'nowrap')
      fail('Agent toolbar must retain one nonwrapping button row', { context, ...s });
    if (s.fixed.length !== 2 || new Set(s.fixed.map((b) => b.name)).size !== 2)
      fail('New Agent or Global was lost', { context, ...s });
    if (!s.statistics && !s.statisticsOpener?.reachable)
      fail('Statistics opener is not reachable', { context, ...s });
    const rows = [...s.buttons, ...s.fixed];
    if (rows.some((b) => Math.abs((b.top + b.bottom) / 2 - (rows[0].top + rows[0].bottom) / 2) > 3))
      fail('Agent toolbar controls wrapped onto different rows', { context, ...s });
    if (
      s.pageWidth > s.viewportWidth + 1 ||
      s.toolbar.right > s.viewportWidth + 1 ||
      s.fixed.some((b) => b.left < s.toolbar.left - 1 || b.right > s.toolbar.right + 1)
    )
      fail('Agent toolbar overflow escaped its scroll viewport', { context, ...s });
    if (overflow !== !!s.left?.visible || overflow !== !!s.right?.visible)
      fail('Agent arrows must follow measured overflow, not count', { context, overflow, ...s });
    if (
      overflow &&
      (s.left.text !== '‹' || s.right.text !== '›' || !s.left.disabled || s.right.disabled)
    )
      fail('Agent arrows or start-edge states are incorrect', { context, ...s });
    for (const arrow of [s.left, s.right].filter((e) => e?.visible))
      if (
        arrow.left < s.toolbar.left - 1 ||
        arrow.right > s.toolbar.right + 1 ||
        s.fixed.some((b) => Math.min(b.right, arrow.right) - Math.max(b.left, arrow.left) > 1)
      )
        fail('Agent arrows overlap fixed controls', { context, ...s });
  };

  await click('Agents', '.settings-prototype-menu button');
  await click('Agent details', '.settings-prototype-section-items button');
  for (const count of [1, 8, 9, 17]) {
    await evaluate(`window.fixtureSetAgentCount(${count})`);
    await wait(`document.querySelectorAll('.agent-toolbar [data-agent-id]').length===${count}`);
    for (const width of [390, 1000, 1910]) {
      await resize(width);
      for (const stats of [false, true]) {
        await statistics(stats);
        await evaluate(`document.querySelector('[data-agent-id="hatchet"]').click()`);
        await assertSelected('hatchet', { count, width, stats });
        await scrollToEdge('left', { count, width, stats });
        const s = await read();
        const context = { count, width, stats };
        checkGeometry(s, context);
        results.push({ agentToolbarMatrix: { ...context, ...s } });
        const end = await scrollToEdge('right', context);
        await nativeClick(`[data-agent-id="${end.buttons.at(-1).id}"]`);
        await assertSelected(end.buttons.at(-1).id, context);
        // Four representative captures, while all 24 combinations receive assertions.
        if (
          (count === 1 && width === 1910 && !stats) ||
          (count === 8 && width === 390 && !stats) ||
          (count === 9 && width === 1910 && stats) ||
          (count === 17 && width === 390 && stats)
        )
          await screenshot(`agent-buttons-${count}-${width}-statistics-${stats ? 'on' : 'off'}`);
        await scrollToEdge('left', context);
        await nativeClick('[data-agent-id="hatchet"]');
        await assertSelected('hatchet', context);
      }
    }
  }

  // A long label must not oscillate between showing and hiding the arrows as
  // the arrows themselves reduce the available button width.
  await evaluate(
    `window.fixtureSetAgentCount(2);window.fixtureSetAgentNames({hatchet:'A very long synthetic agent name that must remain a button',smatchet:'Nix'})`,
  );
  await wait(`document.querySelectorAll('.agent-toolbar [data-agent-id]').length===2`);
  for (const width of [390, 1000, 390]) {
    await resize(width);
    await statistics(false);
    await evaluate(`document.querySelector('[data-agent-id="hatchet"]').click()`);
    await assertSelected('hatchet', 'long label resize');
    const stable = await evaluate(
      `new Promise(resolve=>{const read=${readToolbar.toString()},samples=[];const frame=()=>{const s=read();samples.push({left:!!s.left?.visible,right:!!s.right?.visible,width:s.clientWidth,scrollWidth:s.scrollWidth});if(samples.length===12)resolve(samples);else requestAnimationFrame(frame);};requestAnimationFrame(frame);})`,
    );
    if (stable.some((sample) => JSON.stringify(sample) !== JSON.stringify(stable[0])))
      fail('Long agent label makes overflow arrows oscillate', { width, samples: stable });
    const s = await read();
    checkGeometry(s, { count: 2, width, stats: false, longLabel: true });
    if ((width === 390) !== !!s.right?.visible)
      fail('Long agent label did not follow available width', { width, ...s });
    await scrollToEdge('right', { count: 2, width, longLabel: true });
    await nativeClick('[data-agent-id="smatchet"]');
    await assertSelected('smatchet', 'long label neighbor');
    await scrollToEdge('left', { count: 2, width, longLabel: true });
    await nativeClick('[data-agent-id="hatchet"]');
    await assertSelected('hatchet', 'long label selection');
    results.push({ agentLongLabel: { width, samples: stable, nonwrapping: true } });
  }
  await evaluate(`window.fixtureSetAgentNames({});window.fixtureSetAgentCount(17)`);
  await wait(`document.querySelectorAll('.agent-toolbar [data-agent-id]').length===17`);

  // Selection stays revealed when a wide row is resized and Statistics changes allocation.
  await resize(1910);
  await statistics(false);
  await evaluate(`document.querySelector('[data-agent-id="thistle"]').click()`);
  await assertSelected('thistle', 'before resize');
  await resize(390);
  await assertSelected('thistle', 'after narrow resize');
  await statistics(true);
  await assertSelected('thistle', 'after Statistics opens');
  await statistics(false);

  // Arrow/Home/End navigate focus without changing selection. Native Enter/Space activate.
  await evaluate(`document.querySelector('[data-agent-id="thistle"]').focus()`);
  for (const [pressedKey, expected] of [
    ['Home', 'hatchet'],
    ['ArrowRight', 'smatchet'],
    ['End', 'thistle'],
    ['ArrowLeft', 'snag'],
  ]) {
    await key(pressedKey);
    await wait(
      `(()=>{const s=(${readToolbar.toString()})();return s.buttons.some(b=>b.id===${JSON.stringify(expected)}&&b.focused&&b.visible);})()`,
    );
    const s = await read();
    if (s.buttons.find((b) => b.selected)?.id !== 'thistle')
      fail('Focus navigation changed selection', { pressedKey, ...s });
  }
  await key('Enter');
  await assertSelected('snag', 'keyboard Enter');
  await key('Home');
  await key(' ');
  await assertSelected('hatchet', 'keyboard Space');
  results.push({
    agentKeyboard: {
      focusOnlyArrowsHomeEnd: true,
      enterAndSpaceActivate: true,
      resizeSelectionVisible: true,
    },
  });

  // Dirty document navigation exercises the actual guard for agents, Global and New Agent.
  const documentSelector = '.profile-document-overflow textarea';
  const newAgentSelector = '.agent-toolbar > button';
  const globalSelector = '.agent-toolbar-selector > button';
  for (const destination of ['agent', 'global', 'new']) {
    await evaluate(`document.querySelector('[data-agent-id="hatchet"]').click()`);
    await assertSelected('hatchet', destination);
    await click('Profile documents', '.settings-prototype-section-items button');
    await wait(`!!document.querySelector('${documentSelector}:not(:disabled)')`);
    const draft = `Unsaved toolbar navigation ${destination}`;
    await evaluate(
      `(()=>{const e=document.querySelector('${documentSelector}');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(draft)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await pause();
    const target =
      destination === 'agent'
        ? '[data-agent-id="thistle"]'
        : destination === 'global'
          ? globalSelector
          : newAgentSelector;
    if (destination === 'agent') {
      await scrollToEdge('right', { guard: destination });
      if (await evaluate(`!!document.querySelector('[data-unsaved-changes-modal]')`))
        fail('Scrolling alone opened the unsaved guard', destination);
    }
    await nativeClick(target);
    await wait(`!!document.querySelector('[data-unsaved-changes-modal]')`);
    await click('Stay', '[data-unsaved-changes-modal] button');
    if (
      !(await evaluate(
        `document.querySelector('${documentSelector}')?.value===${JSON.stringify(draft)}&&document.querySelector('[data-agent-id="hatchet"]').getAttribute('aria-pressed')==='true'`,
      ))
    )
      fail('Stay lost the draft or changed the selected agent', destination);
    // Dismissing the modal may reveal the selected agent; scroll the intended target back into view.
    if (destination === 'agent') await scrollToEdge('right', { guard: destination, retry: true });
    await nativeClick(target);
    await wait(`!!document.querySelector('[data-unsaved-changes-modal]')`);
    await click('Discard', '[data-unsaved-changes-modal] button');
    await wait(`!document.querySelector('[data-unsaved-changes-modal]')`);
    if (destination === 'agent') await assertSelected('thistle', 'Discard agent');
    else if (destination === 'global')
      await wait(
        `document.querySelector('${globalSelector}').getAttribute('aria-pressed')==='true'`,
      );
    else {
      await wait(`!!document.querySelector('[aria-label="Close new agent"]')`);
      await nativeClick('[aria-label="Close new agent"]');
    }
    results.push({
      agentUnsavedGuard: { destination, stayRetainsDraft: true, discardNavigates: true },
    });
  }

  await evaluate(`document.querySelector('[data-agent-id="hatchet"]').click()`);
  await assertSelected('hatchet', 'restore');
  await statistics(false);
  await resize(1600);
  await click('Connections', '.settings-prototype-menu button');
}
