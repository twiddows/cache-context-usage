import { expect, mock, test } from 'claude-code/testing'

import { itemAt } from '../hooks/tray'
import { cacheColor, cacheIcon, ctxColor, handoffPath, jobTitles, paceColor, resetLabel, usageFromLimits, weekElapsed, worstColor, lastLines, openCommand, pickAction, pickStyle, pressItem, shownItems, span, tailCommand } from '../hooks/register'

const PLUGIN = 'cache-context-usage'
const BAND = { plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 } } } as any
const DESKTOP_BAND = { ...BAND, surface: 'desktop' }
const MIN = 60_000

// The engine beneath the mod: the band draws nothing of its own
function engine(on: any) {
  on('ui.render', () => ({ type: 'Text', children: [''] }) as never)
  on('turn.step', async function* (_$: any, e: any) { return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] } as any })
  on('session.measure', () => ({ changed: [] }) as never)
}

// An interactive session start with these env vars, so loadConfig reads them
async function start($: any, on: any, env: Record<string, string>) {
  mock.store(on, {})
  mock.env(on, env)
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { context: 0 } }) as never)
  on('clock.every', () => ({ value: undefined }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  await $.session.start({ cwd: '/nowhere', surface: 'terminal', isInteractive: true })
}

// One main-session model request, which starts the cache clock
async function request($: any) {
  const step = $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 } as any)
  for await (const _ of step);
}

// The details at the left of the line, or undefined while they are closed
async function details($: any, at = BAND) {
  const ui = await $.ui.mount(at)
  return (await ui.find({ type: 'Text', text: /◷|ctx/ } as any))?.text
}

// A click on a tray icon
async function click($: any, key: string, at = BAND) {
  await (await $.ui.mount(at)).press({ key } as any)
}

// The cache piece of /cache-clock: '10:00 left', 'cold', ... whatever the line shows
async function cachePiece($: any) {
  const r: any = await $.command.run({ command: 'cache-clock', args: '' } as any)
  return String(r.text).split(' (')[0]
}

// The tray, the default: icons at the right, every session starting closed

test('tray: closed at the start, two icons and no details', async ($, on) => {
  on('clock.now', () => ({ value: 1_000_000 }))
  engine(on)
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ key: 'cache' } as any)).toBeDefined()
  expect(await ui.find({ key: 'context' } as any)).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /◷|ctx/ } as any)).toBeUndefined()
})

test('tray: a click on cache opens its details, a second click closes them', async ($, on) => {
  let now = 1_000_000
  on('clock.now', () => ({ value: now }))
  engine(on)
  await request($)
  now += 10 * MIN
  await click($, 'cache')
  const open = String(await details($))
  expect(open).toContain('◷ cache 50:00 left')
  expect(open).toContain('1h ttl')
  expect(open).not.toContain('ctx')
  await click($, 'cache')
  expect(await details($)).toBeUndefined()
})

test('tray: a click on context shows the context, and a click on cache switches to it', async ($, on) => {
  on('clock.now', () => ({ value: 1_000_000 }))
  engine(on)
  await click($, 'context')
  expect(await details($)).toBe('ctx --')
  await click($, 'cache')
  expect(String(await details($))).toContain('◷ cache: no request yet')
})

// The tray colours, in order (cache, context, usage): the dots in front on the terminal, the
// icons' own text on the desktop; unlit icons left out
async function dots($: any, at = BAND) {
  const ui = await $.ui.mount(at)
  const out: string[] = []
  const inTray = at.surface === 'desktop' ? { in: 'tray' } : {}
  for (const item of ['cache', 'context', 'usage']) {
    const t: any = await ui.find({ type: 'Text', text: new RegExp('^(.+ )?' + item + '$'), ...inTray } as any)
    const color = t?.props?.color ?? t?.color
    if (color) out.push(color)
  }
  if (out.length) return out
  const found: any[] = (await (ui as any).findAll?.({ type: 'Text', text: /●/ } as any)) ?? [await ui.find({ type: 'Text', text: /●/ } as any)].filter(Boolean)
  return found.map((t) => t.props?.color ?? t.color)
}

