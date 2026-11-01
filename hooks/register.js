// cache-context-usage: Ray Amjad's cache-clock 0.5.4 (MIT), turned into a tray.
// One line above the prompt holds three words at the right, cache │ context │ usage;
// a click opens that item's details to their left on the same line, a second click
// closes them. Each word is green while healthy, yellow past its first threshold and
// red past the second (on the terminal: a dot in front for yellow and red), when its
// details open by themselves until a click closes them or the item leaves the red.
// CACHE_CLOCK_STYLE=full draws upstream's whole line instead, all the time.

// Defaults. Each can be changed with an environment variable.
const DEFAULT_MAIN_TTL_MIN = 60 // main session cache (matches what the transcripts record)
const DEFAULT_SUB_TTL_MIN = 5 // subagent cache
const DEFAULT_WARN_MIN = 5 // toast (and the onWarning action) when this much is left
const DEFAULT_YELLOW_MIN = 30 // the cache turns yellow when this much is left
const DEFAULT_RED_MIN = 15 // and red, its details open, when this much is left (and once cold)
const DEFAULT_CTX_YELLOW_PCT = 35 // the context turns yellow at this much of the window
const DEFAULT_CTX_RED_PCT = 50 // and red, its details open, at this much

const MIN = 60_000

// The usage item: the plan's weekly limit as the engine reports it, coloured by pace (see
// usageFromLimits). Optional: CACHE_CLOCK_JOBS_DIR names a folder of markdown notes; the newest
// one's bold numbered lines (**1. Title**) are listed in the usage details as things to spend
// spare usage on, and an "open" button opens that note.
const USAGE_POLL = MIN // how often the jobs folder is read

// The icon: twelve clock faces (the hand moves every twelfth of the TTL, 5
// minutes on a 1 hour cache), or, with CACHE_CLOCK_ICON=pie, a circle that fills
const CLOCK_FACES = ['🕛', '🕐', '🕑', '🕒', '🕓', '🕔', '🕕', '🕖', '🕗', '🕘', '🕙', '🕚']
const PIE = ['○', '◔', '◑', '◕', '●']
// The desktop tray's cache icon (0.15.0): a text clock, which takes colour (the emoji faces do not);
// its hand at 12-3, 3-6, 6-9, 9-12 of the TTL
const QUARTER = ['◷', '◶', '◵', '◴']

// State shared by the hooks below
const cfg = { mainTtl: DEFAULT_MAIN_TTL_MIN * MIN, subTtl: DEFAULT_SUB_TTL_MIN * MIN, warn: DEFAULT_WARN_MIN * MIN, yellow: DEFAULT_YELLOW_MIN * MIN, red: DEFAULT_RED_MIN * MIN, ctxYellow: DEFAULT_CTX_YELLOW_PCT, ctxRed: DEFAULT_CTX_RED_PCT, style: 'tray', icon: 'clock', sound: false, pinned: false, onWarning: 'off', handoffDir: '', jobsDir: '', openUrl: '', tray: 'client' }
let usage = { file: '', mtime: 0, titles: [] } // the newest note in the jobs folder
let usageReadAt = 0 // when the jobs folder was last read
let startedAt = 0 // session start: only a note newer than this gets a toast
let usageToasted = '' // the note a toast already announced
let ttlSource = 'assumed' // 'measured' once we read it from the transcript
let mainAt = 0 // when the main session last sent a request (ms)
let subAt = 0 // when a subagent last sent one
let warned = false // toast already shown for this warm period
let wentCold = false // "went cold" already shown
let working = false // a turn is running
let handedOff = false // handoff done since the user last sent something
let context = null // { tokens, window, percent } from $.session.usage()
let limits = [] // the plan's rate-limit windows [{ kind, percentUsed, resetsAt }], as last reported
let transcript = null // path to this session's .jsonl
let headless = false // -p / SDK session: no band, so skip the transcript reads too
let manual = null // the tray icon a click opened: 'cache', 'context' or null (every session starts closed)
let dismissed = new Set() // red items whose details a click closed, until they leave the red

// Read a number of minutes from an env var, or keep the default
function minutes(value, fallback) {
  const n = parseFloat(value ?? '')
  return Number.isFinite(n) && n > 0 ? n * MIN : fallback
}

