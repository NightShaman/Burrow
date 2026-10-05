<picture>
  <source media="(prefers-color-scheme: dark)" srcset="brand/svg/shipstyles-lockup-horizontal-white.svg">
  <img src="brand/svg/shipstyles-lockup-horizontal.svg" alt="ShipStyles" width="320">
</picture>

Ship styled UI packages without CSS imports or bundler setup.

[![npm version](https://img.shields.io/npm/v/shipstyles.svg)](https://www.npmjs.com/package/shipstyles)
[![CI](https://github.com/ealush/shipstyles/actions/workflows/test.yml/badge.svg)](https://github.com/ealush/shipstyles/actions)
[![license](https://img.shields.io/github/license/ealush/shipstyles.svg)](LICENSE)
[![bundle size](https://img.shields.io/bundlephobia/minzip/shipstyles.svg)](https://bundlephobia.com/package/shipstyles)
[![TypeScript](https://img.shields.io/npm/types/shipstyles.svg)](https://www.npmjs.com/package/shipstyles)

## Why ShipStyles?

Applications can dictate their stack; packages cannot. A shared component
must bring its styles along and behave in bundlers, frameworks, and server
runtimes it has never seen:

- **No consumer setup** — styles ship inside the JavaScript. No CSS files to
  import, no bundler plugins to configure.
- **No collisions** — every declaration becomes its own hashed, deduplicated
  atomic class, scoped to your package.
- **SSR from day one** — `sheet.getStyle()` returns the whole stylesheet as
  a string; the client adopts the server tag instead of mounting a duplicate.
- **Portable** — works in the browser, in Shadow DOM, and with CSP nonces.

## Installation

```bash
npm install shipstyles
```

## Usage

```javascript
import { createSheet, cx } from 'shipstyles';

const sheet = createSheet('MyComponent');

const styles = sheet.create({
  button: {
    color: 'red',
    ':hover': {
      color: 'blue',
    },
  },
});

const Button = () => <button className={cx(styles.button)}>Hover Me</button>;
```

## Environment support

Browser, SSR, Shadow DOM, and CSP nonce environments. Ships ESM and CJS
from the same package:

```javascript
import { createSheet, cx } from 'shipstyles'; // ESM
const { createSheet, cx } = require('shipstyles'); // CJS
```

## Migrating from FlairUp

Upgrading from the `flairup` package? See [MIGRATION.md](MIGRATION.md). The
API and runtime styling behavior are unchanged.

## Battle-tested

ShipStyles is the continuation of FlairUp, which ships in production inside
[Emoji-Picker-React](https://github.com/ealush/emoji-picker-react).

## What `create()` returns

`create()` returns a `Record` mapping each scope name to a `Set` of class
names — one entry per scope, not a single `Set`:

```javascript
const styles = sheet.create({
  button: { color: 'red' },
  title: { color: 'blue' },
});

styles.button; // Set { 'MyComponent_abc123' }
styles.title; // Set { 'MyComponent_def456' }

cx(styles.button); // "MyComponent_abc123"
```

One atomic class is generated per CSS declaration:

- Each plain declaration (for example `color: 'red'`) gets its own class and
  its own single-declaration rule. Identical declarations are emitted once
  and shared across scopes. Distributive shorthands are the exception:
  `margin: '2px'` expands into one class per physical side (never
  logicals), multi-value forms distribute positionally, and anything
  that cannot be split soundly stays one atomic class — see the
  shorthand rules under `cx()` below.
- Each conditional declaration (inside a pseudo selector, postcondition, or
  media query) gets its own class, so conditional styles compose
  independently.
- Each CSS variable gets its own single-declaration rule — variables are no
  longer grouped into one class per scope.

Property names are written in camelCase and emitted in dash-case
(`backgroundColor` → `background-color`), so both spellings share one
deduplication entry.

## `cx()` composition

`cx()` accepts strings, arrays, `Set`s, and objects (truthy keys win), and
returns a single class string:

```javascript
cx('a', ['b', 'c'], { d: true, e: false }); // "a b c d"
cx(styles.button, styles.title);
```

When classes conflict, the last one passed to `cx()` wins — regardless of the
order the styles were created in:

```javascript
const red = sheet.create({ red: { color: 'red' } });
const blue = sheet.create({ blue: { color: 'blue' } });

cx(red.red, blue.blue); // "...blue..." — blue wins
cx(blue.blue, red.red); // "...red..." — red wins
```

Conflict rules:

- Conflicts are resolved per context. The same property set globally,
  under `:hover`, and under a media query never conflicts with itself —
  each context keeps its class.
- Shorthand/longhand overlap in the same context follows `cx()` order per
  side: distributive shorthands (`margin`, `padding`, `inset`, `gap`,
  `overflow`, border widths/styles/colors, `border-radius`) expand into
  one atomic class per longhand, so a later `margin-top` wins only its
  side while the other sides survive. Box shorthands emit only the four
  physical sides (they set no logicals); multi-value forms distribute
  positionally per CSS, and elliptical radii translate each corner to
  its space-separated form. Values that cannot be split soundly (any
  top-level bare `var()`/`env()`/`attr()` reference, over-count values,
  repeated slashes) and non-distributive shorthands (`background`,
  `font`, `border`, ...) stay one atomic class.
- Each CSS variable is its own conflict domain: overriding `--tone` keeps
  an unrelated `--space` from the same scope.
- Classes from different contexts (pseudo selectors, media queries) are
  always preserved.
- Unknown classes (for example utility classes) pass through untouched, and
  repeated classes are deduped.

Edge cases:

- Partial overlap drops the whole earlier class. An atomic shorthand that
  stays atomic (`background`, `font`, `border`, an opaque `var()` margin)
  resolves as one unit: if a later class overlaps any of its conflict keys,
  the earlier class is removed entirely — deterministically, regardless of
  creation order. That means non-overlapping declarations go with it:
  `cx({ background: 'red url(a.png)' }, { backgroundColor: 'blue' })`
  yields blue with no image. When those declarations matter, give each
  visual state its own complete scope instead of layering.
- `border` also resets `border-image`, so `border-image` (and its
  longhands) belong to `border`'s conflict set: a later `border` replaces
  an earlier image, and a later image replaces an earlier `border`.
- `!important` survives shorthand expansion: `margin: '2px !important'`
  still emits four longhands, each carrying the flag.

## `createSheet()` options and mounting

```javascript
const sheet = createSheet('MyComponent');
```

With explicit mount options:

```javascript
const sheet = createSheet('MyComponent', { rootNode, nonce });
```

Calling `createSheet(name)` mounts one `<style id="flairup-{name}">` tag into
`document.head` and keeps it synchronized after every `create()` and
`keyframes()` call. `getStyle()` returns the sheet's CSS text, and
`isApplied()` reports whether a style tag is mounted.

The second argument controls where (and whether) the tag mounts:

- `{ rootNode }` — mount under a specific `HTMLElement` or `ShadowRoot`,
  so styles work inside Shadow DOM. A bare element may also be passed
  directly as the second argument.
- `{ rootNode: null }` — never mount a tag. Use this on the server (or in
  tests) and read the CSS with `getStyle()`.
- `{ nonce }` — set a `nonce` attribute on the style tag for
  Content-Security-Policy environments. The nonce is also applied to an
  adopted server-rendered tag.

Sheets with the same name and the same mount target share one style element
and its CSS state: writes from any handle are visible through every handle,
and identical declarations are still emitted only once. Different names, or
the same name under different roots, stay isolated.

## Keyframes

`sheet.keyframes()` defines animations and returns a `Record` mapping each
keyframe name to its generated (hashed) animation name. Names are prefixed
with the sheet name and numbered independently of created styles:

```javascript
const sheet = createSheet('Spinner');

const { spin } = sheet.keyframes({
  spin: {
    from: { transform: 'rotate(0deg)' },
    to: { transform: 'rotate(360deg)' },
  },
});
// spin === 'Spinner_0_spin'

const styles = sheet.create({
  icon: {
    color: 'red',
    animationName: spin,
    animationDuration: '1s',
    animationIterationCount: 'infinite',
  },
});
```

The `@keyframes` rules are written into the same style element as the rest of
the sheet's CSS.

## Conditions

### Scoping styles under a known class name (preconditions)

Nest scopes under a condition key to apply them only beneath a known
selector:

```javascript
const styles = sheet.create({
  '.theme-dark': {
    button: {
      color: 'red',
      ':hover': {
        color: 'blue',
      },
    },
  },
  button: {
    color: 'green',
  },
});
```

### Scoping lower level styles under a selector (postconditions)

Nest condition keys inside a scope to target lower level elements. All of
the following prefixes are supported:

- `.class` — descendant class: `'.menu'` → `.hash .menu`
- `:pseudo` / `::element` — pseudo selectors and elements: `':hover'`,
  `'::before'`
- `>` / `+` / `~` — combinators: `'> .icon'`, `'+ .next'`, `'~ .sibling'`
- `*` — universal selector, with or without a suffix
- `&.class` — same element plus a class, no space: `'.hash.active'`
- `&:pseudo` — same element plus a pseudo selector, no space:
  `'.hash:hover'`

```javascript
const styles = sheet.create({
  button: {
    '.menu': {
      color: 'red',
    },
    '&.active': {
      color: 'blue',
    },
  },
});
```

Postconditions chain with preconditions and media queries, joining nested
levels with a space (except `&` conditions, which attach directly).

### Media queries

```javascript
const styles = sheet.create({
  button: {
    color: 'red',
    '@media (max-width: 600px)': {
      color: 'blue',
    },
  },
});
```

The same declaration inside and outside a media query gets distinct classes,
so global and media rules never clash or collapse into each other.

### Pseudo selectors and pseudo elements

```javascript
const styles = sheet.create({
  button: {
    color: 'red',
    ':hover': {
      color: 'blue',
    },
    '::before': {
      content: '•',
    },
  },
});
```

### CSS variables

```javascript
const styles = sheet.create({
  button: {
    '--': {
      '--color': 'red',
      '--hover-color': 'blue',
    },
  },
});
```

Each variable produces its own single-declaration rule, so one variable can
be overridden (via `cx()` order) without affecting the others.

### Custom class names

```javascript
const styles = sheet.create({
  button: {
    '.': 'my-button', // or ["my-button", "button-main"]
    color: 'red',
  },
});
```

Custom classes are added to the scope's `Set` as-is, alongside the generated
classes.

## SSR

Render the sheet's CSS into a style tag whose `id` matches the sheet
(`flairup-{name}`). On the client, `createSheet()` with the same name adopts
that tag instead of mounting a duplicate, preserving the server CSS and
appending only new rules:

> ShipStyles 1.x intentionally retains the legacy `flairup-` style-tag
> prefix for hydration compatibility. Treat the generated ID as an
> implementation detail; it may change in a future major version.

```jsx
import { createSheet } from 'shipstyles';

const sheet = createSheet('MyComponent');

export function SSRStyles() {
  if (sheet.isApplied()) {
    return null;
  }

  return (
    <style
      id="flairup-MyComponent"
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: sheet.getStyle() }}
    />
  );
}
```

Place `<SSRStyles />` anywhere inside your component. When there is no
server tag (pure client render), the sheet mounts its own tag as usual.

## What does the output look like?

Given this input:

```javascript
import { createSheet } from 'shipstyles';

const sheet = createSheet('Button', null);

const styles = sheet.create({
  button: {
    color: 'red',
    '--': { '--bg': 'white' },
    ':hover': { color: 'blue' },
    '@media (max-width: 600px)': { color: 'green' },
  },
});

const { fade } = sheet.keyframes({
  fade: { from: { opacity: '0' }, to: { opacity: '1' } },
});
```

`sheet.getStyle()` returns exactly this CSS:

```css
.Button_wqxq0q {color:red;}
.Button_x5i9n8 {--bg:white;}
.Button_-w97goy:hover {color:blue;}
@media (max-width: 600px) {
.Button_se7zu2 {color:green;}
}
@keyframes Button_0_fade {
from { opacity:0; }
to { opacity:1; }
}
```

Each declaration produces one atomic class with one single-declaration
rule, conditional declarations get their own classes, and keyframes are
named `{sheet}_{n}_{name}`. Exact class hashes vary with the sheet name and
creation order.