// A context reading, as the engine pushes one after each turn
async function measure($: any, _on: any, percent: number) {
  await $.session.measure({ context: { tokens: percent * 10_000, window: 1_000_000, percent }, rateLimits: [] } as any)
}

test('tray: the cache text turns yellow at 30 minutes left, closed', async ($, on) => {
  let now = 1_000_000
  on('clock.now', () => ({ value: now }))
  engine(on)
  await request($)
  now += 29 * MIN
  expect(await dots($)).toEqual([])
  now += 1 * MIN
  expect(await dots($)).toEqual(['yellow'])
  expect(await details($)).toBeUndefined()
})

test('tray: at 15 minutes left the cache text turns red and the details open by themselves, until the next request', async ($, on) => {
  let now = 1_000_000
  on('clock.now', () => ({ value: now }))
  engine(on)
  await request($)
  now += 44 * MIN
  expect(await details($)).toBeUndefined()
  now += 1 * MIN
  expect(await dots($)).toEqual(['red'])
  expect(String(await details($))).toContain('◷ cache 15:00 left')
  await request($)
  expect(await details($)).toBeUndefined()
  expect(await dots($)).toEqual([])
})

test('tray: a cold cache stays red and open', async ($, on) => {
  let now = 1_000_000
  on('clock.now', () => ({ value: now }))
  engine(on)
  await request($)
  now += 70 * MIN
  expect(await dots($)).toEqual(['red'])
  expect(String(await details($))).toContain('◷ cache cold')
})

test('tray: a click closes red details, and they stay closed until the cache leaves the red', async ($, on) => {
  let now = 1_000_000
  on('clock.now', () => ({ value: now }))
  engine(on)
  await request($)
  now += 46 * MIN
  expect(await details($)).toBeDefined()
  await click($, 'cache')
  now += 1 * MIN
  expect(await details($)).toBeUndefined()
  expect(await dots($)).toEqual(['red'])
  await request($)
  now += 46 * MIN
  expect(String(await details($))).toContain('◷ cache 14:00 left')
})

test('tray: the context text turns yellow at 35%, and red at 50% with its details open', async ($, on) => {
  on('clock.now', () => ({ value: 1_000_000 }))
  engine(on)
  await measure($, on, 34)
  expect(await dots($)).toEqual([])
  await measure($, on, 35)
  expect(await dots($)).toEqual(['yellow'])
  expect(await details($)).toBeUndefined()
  await measure($, on, 50)
  expect(await dots($)).toEqual(['red'])
  expect(String(await details($))).toContain('ctx 500k/1M 50%')
})

test('tray: both red shows both details, cache first', async ($, on) => {
  let now = 1_000_000
  on('clock.now', () => ({ value: now }))
  engine(on)
  await request($)
  await measure($, on, 60)
  now += 50 * MIN
  const ui = await $.ui.mount(BAND)
  expect(String((await ui.find({ type: 'Text', text: /◷/ } as any))?.text)).toMatch(/◷ cache 10:00 left.*ctx 600k\/1M 60%/)
})

test('tray: closed red context details open again once it has left the red and come back', async ($, on) => {
  on('clock.now', () => ({ value: 1_000_000 }))
  engine(on)
  await measure($, on, 55)
  await click($, 'context')
  expect(await details($)).toBeUndefined()
  await measure($, on, 20) // a compact
  expect(await details($)).toBeUndefined()
  await measure($, on, 52)
  expect(String(await details($))).toContain('ctx 520k/1M 52%')
})

test('the colours: cache by minutes left, context by percent full', async () => {
  expect(cacheColor(false, 0, 30 * MIN, 15 * MIN)).toBe('gray')
  expect(cacheColor(true, 31 * MIN, 30 * MIN, 15 * MIN)).toBe('green')
  expect(cacheColor(true, 30 * MIN, 30 * MIN, 15 * MIN)).toBe('yellow')
  expect(cacheColor(true, 15 * MIN, 30 * MIN, 15 * MIN)).toBe('red')
  expect(cacheColor(true, -1, 30 * MIN, 15 * MIN)).toBe('red')
  expect(ctxColor(null, 35, 50)).toBeNull()
  expect(ctxColor(34, 35, 50)).toBe('green')
  expect(ctxColor(35, 35, 50)).toBe('yellow')
  expect(ctxColor(50, 35, 50)).toBe('red')
})