// Read a percentage from an env var, or keep the default
function percent(value, fallback) {
  const n = parseFloat(value ?? '')
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : fallback
}

// The cache's colour for the time left: green, yellow, then red (cold included); gray before the first request
export function cacheColor(started, left, yellow, red) {
  if (!started) return 'gray'
  if (left <= red) return 'red'
  return left <= yellow ? 'yellow' : 'green'
}

// The context's colour for how full the window is: null (plain) before the first reading, then green,
// yellow and red, as the cache
export function ctxColor(pct, yellow, red) {
  if (pct == null) return null
  if (pct >= red) return 'red'
  return pct >= yellow ? 'yellow' : 'green'
}

// '1d 8h', '2h 05m', '45m'
export function span(ms) {
  const m = Math.max(0, Math.round(ms / MIN))
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60
  if (d) return d + 'd ' + h + 'h'
  return h ? h + 'h ' + String(mm).padStart(2, '0') + 'm' : mm + 'm'
}

// The job titles of a note: its '**1. Title**' lines, at most three
export function jobTitles(text) {
  return [...String(text).matchAll(/^\*\*([1-3])\.\s+(.+?)\*\*/gm)].map((m) => m[1] + '. ' + m[2])
}

// The newest note in the jobs folder, read again once a minute; a new one gets a toast
async function pollUsage($, now) {
  if (!cfg.jobsDir || now - usageReadAt < USAGE_POLL) return
  usageReadAt = now
  if (!startedAt) startedAt = now // the first read, at the first tick: what is already there gets no toast
  const dir = cfg.jobsDir.replace(/[\\/]+$/, '')
  let newest = null
  try {
    for (const f of await $.fs.list(dir)) {
      if (f.kind === 'file' && f.name.endsWith('.md') && (!newest || f.mtimeMs > newest.mtimeMs)) newest = f
    }
  } catch { return }
  if (!newest || (newest.name === usage.file && newest.mtimeMs === usage.mtime)) return
  const titles = jobTitles(await $.fs.read(dir + '/' + newest.name).catch(() => ''))
  usage = { file: newest.name, mtime: newest.mtimeMs, titles }
  if (newest.mtimeMs > startedAt && usageToasted !== newest.name && titles.length) {
    usageToasted = newest.name
    $.ui.toast(titles.length + ' jobs ready for spare usage. Click usage at the top right.', { timeoutMs: 15_000 })
  }
}

// --- Usage from the plan's own limits (0.17.0) -------------------------------------------------
// After each reply the engine reports the account's rate-limit windows (session.measure
// rateLimits: kind, percentUsed, resetsAt), account-wide from the server. The weekly window's
// colour is its pace: % used against the share of the week gone.
const WEEK = 7 * 24 * 60 * MIN

// The share of the week gone, 0 to 100, from the window's reset time
export function weekElapsed(now, resetAt) {
  return Math.min(100, Math.max(0, 100 * (1 - (resetAt - now) / WEEK)))
}

// A weekly window's colour: red at 90% used or more than 20 points ahead of the week, yellow more
// than 5 ahead, cyan (spare to spend) in the last 24 hours with 20% or more unused, else green
export function paceColor(used, elapsed, resetLeft) {
  if (used >= 90) return 'red'
  const ahead = used - elapsed
  if (ahead > 20) return 'red'
  if (ahead > 5) return 'yellow'
  if (resetLeft <= 24 * 60 * MIN && 100 - used >= 20) return 'cyan'
  return 'green'
}

// The worst of several windows' colours (red, yellow, then green; cyan only when nothing is worse)
export function worstColor(tones) {
  for (const t of ['red', 'yellow', 'green', 'cyan']) if (tones.includes(t)) return t
  return null
}

// 'Mon 5pm', 'Mon 4:59pm': a reset time in the machine's own time zone; '' where the runtime has no Intl
export function resetLabel(resetAt) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(new Date(resetAt))
    const get = (t) => parts.find((x) => x.type === t)?.value ?? ''
    const min = get('minute')
    return get('weekday') + ' ' + get('hour') + (min && min !== '00' ? ':' + min : '') + get('dayPeriod').toLowerCase()
  } catch {
    return ''
  }
}

