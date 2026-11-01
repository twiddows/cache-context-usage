// The tray's desktop surface module (0.15.0): draws the items as coloured text, icon and word
// together, and turns a click into a post back to the hooks module. A desktop Button is the app's
// native button and takes no colour, so the tray is text, and a Client is the one element whose
// own region reports where a click landed (the column, counted in cells).
//
// props: { items: [{ item, text, color?, bold?, dim? }], gap }
// posts: { press: '<item>' } on a left click over an item's text

// Which item a column falls in: the items laid out left to right, `gap` cells between them. Forgiving
// (0.15.1): a gap is split down its middle and the last item takes everything to its right, so a
// glyph the surface draws wider than one cell (◷, ◔) cannot push a click off the item it was meant for.
export function itemAt(items, gap, x) {
  if (!items.length || x < 0) return null
  let col = 0
  for (let i = 0; i < items.length; i++) {
    const end = col + Array.from(items[i].text).length
    if (i === items.length - 1 || x < end + gap / 2) return items[i].item
    col = end + gap
  }
  return null
}

export default function tray(props, surface) {
  const { Box, Text } = surface.elements
  const items = props?.items ?? []
  const gap = props?.gap ?? 3
  surface.onPointer((ev) => {
    if (ev.type !== 'down' || (ev.button && ev.button !== 'left')) return
    const item = itemAt(items, gap, ev.x)
    if (item) surface.post({ press: item })
  })
  const children = []
  // A dim divider centred in each gap (0.18.0): ' │ ' for the default gap of 3
  const divider = gap >= 3 ? ' '.repeat(Math.floor((gap - 1) / 2)) + '│' + ' '.repeat(gap - 1 - Math.floor((gap - 1) / 2)) : ' '.repeat(gap)
  items.forEach((it, i) => {
    if (i) children.push(Text({ dimColor: true, children: divider }))
    const style = it.color ? { color: it.color, bold: !!it.bold } : { dimColor: !!it.dim }
    children.push(Text({ ...style, children: it.text }))
  })
  return Box({ children })
}