test('which details show, and what a click does', async () => {
  const none = new Set<string>()
  expect(shownItems(null, none, [])).toEqual([])
  expect(shownItems('context', none, ['cache'])).toEqual(['cache', 'context'])
  expect(shownItems(null, new Set(['cache']), ['cache'])).toEqual([])
  // a click on a closed icon opens it, replacing an earlier click
  expect(pressItem('context', none, 'cache', false, false).manual).toBe('cache')
  // a click on red details closes them and remembers it
  const r = pressItem(null, none, 'cache', true, true)
  expect(r.manual).toBeNull()
  expect([...r.dismissed]).toEqual(['cache'])
  // a click on details a click opened just closes them
  expect(pressItem('context', none, 'context', true, false)).toEqual({ manual: null, dismissed: none })
})

test('tray: details a click opened stay open across a request', async ($, on) => {
  let now = 1_000_000
  on('clock.now', () => ({ value: now }))
  engine(on)
  await request($)
  await click($, 'context')
  now += 10 * MIN
  await request($)
  expect(await details($)).toBe('ctx --')
})

test('tray on the desktop: coloured text in a Client, a click on the cache opens its details', async ($, on) => {
  on('clock.now', () => ({ value: 1_000_000 }))
  engine(on)
  const ui = await $.ui.mount(DESKTOP_BAND)
  expect(await ui.find({ type: 'Text', text: /cache$/, in: 'tray' } as any)).toBeDefined()
  await (ui as any).pointer({ type: 'down', x: 0, y: 0, button: 'left', in: 'tray' })
  expect(String(await details($, DESKTOP_BAND))).toContain('◷ cache: no request yet')
})

// The full style: upstream's whole line, all the time, no icons

test('full: the whole line all the time, no tray', async ($, on) => {
  let now = 1_000_000
  on('clock.now', () => ({ value: now }))
  engine(on)
  await start($, on, { CACHE_CLOCK_STYLE: 'full' })
  await request($)
  now += 10 * MIN
  const ui = await $.ui.mount(BAND)
  const line = String((await ui.find({ type: 'Text', text: /◷/ } as any))?.text)
  expect(line).toContain('◷ cache 50:00 left')
  expect(line).toContain('ctx --')
  expect(await ui.find({ key: 'cache' } as any)).toBeUndefined()
})

test('the style comes from the env var, then the setting; the tray unless full', async () => {
  expect(pickStyle(undefined, undefined)).toBe('tray')
  expect(pickStyle(undefined, 'full')).toBe('full')
  expect(pickStyle('tray', 'full')).toBe('tray')
  expect(pickStyle('full', 'tray')).toBe('full')
  // compact, the 0.6-0.8 icon style, is the tray now
  expect(pickStyle('compact', undefined)).toBe('tray')
})

// Either style

// Another mod's band (vercel-deploy-status, say) sits behind this one in the chain
test('the line draws the other mods\' bands under it', async ($, on) => {
  on('clock.now', () => ({ value: 1_000_000 }))
  let rows = -1
  on('ui.render', { component: 'AbovePrompt' }, (_$, e: any) => {
    rows = e.props.maxRows
    return { type: 'Text', children: ['other band'] } as never
  })
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ key: 'cache' } as any)).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /other band/ } as any)).toBeDefined()
  expect(rows).toBe(9)
})

for (const [command, args] of [['recap', ''], ['btw', 'what word did you reply with?']]) {
  test(`/${command} restarts the main cache clock, though no turn.step fires for it (#15)`, async ($, on) => {
    let now = 1_000_000
    on('clock.now', () => ({ value: now }))
    engine(on)
    on('command.run', () => ({ text: 'side answer' }))

    // Before any main request there is nothing cached to keep warm
    await $.command.run({ command, args } as any)
    expect(await cachePiece($)).toBe('cache: no request yet')

    // A main turn starts the hour; 50 minutes later 10 are left
    await request($)
    now += 50 * MIN
    expect(await cachePiece($)).toBe('cache 10:00 left')

    // The side request reads the cache: a full hour again
    await $.command.run({ command, args } as any)
    expect(await cachePiece($)).toBe('cache 60:00 left')
  })
}