// What a window is called in the details
export function limitName(kind) {
  if (kind === 'seven_day') return 'week'
  if (kind === 'five_hour') return '5-hour'
  return String(kind).replace(/^seven_day_/, 'week ').replace(/_/g, ' ')
}

// The usage details and colour from the windows: null when no weekly window has been reported yet
export function usageFromLimits(limits, now) {
  const weekly = limits.find((l) => l.kind === 'seven_day' && l.resetsAt)
  if (!weekly) return null
  const resetAt = Date.parse(weekly.resetsAt)
  const resetLeft = resetAt - now
  const elapsed = Math.round(weekElapsed(now, resetAt))
  const ahead = Math.round(weekly.percentUsed - elapsed)
  const others = limits.filter((l) => l !== weekly).map((l) => limitName(l.kind) + ' ' + l.percentUsed + '%')
  const label = resetLabel(resetAt)
  const text = ['⧗ week ' + elapsed + '% through (resets ' + (label ? label + ', ' : 'in ') + span(resetLeft) + ')',
    'used ' + weekly.percentUsed + '%', ahead > 0 ? ahead + '% ahead' : ahead < 0 ? -ahead + '% under' : 'on pace', ...others].join(' · ')
  // Every weekly window counts (a separate Fable or model allowance too); the 5-hour one does not
  const tones = limits.filter((l) => /^seven_day/.test(l.kind)).map((l) => {
    const at = l.resetsAt ? Date.parse(l.resetsAt) : resetAt
    return paceColor(l.percentUsed, weekElapsed(now, at), at - now)
  })
  return { text, tone: worstColor(tones), resetAt }
}

// How "open" opens the jobs note: the system's own opener, with the note's path, or with a URL made
// from CACHE_CLOCK_OPEN_URL ('{path}' stands for the path, URL-encoded), e.g. obsidian://open?path={path}
export function openCommand(os, path, urlTemplate) {
  const target = urlTemplate ? urlTemplate.split('{path}').join(encodeURIComponent(path)) : path
  if (os === 'windows') return ['explorer.exe', target]
  if (os === 'mac') return ['open', target]
  return ['xdg-open', target]
}

const ITEMS = ['cache', 'context', 'usage']

// Which details show: the one a click opened, and every red one a click has not closed
export function shownItems(manual, dismissed, reds) {
  return ITEMS.filter((i) => manual === i || (reds.includes(i) && !dismissed.has(i)))
}

// A click on an icon: close its details if they show (a red one stays closed while red),
// else open them, replacing what an earlier click opened
export function pressItem(manual, dismissed, item, shown, red) {
  const d = new Set(dismissed)
  if (shown) {
    if (red) d.add(item)
    return { manual: manual === item ? null : manual, dismissed: d }
  }
  d.delete(item)
  return { manual: item, dismissed: d }
}

const ACTIONS = ['handoff', 'off']

// What the warning does: the env var, then the old CACHE_CLOCK_AUTO_HANDOFF=0, then the setting.
// The old 'compact' choice means 'off' now: Claude Code's own idle compaction does that job.
// Unset or unknown means off here (upstream: handoff), so no HANDOFF note lands in the project.
export function pickAction(envAction, envAutoHandoff, setting) {
  let action = envAction ?? (envAutoHandoff === '0' ? 'off' : setting)
  if (action === 'compact') action = 'off'
  return ACTIONS.includes(action) ? action : 'off'
}

// A tray icon for how much of something has gone: a clock face, or a pie slice
export function cacheIcon(style, elapsed, ttl) {
  const faces = style === 'pie' ? PIE : style === 'quarter' ? QUARTER : CLOCK_FACES
  const i = Math.floor((Math.max(0, elapsed) / ttl) * faces.length)
  return faces[Math.min(faces.length - 1, i)]
}

// How the clock shows: the env var, then the setting; the tray unless 'full' (upstream's line).
// 'compact', the 0.6-0.8 icon style, is the tray now.
export function pickStyle(envStyle, setting) {
  return (envStyle ?? setting) === 'full' ? 'full' : 'tray'
}

