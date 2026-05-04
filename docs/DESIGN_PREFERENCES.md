# Design Preferences

Running notes on UI conventions for tournament-manager. When a rule here
contradicts an ad-hoc styling choice in code, the code is wrong — bring it
back in line with this doc. Additions come from iterative feedback; date
entries when you add new ones.

---

## Destructive-action confirmations

**Rule.** Every "are you sure?" prompt goes through a shared
`ConfirmModal` component — **never** `window.confirm()` /
`window.alert()` / `window.prompt()`.

**Why.**
- Native browser dialogs look like OS chrome, which breaks the app's visual
  language mid-flow.
- They block the JS event loop; in-app modals don't.
- They can't carry rich copy, multiple paragraphs, checkboxes, or secondary
  affordances (e.g. a "don't show again" toggle later).
- Some browsers throttle or auto-dismiss native confirms in
  iframes/background tabs.
- They're unstyled on mobile PWAs.

**Implementation pattern.**
```tsx
const [show, setShow] = useState(false);
...
<button onClick={() => setShow(true)}>Delete</button>
{show && (
  <ConfirmModal
    title="Delete this sequence?"
    body="It'll be removed from the queue."
    confirmLabel="Delete"
    onCancel={() => setShow(false)}
    onConfirm={async () => {
      await deleteIt();
      setShow(false);
    }}
  />
)}
```

Use `destructive={false}` for non-destructive confirms (accept a change,
apply a migration, etc.) to flip the primary button from red to blue.

**Do not** reach for `confirm()` "just for a second" — every one we've ever
written ends up needing richer copy within a week.

---

## Aligned row indicators

**Rule.** When a list shows **conditional status icons per row** (flags,
dismiss buttons, tags, etc.), reserve a **fixed-width slot** for each
possible icon so icons line up vertically across rows, regardless of
which ones apply to a given row.

**Why.** Unaligned icons — where icon X appears further right on one row
than on another because the row before it had fewer icons — is visually
noisy. The eye loses the ability to scan a single column for presence /
absence of a given indicator.

**Implementation pattern.**
- Use a flex container of equal-width `<div>` slots.
- Each slot renders either the icon button OR an empty placeholder of the
  same width.
- Keep the slot ORDER stable across all rows.
- Icon buttons themselves share size via a helper (e.g. `iconBtnStyle`).

**Do not** render icons as `{cond && <Icon/>}{cond2 && <Icon/>}...` inside
a plain flex container — that's what collapses alignment across rows.

---

## Icon button sizing

All inline status-icon buttons in list rows use **22×22 px** with a 28px
slot (gives a 3px gutter on each side). Single-character glyph at 12–14
px for icons, `1px solid` border with semantic color. Define a shared
`iconBtnStyle()` helper and reuse it for every slot of the same species.

---

## Amber = flag / note-to-self

The "flagged for review / note from the user" family uses the amber palette:
- Background: `#fffbeb` / `#fef3c7`
- Border: `#fde68a`
- Text: `#92400e` / `#7a5d00`
- Flag icon: `#d97706`

When a flag has a saved note, its pencil indicator fills with that
palette — empty state uses neutral gray (`#9ca3af` text, `#e2e2e2`
border). Keeps "has note" / "no note" distinguishable at a glance.