test('a side request on a cold cache, or a bare /btw, leaves the clock alone', async ($, on) => {
  let now = 1_000_000
  on('clock.now', () => ({ value: now }))
  engine(on)
  on('command.run', () => ({ text: 'ok' }))
  await request($)
  now += 50 * MIN
  await $.command.run({ command: 'btw', args: '  ' } as any)
  expect(await cachePiece($)).toBe('cache 10:00 left')
  now += 20 * MIN
  await $.command.run({ command: 'recap', args: '' } as any)
  expect(await cachePiece($)).toBe('cache cold')
})

test('another command leaves the cache clock alone', async ($, on) => {
  let now = 1_000_000
  on('clock.now', () => ({ value: now }))
  engine(on)
  on('command.run', () => ({ text: 'ok' }))
  await request($)
  now += 50 * MIN
  await $.command.run({ command: 'cost', args: '' } as any)
  expect(await cachePiece($)).toBe('cache 10:00 left')
})

test('the icons step through twelve clock faces, or five pie slices', async () => {
  expect(cacheIcon('clock', 0, 60 * MIN)).toBe('🕛')
  expect(cacheIcon('clock', 4.9 * MIN, 60 * MIN)).toBe('🕛')
  expect(cacheIcon('clock', 5 * MIN, 60 * MIN)).toBe('🕐')
  expect(cacheIcon('clock', 59 * MIN, 60 * MIN)).toBe('🕚')
  expect(cacheIcon('clock', 90 * MIN, 60 * MIN)).toBe('🕚')
  expect(cacheIcon('pie', 0, 100)).toBe('○')
  expect(cacheIcon('pie', 50, 100)).toBe('◑')
  expect(cacheIcon('pie', 100, 100)).toBe('●')
})

test('the warning action comes from the env var, then the old switch, then the setting; off when unset', async () => {
  expect(pickAction(undefined, undefined, undefined)).toBe('off')
  expect(pickAction(undefined, undefined, 'handoff')).toBe('handoff')
  expect(pickAction(undefined, '0', 'handoff')).toBe('off')
  expect(pickAction('handoff', '0', 'off')).toBe('handoff')
  // compact is gone (Claude Code's idle compaction does it); an old saved value means off
  expect(pickAction(undefined, undefined, 'compact')).toBe('off')
  expect(pickAction('compact', undefined, 'handoff')).toBe('off')
  expect(pickAction('nonsense', undefined, undefined)).toBe('off')
})

test('each session gets its own handoff note', async () => {
  expect(handoffPath('/w/proj', '1a2b3c4d-5e6f-7a8b-9c0d-ef0123456789')).toBe('/w/proj/HANDOFF-1a2b3c4d.md')
  expect(handoffPath('/w/notes/', '9f8e7d6c-0000')).toBe('/w/notes/HANDOFF-9f8e7d6c.md')
})

test('a Windows handoff folder with a trailing backslash gets one separator', async () => {
  expect(handoffPath('C:\\proj\\', '1a2b3c4d-0000')).toBe('C:\\proj/HANDOFF-1a2b3c4d.md')
})

test('lastLines takes the end of LF and CRLF text, like tail -n', async () => {
  expect(lastLines('a\nb\nc\n', 2)).toEqual(['b', 'c'])
  expect(lastLines('a\r\nb\r\nc\r\n', 2)).toEqual(['b', 'c'])
  expect(lastLines('a\nb', 5)).toEqual(['a', 'b'])
  expect(lastLines('', 3)).toEqual([])
})

test('tail reads the end on Mac and Linux; PowerShell on Windows, with the path in an env var', async () => {
  expect(tailCommand(false, '/t/s.jsonl')).toEqual([['tail', '-n', '300', '/t/s.jsonl'], {}])
  const path = "C:\\Users\\U\\.claude\\projects\\p\\a'b.jsonl"
  const [argv, init] = tailCommand(true, path)
  expect(argv.slice(0, 4)).toEqual(['powershell', '-NoProfile', '-NonInteractive', '-Command'])
  expect(argv[4]).not.toContain(path)
  expect(init).toEqual({ env: { CACHE_CLOCK_FILE: path } })
})