async function loadConfig($, options) {
  const main = await $.env.get('CACHE_CLOCK_MAIN_TTL_MIN')
  cfg.mainTtl = minutes(main, DEFAULT_MAIN_TTL_MIN * MIN)
  cfg.pinned = main !== undefined // a value you set wins over the transcript
  cfg.subTtl = minutes(await $.env.get('CACHE_CLOCK_SUB_TTL_MIN'), DEFAULT_SUB_TTL_MIN * MIN)
  cfg.warn = minutes(await $.env.get('CACHE_CLOCK_WARN_MIN'), DEFAULT_WARN_MIN * MIN)
  cfg.yellow = minutes(await $.env.get('CACHE_CLOCK_YELLOW_MIN'), DEFAULT_YELLOW_MIN * MIN)
  // CACHE_CLOCK_BANNER_MIN, 0.9's name for the auto-open point, still counts as the red one
  cfg.red = minutes((await $.env.get('CACHE_CLOCK_RED_MIN')) ?? (await $.env.get('CACHE_CLOCK_BANNER_MIN')), DEFAULT_RED_MIN * MIN)
  cfg.ctxYellow = percent(await $.env.get('CACHE_CLOCK_CTX_YELLOW_PCT'), DEFAULT_CTX_YELLOW_PCT)
  cfg.ctxRed = percent(await $.env.get('CACHE_CLOCK_CTX_RED_PCT'), DEFAULT_CTX_RED_PCT)
  cfg.style = pickStyle(await $.env.get('CACHE_CLOCK_STYLE'), options?.style)
  cfg.icon = (await $.env.get('CACHE_CLOCK_ICON')) === 'pie' ? 'pie' : 'clock'
  cfg.sound = (await $.env.get('CACHE_CLOCK_SOUND')) === '1'
  cfg.handoffDir = (await $.env.get('CACHE_CLOCK_HANDOFF_DIR')) ?? ''
  cfg.jobsDir = (await $.env.get('CACHE_CLOCK_JOBS_DIR')) ?? ''
  cfg.openUrl = (await $.env.get('CACHE_CLOCK_OPEN_URL')) ?? ''
  // The desktop tray: coloured text in a Client (the default), or 0.14's icon buttons
  cfg.tray = (await $.env.get('CACHE_CLOCK_TRAY')) === 'buttons' ? 'buttons' : 'client'
  // The plugin setting, unless an env var overrides it. CACHE_CLOCK_AUTO_HANDOFF=0 still means off.
  cfg.onWarning = pickAction(await $.env.get('CACHE_CLOCK_ON_WARNING'), await $.env.get('CACHE_CLOCK_AUTO_HANDOFF'), options?.onWarning)
}

// The real TTL: each assistant row in the transcript says which cache bucket
// it wrote to (ephemeral_1h or ephemeral_5m). Read the newest main-thread one.
async function readTtl($) {
  if (!transcript || cfg.pinned) return
  for (const row of (await lastRows($, transcript)).reverse()) {
    if (!row.includes('"cache_creation"')) continue
    let msg
    try { msg = JSON.parse(row) } catch { continue }
    if (msg.type !== 'assistant' || msg.isSidechain) continue
    const cc = msg.message?.usage?.cache_creation ?? {}
    if (cc.ephemeral_1h_input_tokens > 0) { cfg.mainTtl = 60 * MIN; ttlSource = 'measured'; return }
    if (cc.ephemeral_5m_input_tokens > 0) { cfg.mainTtl = 5 * MIN; ttlSource = 'measured'; return }
    // a pure cache read does not say which bucket; look further back
  }
}

// The transcript's last 300 rows. A long session's transcript is past the
// 4 MiB $.fs.read takes, so a command reads its end: `tail` on Mac and Linux,
// PowerShell on Windows, which has no tail (the path goes in an env var, not
// the script). If the command fails, $.fs.read is the last resort.
export function tailCommand(isWindows, path) {
  if (!isWindows) return [['tail', '-n', '300', path], {}]
  const script =
    '$r = New-Object IO.StreamReader((New-Object IO.FileStream($env:CACHE_CLOCK_FILE, "Open", "Read", "ReadWrite")), [Text.Encoding]::UTF8); ' +
    '$q = New-Object System.Collections.Generic.Queue[string]; ' +
    'while ($null -ne ($l = $r.ReadLine())) { $q.Enqueue($l); if ($q.Count -gt 300) { [void]$q.Dequeue() } }; ' +
    '$b = [Text.Encoding]::UTF8.GetBytes(($q -join "`n") + "`n"); [Console]::OpenStandardOutput().Write($b, 0, $b.Length)'
  return [['powershell', '-NoProfile', '-NonInteractive', '-Command', script], { env: { CACHE_CLOCK_FILE: path } }]
}
async function lastRows($, path) {
  try {
    const [argv, init] = tailCommand((await $.env.get('OS')) === 'Windows_NT', path)
    const r = await $.process.run(argv, init)
    if (r.exitCode === 0) return lastLines(r.stdout, 300)
  } catch {}
  return lastLines(await $.fs.read(path).catch(() => ''), 300)
}

