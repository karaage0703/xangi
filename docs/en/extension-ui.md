# A practical guide to building extension UIs

These recommendations and examples help people and AI start building without unnecessary uncertainty. **They are not mandatory rules, a compliance gate, or a requirement to make every screen look alike.** Prioritize the user's preferences, the purpose, and the intent of the existing product. Choose colors, typography, spacing, layouts, and frameworks freely; alternatives need no exception request or separate approval.

When nothing has been specified, the host's `web-ui/src/styles.css`, `ThemeSelect.tsx`, and the template offer starting points. Reuse the parts that help.

## Visual starting points

- A neutral light palette might use canvas `#f7f6f3`, surface `#fff`, text `#37352f`, and border `#d8d7d4`; dark counterparts might be `#202020`, `#191919`, `#efefed`, and `#40403d`. Matching these colors is optional.
- The host's blue is one action-color example. Light `#155f9f` and dark `#8dc6f3` can provide readable text/button combinations. Brand and user-selected colors are equally valid. Accessibility measures such as 4.5:1 for normal text and 3:1 for control boundaries/focus help assess actual combinations.
- System sans-serif with Japanese fallbacks, body text around 14–16px at 1.5–1.75 line-height, page titles around 20–22px, and content headings around 24–28px and 18–20px are useful starting points. Code and telemetry may benefit from monospace and tabular numbers.
- A 4px spacing scale, roughly 16px outer padding on phones and 24px on desktop, 6–8px radii, and quiet borders are examples to adjust for density and working area.
- Distinguishable hover, focus-visible, disabled, pending, and error states help users act confidently. Touch targets around 44px, labels, explanations, and status text independent of color are useful considerations.

Brief design notes can help the next person or AI understand choices. They are not paperwork for justifying differences.

## Home, Back, and Forward

A useful default is for the host to provide xangi-wide Home and navigation while the extension provides domain lists, details, and editing. Custom navigation is also a valid choice.

- **xangi Home** leads to the host's `/` (normally Chat), distinct from an extension's own list or application home. A host shortcut inside an iframe can use a known host URL and `target="_top"` so the host does not open inside the frame. Standalone servers can expose a shortcut when the destination is known rather than guessing it.
- **Host Back/Forward** traverse native browser history, including iframe links and hash/pushState entries recorded by the extension. They do not undo saved data or restore application state that was never recorded in URL/history.
- **Domain Back/Close** can return to a list, close a dialog, or finish editing. Choose labels that explain the action. Saving, restoration, and leave confirmation are possible ways to handle unsaved input.

The current host uses `history.back()` and `history.forward()` without a separate URL stack. The top-level Navigation API does not report child-frame entries, so controls stay usable while displaying an extension and let the browser decide where to go. No destination means no movement. Ordinary host pages use available boundary information; browsers without that API leave controls usable.

The host does not delete extension-owned Home or Back controls by ID or label. Extensions that prefer fewer duplicate controls can use the appearance hints below and their own CSS to hide a shared Home link. Controls with save/leave handling and custom navigation can remain.

## Optional theme integration

The current `ExtensionView` supplies `data-xangi-embedded="true"`, resolved `data-theme="light|dark"`, and `color-scheme` to same-origin iframe roots after load and when the host theme changes. These are appearance hints, not authentication or permission signals. They do not apply across origins; no postMessage API is provided.

To follow the host, an implementation can also read the same-origin `localStorage["xangi-theme"]` preference (`light`, `dark`, `system`), use the OS when absent, follow OS/storage changes, and keep controls usable when storage is unavailable. Preferences are origin-scoped, not synchronized across hosts, ports, or instances. Independent palettes/settings and theme-independent canvases or images are valid choices too.

Preserve existing preferences rather than overwriting them merely to align appearances.

## Domain choices

Reading/mail/tasks can prioritize text measure and density; editors can prioritize editing/comparison panes; monitors can prioritize values, trends, units, and stale-data explanations. Terminal ANSI colors, remote images, transparent/chroma-key avatar backgrounds, and device-specific presentation need not match ordinary settings pages.

## Verification examples

AI chooses a suitable implementation from the user's wishes, existing screens, and relevant references. Templates are examples, not mandatory SDKs or components.

For changed screens, trying open → primary action → result → return under relevant desktop/mobile and light/dark conditions helps catch mistakes. Home destinations, navigation inside/outside the extension, keyboard use, long content, empty/loading/error states, and theme changes are useful checks. Report what was checked and what remains unknown so later work can build on it.

Supporting reference: [DADS accessibility](https://design.digital.go.jp/dads/guidance/accessibility/). External designs can also inform choices.

## Check the experience inside the host

When relying on shared host navigation, avoid repeating Home/Back/Forward in the embedded page while keeping domain controls such as lists and settings. Check whether centered outer containers add another gutter inside the host rail. Reading-width limits can apply to the text region rather than the entire tool or classification layout.

Use a single product-name heading, omitting repeated labels, oversized headings, or descriptions that simply restate an action when unnecessary. Compare embedded and standalone views at desktop and mobile widths, opening the extension through the actual host and trying shared Back/Forward/Home. This checks how the parts work together without prohibiting custom visual designs or domain navigation.

## Mobile starting point

Following Tasks, a mobile view can show a compact app name with needed list/settings controls in one row around 60px high. Do not create an empty header when no controls are needed. Keep account, classification, refresh, and add actions in the domain area so users reach content quickly. A list-first landing page can show the list itself, reserving modal drawers for explicit user actions. The template shows a compact name on phones as a default example; desktop, specialized tasks, and user preferences can use other arrangements.