// Headless (-p, SDK): no band timer and no /cache-clock command. The timer is
// what would submit handoff turns, so it must not exist without a person.
test('headless session starts no timer and no command', async ($, on) => {
  mock.store(on, {})
  mock.env(on, {})
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  let timers = 0
  let commands = 0
  on('clock.every', () => { timers += 1; return { value: undefined } as never })
  on('command.register', () => { commands += 1; return { value: undefined } as never })
  await $.session.start({ cwd: '/nowhere', surface: 'terminal', isInteractive: false })
  expect(timers).toBe(0)
  expect(commands).toBe(0)
})

// Positive control: the same probes fire in an interactive session, so the
// headless test above cannot pass just because the event names are wrong.
test('interactive session starts the timer and the command', async ($, on) => {
  mock.store(on, {})
  mock.env(on, {})
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { context: 0 } }) as never)
  let timers = 0
  let commands = 0
  on('clock.every', () => { timers += 1; return { value: undefined } as never })
  on('command.register', () => { commands += 1; return { value: undefined } as never })
  await $.session.start({ cwd: '/nowhere', surface: 'terminal', isInteractive: true })
  expect(timers).toBe(1)
  expect(commands).toBe(1)
})

// classic.SessionStart fires before session.start, so it must not read the
// transcript itself: in a headless session that read is a wasted tail/PowerShell spawn
for (const isInteractive of [false, true]) {
  test(`${isInteractive ? 'interactive' : 'headless'} session ${isInteractive ? 'reads' : 'never reads'} the transcript at start`, async ($: any, on) => {
    mock.store(on, {})
    mock.env(on, {})
    on('session.start', (_$, e) => ({ cwd: e.cwd }))
    on('clock.every', () => ({ value: undefined }) as never)
    on('clock.now', () => ({ value: 1_000_000 }) as never)
    on('command.register', () => ({ value: undefined }) as never)
    let runs = 0
    on('process.run', () => { runs += 1; return { value: { exitCode: 0, stdout: '', stderr: '' } } as never })
    on('classic.SessionStart', () => ({}) as never)
    await $.classic.SessionStart({ transcript_path: '/nowhere/t.jsonl' })
    await $.session.start({ cwd: '/nowhere', surface: 'terminal', isInteractive })
    expect(runs).toBe(isInteractive ? 1 : 0)
  })
}

// The usage item (0.11.0): the weekly reset and the leftover-usage jobs

test('spans read as days and hours, then hours and minutes', async () => {
  expect(span(32 * 60 * MIN + 10 * MIN)).toBe('1d 8h')
  expect(span(2 * 60 * MIN + 5 * MIN)).toBe('2h 05m')
  expect(span(45 * MIN)).toBe('45m')
})

test("a report's jobs are its bold numbered titles", async () => {
  const text = 'Usage resets **Monday**.\n\n**1. SupplyPro links** (due 11/3)\nWhy\n\n**2. Health memo** (due 11/6)\n\n**3. Year-end entries**\n'
  expect(jobTitles(text)).toEqual(['1. SupplyPro links', '2. Health memo', '3. Year-end entries'])
  expect(jobTitles('nothing here')).toEqual([])
})

test('open uses the system opener, or a URL made from CACHE_CLOCK_OPEN_URL', async () => {
  expect(openCommand('windows', 'C:/notes/jobs.md', '')).toEqual(['explorer.exe', 'C:/notes/jobs.md'])
  expect(openCommand('mac', '/n/jobs.md', '')).toEqual(['open', '/n/jobs.md'])
  expect(openCommand('linux', '/n/jobs.md', '')).toEqual(['xdg-open', '/n/jobs.md'])
  expect(openCommand('windows', 'C:/n/a b.md', 'obsidian://open?path={path}')).toEqual(['explorer.exe', 'obsidian://open?path=C%3A%2Fn%2Fa%20b.md'])
})