// The last n lines of a file's text, CRLF or LF
export function lastLines(text, n) {
  const lines = String(text).split(/\r?\n/)
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.slice(-n)
}

// 47:05 or 3:09
function clock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0')
}

function fmtTokens(n) {
  if (n >= 1_000_000) return +(n / 1_000_000).toFixed(1) + 'M'
  return n >= 1000 ? Math.round(n / 1000) + 'k' : String(n)
}

// Everything the band shows, as plain pieces so /cache-clock can print it too
function snapshot(now) {
  const left = mainAt ? mainAt + cfg.mainTtl - now : 0
  const subLeft = subAt ? subAt + cfg.subTtl - now : 0
  const color = cacheColor(mainAt > 0, left, cfg.yellow, cfg.red)
  const ttl = (cfg.mainTtl >= 60 * MIN ? cfg.mainTtl / (60 * MIN) + 'h' : cfg.mainTtl / MIN + 'm') + ' ttl ' + (cfg.pinned ? 'set' : ttlSource)
  const cache = !mainAt ? 'cache: no request yet' : left > 0 ? 'cache ' + clock(left) + ' left' : 'cache cold'
  let ctx = 'ctx --'
  let ctxIcon = PIE[0]
  let pct = null
  if (context?.tokens) {
    pct = context.percent ?? Math.round((context.tokens / context.window) * 100)
    const filled = Math.round(pct / 10)
    ctx = 'ctx ' + fmtTokens(context.tokens) + '/' + fmtTokens(context.window) + ' ' + pct + '% ' + '▰'.repeat(filled) + '▱'.repeat(10 - filled)
    ctxIcon = cacheIcon('pie', pct, 100)
  }
  const sub = subLeft > 0 ? 'sub ' + clock(subLeft) : null
  const icon = cacheIcon(cfg.icon, mainAt ? now - mainAt : 0, cfg.mainTtl)
  const ctxTone = ctxColor(pct, cfg.ctxYellow, cfg.ctxRed)
  // Usage: the plan's weekly window once the engine has reported it (after the first reply), coloured
  // by pace; and the jobs from the newest note in CACHE_CLOCK_JOBS_DIR, if set (a note older than the
  // week is last week's)
  const plan = usageFromLimits(limits, now)
  const weekStart = plan ? plan.resetAt - 7 * 24 * 60 * MIN : now - 7 * 24 * 60 * MIN
  const jobs = usage.titles.length && usage.mtime > weekStart ? usage.titles : []
  const usageText = plan ? plan.text : '⧗ usage shows after the next reply'
  const jobsText = !cfg.jobsDir ? '' : jobs.length ? jobs.join('  ') : 'no jobs in the folder this week'
  const usageTone = plan ? plan.tone : null
  const quarter = cacheIcon('quarter', mainAt ? now - mainAt : 0, cfg.mainTtl)
  return { color, cache, ttl, ctx, sub, left, icon, quarter, ctxIcon, ctxTone, started: mainAt > 0, usageText, jobsText, usageTone, hasJobs: jobs.length > 0 }
}

// A click on a tray item, from a Button or from the desktop tray's Client: close its details if
// they show (a red one stays closed while red), else open them, read against the moment of the click
async function pressNow($, item) {
  const reds = redItems(snapshot(await $.clock.now()))
  const isShown = shownItems(manual, dismissed, reds).includes(item)
  ;({ manual, dismissed } = pressItem(manual, dismissed, item, isShown, reds.includes(item)))
  $.ui.invalidate('ui.render')
}