test('tray: a third item, usage, says it shows after the next reply until the plan reports', async ($, on) => {
  on('clock.now', () => ({ value: Date.UTC(2026, 10, 1, 18) }))
  engine(on)
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ key: 'usage' } as any)).toBeDefined()
  await click($, 'usage')
  const text = (await (await $.ui.mount(BAND)).find({ type: 'Text', text: /usage shows after/ } as any))?.text
  expect(String(text)).toBe('⧗ usage shows after the next reply')
})

// The desktop draws the colour in the icon's own text, not a dot. Needs the desktop's engine
// (2.1.309+): run these tests with the desktop's claude.exe (wiki/cache-clock-mod.md)

test('desktop: the context text itself turns yellow, then red, with no dot', async ($, on) => {
  on('clock.now', () => ({ value: 1_000_000 }))
  engine(on)
  await measure($, on, 35)
  expect(await dots($, DESKTOP_BAND)).toEqual(['yellow'])
  await measure($, on, 50)
  expect(await dots($, DESKTOP_BAND)).toEqual(['red'])
  expect(await (await $.ui.mount(DESKTOP_BAND)).find({ type: 'Text', text: /●/ } as any)).toBeUndefined()
})

test('desktop: the cache word is green while warm, then yellow and red; words only, no icons', async ($, on) => {
  let now = 1_000_000
  on('clock.now', () => ({ value: now }))
  engine(on)
  await request($)
  expect(await dots($, DESKTOP_BAND)).toEqual(['green'])
  now += 30 * MIN
  expect(await dots($, DESKTOP_BAND)).toEqual(['yellow'])
  now += 15 * MIN
  expect(await dots($, DESKTOP_BAND)).toEqual(['red'])
  // Words only since 0.19.0: no icons in the tray
  expect(await (await $.ui.mount(DESKTOP_BAND)).find({ type: 'Text', text: /^usage$/, in: 'tray' } as any)).toBeDefined()
  expect(await (await $.ui.mount(DESKTOP_BAND)).find({ type: 'Text', text: /^cache$/, in: 'tray' } as any)).toBeDefined()
  expect(await (await $.ui.mount(DESKTOP_BAND)).find({ type: 'Text', text: /[◷◶◵◴◔⧗]/, in: 'tray' } as any)).toBeUndefined()
})

test('terminal: a warm cache gets no dot; green is only drawn on the desktop', async ($, on) => {
  on('clock.now', () => ({ value: 1_000_000 }))
  engine(on)
  await request($)
  expect(await dots($)).toEqual([])
})

test('the desktop tray finds the item under a click by its column, forgiving wide glyphs', async () => {
  const items = [{ item: 'cache', text: '◷ cache' }, { item: 'context', text: '◔ context' }, { item: 'usage', text: '⧗ usage' }]
  expect(itemAt(items, 3, 0)).toBe('cache')
  expect(itemAt(items, 3, 6)).toBe('cache')
  expect(itemAt(items, 3, 8)).toBe('cache') // a gap splits down its middle
  expect(itemAt(items, 3, 9)).toBe('context')
  expect(itemAt(items, 3, 22)).toBe('usage')
  expect(itemAt(items, 3, 21)).toBe('usage')
  expect(itemAt(items, 3, 40)).toBe('usage') // the last item takes everything to its right
  expect(itemAt([], 3, 0)).toBe(null)
})

test('desktop: a click on usage in the tray opens the reset time; a second click closes it', async ($, on) => {
  on('clock.now', () => ({ value: Date.UTC(2026, 10, 1, 18) }))
  engine(on)
  const ui: any = await $.ui.mount(DESKTOP_BAND)
  await ui.pointer({ type: 'down', x: 22, y: 0, button: 'left', in: 'tray' })
  const open = await (await $.ui.mount(DESKTOP_BAND)).find({ type: 'Text', text: /usage shows after/ } as any)
  expect(open).toBeDefined()
  await (await $.ui.mount(DESKTOP_BAND) as any).pointer({ type: 'down', x: 22, y: 0, button: 'left', in: 'tray' })
  expect(await (await $.ui.mount(DESKTOP_BAND)).find({ type: 'Text', text: /usage shows after/ } as any)).toBeUndefined()
})

test('CACHE_CLOCK_TRAY=buttons brings back the icon buttons on the desktop', async ($, on) => {
  on('clock.now', () => ({ value: 1_000_000 }))
  engine(on)
  await start($, on, { CACHE_CLOCK_TRAY: 'buttons' })
  const ui = await $.ui.mount(DESKTOP_BAND)
  expect(await ui.find({ key: 'cache' } as any)).toBeDefined()
})

test('desktop: a click past where usage was counted to end still opens it (a wide icon pushes it right)', async ($, on) => {
  on('clock.now', () => ({ value: Date.UTC(2026, 10, 1, 18) }))
  engine(on)
  const ui: any = await $.ui.mount(DESKTOP_BAND)
  await ui.pointer({ type: 'down', x: 31, y: 0, button: 'left', in: 'tray' })
  expect(await (await $.ui.mount(DESKTOP_BAND)).find({ type: 'Text', text: /usage shows after/ } as any)).toBeDefined()
})

test('desktop: the context is green from its first reading until 35%, plain before any', async ($, on) => {
  on('clock.now', () => ({ value: 1_000_000 }))
  engine(on)
  expect(await dots($, DESKTOP_BAND)).toEqual([])
  await measure($, on, 5)
  expect(await dots($, DESKTOP_BAND)).toEqual(['green'])
})

// Usage from the plan's own limits (0.17.0): pace = % used against the share of the week gone

const SUN_10AM = Date.UTC(2026, 10, 1, 18) // Sunday 10:00 PST
const MON_10AM = Date.UTC(2026, 10, 2, 18) // Monday 10:00 PST, 7 hours before the reset
const RESET = '2026-11-03T01:00:00Z' // Monday 17:00 PST
const week = (percentUsed: number, kind = 'seven_day') => ({ kind, percentUsed, resetsAt: RESET })

test('the share of the week gone comes from the reset time', async () => {
  expect(Math.round(weekElapsed(SUN_10AM, Date.parse(RESET)))).toBe(82)
  expect(weekElapsed(Date.parse(RESET) - 7 * 24 * 60 * MIN, Date.parse(RESET))).toBe(0)
})

test("pace colours: 50/50 green, 50/60 yellow, 50/80 red; 90% used is red", async () => {
  const far = 3 * 24 * 60 * MIN
  expect(paceColor(50, 50, far)).toBe('green')
  expect(paceColor(55, 50, far)).toBe('green')
  expect(paceColor(60, 50, far)).toBe('yellow')
  expect(paceColor(70, 50, far)).toBe('yellow')
  expect(paceColor(80, 50, far)).toBe('red')
  expect(paceColor(90, 95, far)).toBe('red')
})

test('cyan in the last 24 hours with 20% or more unused; red and yellow still win', async () => {
  expect(paceColor(60, 96, 7 * 60 * MIN)).toBe('cyan')
  expect(paceColor(85, 96, 7 * 60 * MIN)).toBe('green')
  expect(paceColor(65, 40, 7 * 60 * MIN)).toBe('red')
  expect(paceColor(60, 40, 7 * 60 * MIN)).toBe('yellow') // exactly 20 ahead
  expect(worstColor(['cyan', 'yellow'])).toBe('yellow')
  expect(worstColor(['cyan'])).toBe('cyan')
  expect(worstColor([])).toBe(null)
})

test("the reset reads as a weekday and time in the machine's own time zone", async () => {
  expect(resetLabel(Date.parse(RESET))).toMatch(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{1,2}(am|pm)$/)
  expect(resetLabel(Date.parse('2026-11-03T00:59:00Z'))).toMatch(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{1,2}:59(am|pm)$/)
})

test('the usage details: week through, used, ahead or under, and the other windows', async () => {
  const u: any = usageFromLimits([week(50), { kind: 'five_hour', percentUsed: 30, resetsAt: '2026-11-01T20:00:00Z' }], SUN_10AM)
  expect(u.text).toMatch(/^⧗ week 82% through \(resets (\w{3} \d{1,2}(:\d\d)?(am|pm), |in )1d 7h\) · used 50% · 32% under · 5-hour 30%$/)
  expect(u.tone).toBe('green')
  expect(usageFromLimits([{ kind: 'five_hour', percentUsed: 30 }], SUN_10AM)).toBe(null)
})