// The tray items in the red; one that has left it may open by itself again next time
function redItems(s) {
  const reds = []
  if (s.color === 'red') reds.push('cache')
  if (s.ctxTone === 'red') reds.push('context')
  if (s.usageTone === 'red') reds.push('usage')
  for (const i of dismissed) if (!reds.includes(i)) dismissed.delete(i)
  return reds
}

function asText(s) {
  return [s.cache + ' (' + s.ttl + ')', s.ctx, s.sub, s.usageText + ': ' + s.jobsText].filter(Boolean).join('  |  ')
}

// The handoff prompt. The marker lets prompt.submit tell it from the user's own prompts.
const HANDOFF_MARKER = 'cache-clock handoff'

// One note per session, so parallel sessions in one folder never overwrite
// each other's. It goes to CACHE_CLOCK_HANDOFF_DIR, else the project root
// (not the shell's current folder, which a `cd` can move into a nested repo).
export function handoffPath(dir, sessionId) {
  return dir.replace(/[\\/]+$/, '') + '/HANDOFF-' + String(sessionId).slice(0, 8) + '.md'
}
function handoffText(file) {
  return '(' + HANDOFF_MARKER + ') The prompt cache goes cold soon and the user has not replied. While the cache is still warm, write a short handoff note to ' + file + ': the goal, what is done, what is next, open questions, and the key files. Keep it brief, and write it even if the session has been short. Do nothing else. A fresh session will start from it if the user does not come back.'
}

// A main-session request just read or wrote the cache: a full TTL again
function restartMain(now) {
  mainAt = now
  warned = false
  wentCold = false
  // The cache leaves the red, so its details close unless a click opened them, and may open again next time
  dismissed.delete('cache')
}

// /recap and /btw send the whole conversation to the model as a side request.
// It reads the main cache, so it keeps it warm, but it is no turn, so no
// turn.step fires for it (#15). Only a warm cache counts: a cold one the side
// request may not write back at the main TTL, so the band stays honest. A bare
// /btw asks nothing and sends nothing.
async function sideRequest($, e, next) {
  const now = await $.clock.now()
  const asks = e.command !== 'btw' || String(e.args ?? '').trim() !== ''
  if (asks && mainAt && mainAt + cfg.mainTtl > now) restartMain(now)
  return next(e)
}

// Once a second: warn near expiry, note when it goes cold, redraw the band
async function tick($) {
  await pollUsage($, await $.clock.now())
  const s = snapshot(await $.clock.now())
  if (mainAt && s.left > 0 && s.left <= cfg.warn && !warned) {
    warned = true
    // Idle and nothing done since the user's last message: act while the cache is warm
    if (cfg.onWarning !== 'off' && !working && !handedOff) {
      handedOff = true
      const file = handoffPath(cfg.handoffDir || (await $.session.root()), await $.session.id())
      $.ui.toast('Prompt cache goes cold in ' + clock(s.left) + '. No reply, so Claude is writing ' + file.split(/[\\/]/).pop() + ' while it is warm.', { timeoutMs: 10_000 })
      $.prompt.submit({ text: handoffText(file) }).catch(() => {}) // waits for idle; don't await in the tick
    } else {
      $.ui.toast('Prompt cache goes cold in ' + clock(s.left) + '. Send something to keep it warm.', { timeoutMs: 10_000 })
    }
    if (cfg.sound) $.audio.play({ asset: 'sounds/cooling.wav' }).catch(() => {})
  }
  if (mainAt && s.left <= 0 && !wentCold) {
    wentCold = true
    $.ui.toast('Prompt cache is cold. The next message re-sends the whole context at full price.')
  }
  $.ui.invalidate('ui.render')
}

export function register(on, options) {
  on('session.start', async ($, e, next) => {
    // Headless (-p, SDK): no band, and the timer would submit handoff turns
    // or compact with nobody at the prompt. Do nothing.
    headless = e.isInteractive === false
    if (headless) return next(e)
    await loadConfig($, options)
    // classic.SessionStart fires before this, so the transcript path is known: read the TTL here
    await readTtl($).catch(() => undefined)
    const measured = await $.session.usage()
    context = measured.context
    if (measured.rateLimits?.length) limits = measured.rateLimits
    await $.command.register({ name: 'cache-clock', description: 'Print the cache countdown and context use' })
    $.clock.every(1000, () => tick($))
    return next(e)
  })

  // On a resume, the session tells us how long ago the last answer was,
  // so the clock picks up where it left off. This fires before session.start, so
  // it can't tell a headless session yet: session.start does the TTL read.
  on('classic.SessionStart', async ($, e, next) => {
    transcript = e.transcript_path ?? transcript
    if (e.seconds_since_last_response != null) mainAt = (await $.clock.now()) - e.seconds_since_last_response * 1000
    return next(e)
  }).catch(($, e, next) => (next.called ? undefined : next(e))) // never block the session on our error

  // Track whether a turn is running, so the warning action never queues behind one
  on('turn.start', async ($, e, next) => { working = true; return next(e) })
  on('turn.complete', async ($, e, next) => { working = false; return next(e) })

  // A prompt from the user (not our own handoff) re-arms the warning action
  on('prompt.submit', async ($, e, next) => {
    if (!String(e.text ?? '').includes(HANDOFF_MARKER)) handedOff = false
    return next(e)
  })

  // Every request to the model refreshes its cache: restart the right clock
  on('turn.step', async function* ($, e, next) {
    const now = await $.clock.now()
    if (e.agentId) subAt = now
    else restartMain(now)
    yield* next(e)
  })

  // /recap and /btw: a side request that keeps the main cache warm
  // (a hook that fails is skipped and the command still runs)
  on('command.run', { command: 'recap' }, sideRequest)
  on('command.run', { command: 'btw' }, sideRequest)

  // After each turn, check which TTL the API actually used
  on('classic.Stop', async ($, e, next) => {
    transcript = e.transcript_path ?? transcript
    if (!headless) await readTtl($)
    return next(e)
  }).catch(($, e, next) => (next.called ? undefined : next(e)))

  // Context figures, pushed after each turn
  on('session.measure', async ($, e, next) => {
    context = e.context
    if (e.rateLimits?.length) limits = e.rateLimits // an empty list means none reported this time, not none used
    return next(e)
  })

  // The line above the prompt, with the other mods' bands drawn under it: the tray
  // (details to the left, icons at the right), or with style full upstream's whole line
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const s = snapshot(await $.clock.now())
    const shown = cfg.style === 'full' ? ITEMS : shownItems(manual, dismissed, redItems(s))
    // Our line takes one row, so the bands below get one fewer
    // A band below that fails must not take ours with it
    let below = null
    try { below = await next({ ...e, props: { ...e.props, maxRows: Math.max(0, e.props.maxRows - 1) } }) } catch {}
    const { Box, Text, Button } = $.ui.resolve(e)
    const cachePiece = { item: 'cache', text: '◷ ' + s.cache, style: { color: s.color, bold: s.color === 'red' } }
    const ctxPiece = { item: 'context', text: s.ctx, style: s.ctxTone ? { color: s.ctxTone, bold: s.ctxTone === 'red' } : {} }
    const subPiece = s.sub && { item: 'cache', text: s.sub, style: { dimColor: true } }
    const ttlPiece = { item: 'cache', text: s.ttl, style: { dimColor: true } }
    const usagePiece = { item: 'usage', text: s.usageText, style: s.usageTone ? { color: s.usageTone, bold: s.usageTone === 'red' } : {} }
    const jobsPiece = s.jobsText && { item: 'usage', text: s.jobsText, style: s.hasJobs ? {} : { dimColor: true } }
    // Pieces in order of importance, those of the items that show; drop from the end until they fit the room left
    const pieces = [cachePiece, ctxPiece, usagePiece, jobsPiece, subPiece, ttlPiece].filter((p) => p && shown.includes(p.item))
    const TRAY_COLUMNS = 48 // '● 🕐 cache   ● ◔ context   ● ⏳ usage   open' and a margin
    const room = cfg.style === 'full' ? e.props.bodyColumns : e.props.bodyColumns - TRAY_COLUMNS
    const SEP = '  ·  '
    while (pieces.length > 1 && pieces.map((p) => p.text).join(SEP).length > room) pieces.pop()
    const parts = pieces.flatMap((p, i) => i ? [h(Text, { dimColor: true }, SEP), h(Text, p.style, p.text)] : [h(Text, p.style, p.text)])
    const details = h(Text, { wrap: 'truncate-end' }, ...(parts.length ? parts : ['']))
    let line = h(Box, {}, details)
    if (cfg.style === 'tray') {
      // A click opens that icon's details, or closes them, read against the moment of the click
      const press = (item) => () => pressNow($, item)
      // An item's colour (0.14.0). The desktop draws a Button as a native button whose text takes no
      // colour, whatever Text it holds. So on the desktop the
      // icon is the button (click it) and the word beside it is plain Text, which does take colour:
      // the cache green while warm, every item yellow, then bold red. The terminal keeps 0.10's
      // word button with a dot in front for yellow and red.
      const coloured = e.surface === 'desktop'
      const chip = (item, icon, tone) => {
        const hot = tone === 'yellow' || tone === 'red'
        if (!coloured) {
          return [...(hot ? [h(Text, { color: tone }, '● ')] : []),
            h(Button, { key: item, label: item, plain: true, dimColor: !shown.includes(item), onPress: press(item) })] // words only (0.19.0)
        }
        const lit = hot || tone === 'green'
        return [h(Button, { key: item, label: icon, plain: true, onPress: press(item) }),
          h(Text, lit ? { color: tone, bold: tone === 'red' } : { dimColor: !shown.includes(item) }, ' ' + item)]
      }
      // With the usage details open and a report this week: open it in Obsidian
      const openButton = shown.includes('usage') && s.hasJobs ? [h(Text, {}, '  '), h(Button, { key: 'usage-open', label: 'open', plain: true, onPress: async () => {
        const env = await $.env.get('OS')
        const os = env === 'Windows_NT' ? 'windows' : (await $.env.get('__CF_USER_TEXT_ENCODING')) !== undefined ? 'mac' : 'linux'
        const path = cfg.jobsDir.replace(/[\\/]+$/, '') + '/' + usage.file
        await $.process.run(openCommand(os, path, cfg.openUrl)).catch(() => $.ui.toast('Could not open ' + usage.file))
      } })] : []
      let tray
      if (coloured && cfg.tray === 'client') {
        // The desktop tray (0.15.0): icon and word drawn together as coloured text by hooks/tray.js
        // in a Client, which posts { press } back here (ui.message below) when an item is clicked
        const { Client } = $.ui.resolve(e)
        const entry = (item, text, tone) => {
          const lit = tone === 'yellow' || tone === 'red' || tone === 'green' || tone === 'cyan'
          return lit ? { item, text, color: tone, bold: tone === 'red' } : { item, text, dim: !shown.includes(item) }
        }
        // Words only, no icons; the icon buttons below stay for CACHE_CLOCK_TRAY=buttons, where they are the click
        const items = [entry('cache', 'cache', s.color), entry('context', 'context', s.ctxTone), entry('usage', 'usage', s.usageTone)]
        // No width (0.15.2): the region is as wide as what tray.js draws, measured by the surface. 0.15.0
        // sized it by character count and the desktop's wider ◷/◔ pushed ⧗ usage past its edge, out of
        // reach of clicks; 0.15.1's 6 spare cells fixed that but left blank space.
        tray = h(Box, {}, h(Client, { key: 'tray', module: './tray.js', props: { items, gap: 3 }, height: 1 }), ...openButton)
      } else {
        tray = h(Box, {},
          ...chip('cache', s.icon, s.color),
          h(Text, { dimColor: true }, ' │ '), // a dim divider between items (0.18.0)
          ...chip('context', s.ctxIcon, s.ctxTone),
          h(Text, { dimColor: true }, ' │ '), // a dim divider between items (0.18.0)
          ...chip('usage', coloured ? '⧗' : '⏳', s.usageTone),
          ...openButton)
      }
      line = h(Box, { justifyContent: 'space-between' }, details, tray)
    }
    return below ? h(Box, { flexDirection: 'column' }, line, below) : line
  })

  // A click in the desktop tray's Client: data is the module's post, checked before use
  on('ui.message', async ($, e, next) => {
    if (e.element !== 'tray') return next(e)
    const item = e.data && typeof e.data === 'object' ? e.data.press : undefined
    if (ITEMS.includes(item)) await pressNow($, item)
    return {}
  })

  on('command.run', { command: 'cache-clock' }, async ($) => {
    await readTtl($)
    return { text: asText(snapshot(await $.clock.now())) }
  })
}