test('a separate weekly allowance (Fable) counts for the colour; the 5-hour window does not', async () => {
  const u: any = usageFromLimits([week(50), week(95, 'seven_day_fable'), { kind: 'five_hour', percentUsed: 99, resetsAt: RESET }], SUN_10AM)
  expect(u.tone).toBe('red')
  expect(u.text).toContain('week fable 95%')
  expect((usageFromLimits([week(50), { kind: 'five_hour', percentUsed: 99, resetsAt: RESET }], SUN_10AM) as any).tone).toBe('green')
})

test('desktop: the engine reports the weekly window; usage turns its pace colour and shows it on a click', async ($, on) => {
  let now = SUN_10AM
  on('clock.now', () => ({ value: now }))
  engine(on)
  await $.session.measure({ context: { tokens: 50_000, window: 1_000_000, percent: 5 }, rateLimits: [week(88)] } as any)
  expect(await dots($, DESKTOP_BAND)).toEqual(['green', 'yellow']) // context green, usage 6 ahead
  const ui: any = await $.ui.mount(DESKTOP_BAND)
  await ui.pointer({ type: 'down', x: 22, y: 0, button: 'left', in: 'tray' })
  expect(String((await (await $.ui.mount(DESKTOP_BAND)).find({ type: 'Text', text: /week \d+% through/ } as any) as any)?.text)).toContain('used 88%')
  now = MON_10AM
  await $.session.measure({ context: { tokens: 50_000, window: 1_000_000, percent: 5 }, rateLimits: [week(60)] } as any)
  expect(await dots($, DESKTOP_BAND)).toEqual(['green', 'cyan'])
})

test('a measurement with no limits keeps the last weekly reading', async ($, on) => {
  on('clock.now', () => ({ value: SUN_10AM }))
  engine(on)
  await $.session.measure({ context: { tokens: 50_000, window: 1_000_000, percent: 5 }, rateLimits: [week(95)] } as any)
  await $.session.measure({ context: { tokens: 60_000, window: 1_000_000, percent: 6 }, rateLimits: [] } as any)
  expect(await dots($, DESKTOP_BAND)).toEqual(['green', 'red'])
})

test('a dim divider separates the tray items, on the desktop and the terminal', async ($, on) => {
  on('clock.now', () => ({ value: 1_000_000 }))
  engine(on)
  const desk: any = await $.ui.mount(DESKTOP_BAND)
  const d: any = await desk.find({ type: 'Text', text: ' │ ', in: 'tray' } as any)
  expect(d).toBeDefined()
  expect(d.props?.dimColor ?? d.dimColor).toBe(true)
  expect(await (await $.ui.mount(BAND)).find({ type: 'Text', text: ' │ ' } as any)).toBeDefined()
})

test('terminal: the tray buttons are the words alone', async ($, on) => {
  on('clock.now', () => ({ value: 1_000_000 }))
  engine(on)
  const ui: any = await $.ui.mount(BAND)
  const b: any = await ui.find({ key: 'usage' } as any)
  expect(b?.label ?? b?.props?.label).toBe('usage')
})

test('without CACHE_CLOCK_JOBS_DIR the usage details have no jobs part', async ($, on) => {
  on('clock.now', () => ({ value: SUN_10AM }))
  engine(on)
  await $.session.measure({ context: { tokens: 50_000, window: 1_000_000, percent: 5 }, rateLimits: [week(50)] } as any)
  const ui: any = await $.ui.mount(DESKTOP_BAND)
  await ui.pointer({ type: 'down', x: 22, y: 0, button: 'left', in: 'tray' })
  const after = await $.ui.mount(DESKTOP_BAND)
  expect(await after.find({ type: 'Text', text: /week \d+% through/ } as any)).toBeDefined()
  expect(await after.find({ type: 'Text', text: /jobs/ } as any)).toBeUndefined()
})
