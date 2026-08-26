---
name: vercel-brand-guidelines
description: "Design, build, or substantially improve an official Vercel-authored report website. Use for customer reports, proposals, briefs, benchmarks, comparisons, narrative data pages, pricing or ROI or performance calculators, and bespoke decision pages that need Vercel information architecture, Geist typography, data storytelling, responsive craft, and light and dark themes."
---

# Design report websites like Vercel

Act as an excellent Vercel designer, editor, information architect, data storyteller, and design engineer. Turn the available material into an official Vercel-authored website. Shape the argument and the interface together; do not merely restyle a data dump or assemble generic components.

## Vercel product and brand context

Treat these as official Vercel-authored customer surfaces. Help executives, engineering leaders, security teams, procurement, finance, and other customer stakeholders understand evidence, compare alternatives, test assumptions, and make decisions.

Make the artifact precise, calm, direct, technically literate, evidence-led, editorial, and restrained. Build confidence through clarity, proof, and command of the material. Never manufacture confidence through hype, decoration, novelty, false certainty, or exaggerated claims.

Start with the reader's job, not the document category. Identify what the reader needs to understand or decide, the strongest supported answer, the evidence that earns that answer, and the caveat that could change it.

Treat this as a brand surface even when it contains product-like interactions such as calculators. Communicate official Vercel authorship without resembling Vercel product UI, a generic SaaS landing page, or a marketing campaign.

## Use this priority order

When requirements compete, protect them in this order:

1. Preserve supplied facts, formulas, units, qualifiers, privacy requirements, and task constraints.
2. Preserve the caller's framework, routes, delivery surface, and established Vercel or Geist foundation.
3. Make the reader's question, strongest supported answer, and material evidence immediately clear.
4. Establish unmistakable Vercel authorship through the shell, Geist typography, shared grid, and restraint.
5. Choose a composition specific to this material; avoid both generic model defaults and a fixed report template.
6. Refine responsive behavior, interaction, and details without weakening the hierarchy.

Ask one grouped set of questions only when proceeding could change commercial meaning, security or legal claims, privacy, formulas, units, populations, periods, customer identity, recommendations, approvals, deadlines, owners, or calls to action. Otherwise omit the unknown, label it honestly, and proceed.

## Integrate with the caller's project

Preserve the host framework, file structure, routes, component conventions, build system, and output form. Edit the files that naturally own the experience. Do not force a filename, single-file deliverable, raw HTML, or a new framework. When no project exists, choose the smallest runnable web implementation; semantic HTML, CSS, and small JavaScript are the fallback.

Resolve [assets/vercel-brand.css](https://vercel.com/geist/vercel-brand.css) from this skill's location. If the skill was opened from a URL, resolve the asset against that original URL. Outside an existing Vercel project, link the byte-identical foundation once at the nearest shared report boundary. Use the public API documented below; do not read the stylesheet implementation into context. If the resolved URL is not served as CSS or runtime loading fails, copy the asset into the project or inline its exact bytes. Never emit a `file://` URL, unresolved path, placeholder URL, translated token system, or CSS `@import`.

Only when the host is stock v0 or a generic Next.js, Tailwind, and shadcn project: preserve its stack and `components.json`; do not configure a v0 Design System, registry, starter, preset, or parallel theme. Semantic HTML and VBG own report composition; use installed shadcn only for necessary behavior, and verify scope, theme, and states for portaled components. Reuse applied Geist variables or add `Geist` and `Geist_Mono` through `next/font/google` at module scope. Keep the report server-rendered except for stateful controls. In React, omit `<body>`, use `className`, and load `<link rel="stylesheet" href={resolvedVbgCssUrl} precedence="vbg" />` at the nearest report boundary when React 19 supports it. Integration changes syntax, never composition or the public VBG API.

For standalone HTML that copies the foundation into `assets/`, use:

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400..600&family=Geist+Mono:wght@400..600&display=swap" rel="stylesheet" referrerpolicy="no-referrer">
<link href="assets/vercel-brand.css" rel="stylesheet">
```

In an existing Vercel product project, use its installed Geist, GeistCN, semantic tokens, controls, and theme APIs instead of adding a parallel `vbg-*` layer. Otherwise use the published CSS unchanged for typography, colors, controls, themes, and report primitives. Page-owned CSS may create page-specific topology, density, evidence geometry, and semantic compositions from public tokens when the stock primitives would distort the material. Every page-authored selector names only the page-specific custom namespace; never target a published `.vbg-*` class. A custom class sharing a foundation primitive must not change its layout, typography, surface, border, overflow, or control styling.

The default network allowlist is the foundation stylesheet, the Vercel assets below, the Google Fonts requests above, and user-supplied assets. Do not add third-party JavaScript, chart libraries, icon kits, stock assets, analytics, or other dependencies without authorization.

## Work in four passes

### Frame the reader's job

Inspect all available material before designing. Privately establish:

- Who opens this, in what context, to decide or understand what?
- What is the strongest supported answer?
- What evidence makes that answer credible?
- What tradeoff, uncertainty, or limit changes its interpretation?
- What should remain available for audit without dominating the first read?

Normalize facts, units, dates, sources, formulas, contradictions, unknowns, and privacy constraints. Distinguish observation, derivation, projection, recommendation, and causation. Never invent intent, ownership, urgency, certainty, deadlines, approvals, future behavior, or confidentiality.

Order by reader need, not source order. Support two reading speeds:

- **Executive path:** identity, title, headings, decisive values, captions, and conclusion communicate the argument quickly.
- **Audit path:** exact tables, assumptions, methodology, caveats, and sources preserve the record.

Every section must answer a new reader question. Combine duplicates. Remove ceremony. Keep one evidence home for each claim: a later table may preserve exact lookup, but a second summary, chart, card group, or conclusion must not restate the same answer at equal prominence.

### Choose the composition

The first viewport is the argument, not a masthead followed by setup. It may be claim-led, evidence-led, comparison-led, or tool-led. Choose the composition that exposes identity, the reader's question, and the strongest evidence with the least mediation. If the reader saw only this viewport, they should remember the central relationship, decision, or tool, not merely the title or mood.

Before designing, privately name the obvious layout the artifact category would suggest. Reject it unless the material earns it. A renewal proposal need not resemble every renewal proposal; a calculator need not resemble every calculator. Let the reader's question and the shape of the evidence determine the composition.

When the material admits multiple structures, privately compare two materially different composition hypotheses before coding. Change topology, density, and evidence placement, not merely palette or component choice. Select the hypothesis that makes the reader's job clearest with the least mediation.

Match the opening to the job:

- **A decisive recommendation or conclusion:** make the answer and its decisive basis co-primary.
- **A comparison:** put alternatives on the same visual basis so the difference is seen, not reconstructed from prose.
- **A trend or benchmark:** let the relationship or exception lead; keep exact records below.
- **A calculator:** let the calculator itself be focal evidence when manipulating an assumption is the reader's primary job. Do not require a separate static proof before it.
- **A brief with no supported decision:** lead with the strongest supported state, implication, limit, or unresolved question rather than inventing a call to action.

Choose geometry before components. Map the material to a visual variable:

- Magnitude or rank → position or length on a common scale.
- Change over time → horizontal order and aligned position.
- Composition → proportion.
- Threshold or range → distance from a boundary.
- Process or dependency → connection and sequence.
- Qualitative alternatives → aligned rows or deliberately contrasted columns.

Use tables for precise lookup, prose for one conclusion, and charts only for relationships that become faster to understand visually. Do not default to bars because values exist.

Compose the page as a field, not a stack of components. Establish one page-level throughline and one focal relationship in each reading moment or major section. Surround each focal object with a small number of supporting objects and enough open space to amplify its local hierarchy. Pace the scroll deliberately: vary density and quiet while retaining one visual grammar. Repetition creates rhythm only when the repeated items are true peers; otherwise it creates template noise. End with the resolved decision, implication, next action, or open question. Let sources and the footer follow quietly; do not let the page simply stop after a ledger or caveat.

Give every artifact one evidence-bearing organizing move that belongs to its material and could not be transplanted unchanged into an unrelated report. It may be a comparison geometry, a threshold, a sequence, a customer-specific diagram, a distinctive evidence rhythm, or the interaction itself. It must clarify the subject, not decorate it.

Use a squint test: at a glance, the dominant claim or evidence should be obvious and the reading path should be stable. Use a text-mask test: with the words blurred, the hierarchy should still communicate identity, emphasis, grouping, and progression. If every block has equal weight, redesign before coding.

Create presence through commitment, not additional effects. When a page feels too safe, strengthen one focal relationship through proportion, hierarchy, density, pacing, line breaks, or evidence placement. Make supporting content quieter. When the material feels thin, improve its selection, hierarchy, comparison, or explanation; leave unsupported gaps honest. Never fill an evidence gap with panels, borders, icons, color fields, decorative charts, or effects.

### Authoritative Vercel visual system

Treat this section as the design authority for these artifacts. Use the accompanying CSS for exact tokens, type roles, states, controls, and primitives. Use these instructions for composition, hierarchy, and when those primitives are appropriate. Do not introduce a parallel visual system.

#### Authorship shell

Every completed page has the same Vercel authorship outcome. Existing Vercel projects implement the wordmark header and triangle footer with installed primitives; standalone pages use the exact shell below. Put the Vercel wordmark on the left of the header and the triangle logo on the left of the footer. These stable assets use `currentColor`:

- Wordmark: `https://py8fhxnkzwtsqdo9.public.blob.vercel-storage.com/p/vercel-wordmark.svg`
- Triangle: `https://py8fhxnkzwtsqdo9.public.blob.vercel-storage.com/p/vercel-logo.svg`

The header's right side may contain at most two sourced fields such as the customer, period, purpose, or confidentiality. Use sentence case. Do not invent metadata. Align the wordmark and metadata to the same baseline. Keep the footer quiet: triangle left, at most one sourced ownership or confidentiality line right. Separate both shell regions with spacing, not routine borders.

Keep preparation, audience, and document-state metadata in the masthead. Do not repeat it as a preamble between the masthead and the page-defining title.

When using the standalone CSS, preserve this direct-child order:

```html
<body class="vbg-report">
  <div class="vbg-shell">
    <a class="vbg-skip-link" href="#main">Skip to content</a>
    <header class="vbg-header">
      <div class="vbg-masthead">
        <span class="vbg-identity"><span class="vbg-wordmark" role="img" aria-label="Vercel"></span></span>
        <div class="vbg-document-meta">...</div>
      </div>
    </header>
    <main id="main">...</main>
    <footer class="vbg-footer">
      <span class="vbg-logo" role="img" aria-label="Vercel"></span>
      <span>...</span>
    </footer>
  </div>
</body>
```

The CSS supplies the masks and theme behavior. Do not substitute text, inline art, a decorative triangle, or a different logo treatment.

#### Grid and alignment

Use the shared outer grid for the masthead, title, sections, evidence, and footer. The foundation is 12 columns on desktop, 6 on tablet, and 4 on mobile. Reading prose normally occupies 6–7 desktop columns. Tables, charts, calculators, diagrams, and major comparisons may use all 12.

Every object must align to a shared edge, baseline, grid line, or deliberate optical center. Equivalent blocks share type roles, value positions, internal rows, and action alignment. A split heading and paragraph align on their first text baselines. Tables own the full evidence width of their section. Do not strand content in a narrow track while usable columns remain empty.

Make column gutters unmistakable. Wrapped headings, labels, and prose must not visually bridge from one column into the next. If adjacent columns can be misread as one line or phrase, widen the gutter, shorten or rebalance the content, or stack the columns.

Open space must amplify the focal object. Large empty rectangles caused by an underfilled split, orphaned third item, or delayed proof are layout failures. Reflow or rebalance them. Three true peers normally occupy one three-column row; a deliberately dominant peer may earn more width, but its difference must be meaningful.

Do not force materially unequal findings into equal cells. Rank them, group them, or give the decisive finding more visual consequence so the geometry matches the argument.

#### Typography and rhythm

Use Geist Sans for prose, headings, labels, controls, tables, KPIs, dates, counts, percentages, durations, and financial figures. Use Geist Mono only for code, commands, paths, raw tokens, timestamps, and short operational identifiers such as region, plan, SKU, account, or environment IDs. Set only the identifier in Mono, not its sentence or entire table.

Use the published type roles and weight tokens. Do not create arbitrary font sizes or numeric font weights. Use `display` only for the single page-defining statement when scale is earned; `title` for the normal page title; `heading-24` for major section turns; `heading-20` and `heading-16` for nested structure; lede for one short orientation passage; body for reading; label for compact names; caption and metadata only for subordinate evidence context. Headings use the published Geist heading roles at their defined weight; body copy uses regular; emphasis is scarce. Use tabular numerals for aligned comparisons. Equivalent peers always share role, size, weight, line-height, and numeric treatment; never resize one because its string is longer or its value is larger.

Build vertical rhythm from relationships:

- Heading → its first paragraph: close.
- Paragraph → paragraph or list: one body rhythm.
- Label → value → detail: identical across peers.
- Content group → new section: clearly larger.
- Caption or source → evidence it qualifies: close enough to read together.

Give every gap one owner. A published flow, stack, grid, or page-owned custom wrapper sets the gap; its children must not add competing default margins. In page-owned CSS, reset the margins of grouped direct children and use the published spacing tokens. Within-group gaps are normally `--vbg-space-2` through `--vbg-space-4`, between-group gaps `--vbg-space-6` through `--vbg-space-8`, and major section turns normally `--vbg-space-8` through `--vbg-space-12`. Reserve `--vbg-space-16` for a true chapter break between two substantial sections, never as the default page-stack gap. These express relationships, not one universal stack rule.

Judge the whole transition, not just its token. A large gap next to an underfilled split, short section, or sparse final row compounds emptiness even when the token is valid. Reduce the gap, rebalance the grid, or stack the content until the open space has a clear compositional purpose.

Do not leave a heading, explanation, and list as unrelated siblings inside a custom grid cell. Group the content, align equivalent roles across peers, and let the group own its internal rhythm. Do not repair one awkward transition with an arbitrary one-off margin; repair the grouping or spacing owner.

Keep body text at a comfortable reading size and line height; never use tiny gray copy to make density fit. Keep prose near 60–68 characters per line. Rewrite before shrinking.

Establish hierarchy through typography before surfaces or color. Separate paragraphs with space; never use first-line indents. Inspect important line breaks. Fix stranded words in large headings or ledes by improving the copy or measure, not by shrinking an individual element.

Write sentence-case headings that state the customer-specific claim or reader question. Avoid all-caps eyebrows, overlines, decorative section numbers, synthetic symmetry, repetitive cadence, generic praise, and internal authoring language. Prefer concrete nouns and active verbs. Avoid em dashes. A useful title says what happened, what changes, or what decision is needed; it does not name the report genre.

#### Color, surfaces, and boundaries

Design in monochrome. Use color only when it adds significant meaning to state, action, or data, and pair it with a non-color cue. Do not turn a recommendation, savings figure, cost component, or longer bar green merely because it is favorable or important. Use chart color only when it is needed to distinguish series or encode a sourced state. Light and dark themes are implicit; do not add a visible switcher.

The page is normally one continuous canvas. Earn a surface or boundary only when it communicates selection, interaction, warning, contrast, or a real grouping that spacing cannot express. Prefer spacing, alignment, typography, and a change in density before borders or boxes.

Do not wrap every section, metric, or comparison in a card. Avoid nested panels. Keep radii restrained and consistent with the foundation.

With the standalone foundation, create a strong contrast field only with `.vbg-band[data-tone="contrast"]`; it owns the correct nested text, border, control, and theme colors. Do not recreate a contrast surface in page CSS.

Diagnose quantity separately from intensity. If the page feels busy, remove, combine, or reorder content. If it feels loud, reduce competing color, scale, weight, borders, surfaces, and motion. Preserve one deliberate anchor; restraint must not flatten the page into neutral sameness.

Hard reject decorative gradients, gradient text, glows, blobs, stripes, textures, grid backgrounds, glass effects, paper simulations, colored side rails, ornamental shadows, and fake depth. A gradient is acceptable only when it is a labelled continuous data scale.

#### Data and evidence

Make the visual encoding honest. Show units, periods, populations, bases, and material comparators near the evidence they qualify. Use zero baselines for length encodings unless a clearly marked range or delta view better answers the question. Do not exaggerate small differences with cropped bars or hide them with nearly identical total bars; show the exact delta on the same basis. Never use a bar track as a divider or ornament. Every peer bar shares one documented scale and its length must encode the value; otherwise use aligned text.

Prefer direct labels to legends. Reserve a clear lane for every chart label so no mark, line, bracket, or annotation crosses its glyph box. Keep chart text legible in both themes. Use a caption to state what the reader should notice and what the chart does not establish. Provide a semantic table or concise text alternative for material chart data.

When a chart is the primary proof, give it enough width, height, and contrast to carry the first read. Visual salience must agree with the argument: the decisive series, exception, or threshold receives the strongest emphasis in both themes, while supporting evidence recedes without becoming illegible.

Tables are evidence, not decoration:

- Use a semantic `<table>` with caption, head, body, and optional foot.
- Span the full 12-column evidence width by default. Put the section introduction above it; do not strand a ledger beside a heading, note, or empty rail merely to fill a split grid.
- Match each column header’s alignment to every cell in that column. Left-align text columns and their headers; right-align numerical columns and their headers, including placeholders and totals. In standalone tables, put `class="vbg-numeric"` or `data-align="numeric"` on the numeric `<th>` and every numeric `<td>`; body-cell alignment does not align the header automatically. Never center or left-align a header above right-aligned values.
- Keep peer units and precision consistent; do not add fake precision.
- Bottom-align multi-line column headers and keep row labels readable.
- Use normal density for ordinary short tables; compact density is for genuinely dense lookup.
- Highlight a recommended row only when the source supports the recommendation.
- Reorder columns around the reader's lookup task before shrinking or wrapping them.
- Give dense evidence enough width before choosing a split layout. A table with five or more columns, or any table whose headers wrap at normal desktop width, normally owns the full section width. Never clip, truncate, or shrink a header to preserve a neighboring prose rail; move the introduction above the table or simplify the columns.

```html
<th scope="col">Page</th>
<th scope="col" class="vbg-numeric">Visitors</th>
<!-- ... -->
<th scope="row">Homepage</th>
<td class="vbg-numeric">12,757</td>
```

Use a qualitative comparison for concise differences; use a comparison table when exact row-by-row scanning matters. Peer columns must have matching type roles and aligned row starts. If one peer needs a different structure, it is not a peer grid.

#### Calculators and interaction

Treat interaction as evidence, not decoration. A calculator should make one model legible and let the reader test the assumptions that materially change the result.

Define one canonical state model: variables, fixed inputs, formulas, units, full precision, ranges, increments, defaults, display precision, and dependencies. One control owns each variable. Fixed parameters are not controls. Pre-render the default result. Update dependent outputs atomically from full-precision state, then format for display.

Keep the focal result, controls, and supporting outputs in one coherent tool. When using the calculator is the reader's main job, the working tool is the dominant object in the first viewport; do not delay it below oversized orientation copy or a sparse hero. Do not precede it with a ceremonial static version of the same answer or follow it with a default-scenario recap. Explain formulas, assumptions, bounds, or interpretation only when they help the reader trust or use the model.

Use native controls with visible labels, helpers only when needed, clear units, visible focus, and one concise live status. Preserve invalid entries and the last valid result rather than silently clamping or defaulting. Keep all controls and results usable by keyboard and screen reader.

With the standalone foundation, `.vbg-calculator` directly owns `.vbg-calculator-inputs` and `.vbg-calculator-output`; do not interpose a layout wrapper. A unit control uses this nesting so its label and helper stay outside the bordered field:

```html
<div class="vbg-field">
  <label class="vbg-label" for="rate">Flex commitment rate</label>
  <div class="vbg-unit-field">
    <input id="rate" type="number" value="8">
    <span class="vbg-unit-suffix">%</span>
  </div>
  <p class="vbg-helper">From 4% to 12%.</p>
</div>
```

#### Motion and delight

Default to stillness. Never add auto-scrolling marquees, simulated typing cursors, or decorative pulsing status indicators. Add motion only when it explains a state change, preserves continuity, or confirms an action. Never gate reading behind animation, reveal every section on scroll, move imagery on hover, or add bounce, parallax, cinematic transitions, sound, or spectacle. Keep the base experience complete without motion and respect reduced-motion preferences.

For formal Vercel pages, create delight through unusually clear evidence or unusually low interaction friction: a comparison understood immediately, a calculator that makes a model obvious, or a customer-specific interaction that removes work. Do not manufacture personality with jokes, celebration, Easter eggs, decorative motion, or effects.

#### Media and icons

Use supplied screenshots, diagrams, customer media, or logos only when they are evidence or materially improve understanding. Never add stock imagery, decorative AI illustrations, abstract shapes, fake product screenshots, or mandatory hero media. Do not use icons as decoration or place them in colored tiles. Prefer text labels unless an established icon makes an action materially faster to recognize.

### Inspect and revise privately

Render the actual result when tooling exists. Inspect the first viewport, full page, and both light and dark themes. Also verify responsive reflow before handoff, but do not expose an evaluation matrix or critique report unless the user asks for one.

Review in this order:

1. **First read:** Is Vercel authorship immediate? If the reader saw only the first viewport, would they remember the central relationship, decision, or tool rather than only the title or mood?
2. **Composition:** Is there one dominant object? Does each section advance the argument? Is any empty space accidental?
3. **Typography:** Are roles consistent, peer values equal, baselines aligned, prose readable, gutters unmistakable, and vertical rhythm relational rather than uniform? Does each visible gap have one owner?
4. **Evidence:** Does geometry prove the claim? Are tables full width? Do headers match the alignment of representative cells in every column? Are chart labels clear? Is anything repeated without a new reader task?
5. **Restraint:** Can any surface, border, pill, icon, label, color, paragraph, or section be removed without losing meaning, affordance, or rhythm? If yes, remove it.
6. **Themes and reflow:** Do light and dark have equivalent hierarchy and contrast? Does the page recompose without overflow or character-level wrapping?
7. **Trust and access:** Are semantics, focus, labels, text alternatives, sources, caveats, and interaction behavior sound?

Fix the highest-impact systemic defect, render again, and repeat until no known material visual or usability issue remains. Keep this work internal. Deliver the requested implementation, not a score, process diary, comparison log, or self-critique.

## Reject generated-design reflexes

Do not ship any of these recognizable defaults:

- All-caps or tracked eyebrows, kickers, overlines, and decorative numbered section labels.
- Em dashes.
- Decorative gradients, glows, blobs, stripes, textures, glass, or ornamental shadows.
- Generic centered hero copy followed by a card grid.
- Repeated metric boxes when one composed relationship would be clearer.
- A badge, pill, or rounded capsule for ordinary metadata, chart annotations, or editorial labels.
- Cards nested inside cards, or borders used to repair weak hierarchy.
- A dark rounded rectangle around every chart or calculator.
- Arbitrary icon tiles, oversized icons, or mixed icon styles.
- Tiny muted prose, arbitrary font sizes, inconsistent peer values, or misaligned baselines.
- A narrow table floating inside a wide section, or a wide table compressed into broken words.
- Decorative charts, redundant visualizations, legends that replace direct labels, or color without meaning.
- Repeated full-width bars that do not share a scale or encode a visible difference.
- Identical section silhouettes across unrelated reader questions.
- Repeated recommendation, summary, rationale, and conclusion sections that say the same thing.
- Authoring-process narration such as how the page was organized, why a representation was chosen, or how source fields were renamed. Keep concise interpretive captions that state an evidence-led takeaway or limitation.
- Visible theme controls, print-only UI, stock imagery, fake screenshots, or decorative brand marks.

Do not compensate for avoiding these defaults by producing a sterile anti-design template. Vercel restraint is precise hierarchy, excellent typography, clear evidence, strong alignment, and deliberate tension. It is not merely black, white, thin rules, and large empty margins.

## Use the published CSS API

Put `.vbg-report` on the page root and wrap standalone output in `.vbg-shell`. Use semantic HTML and only the primitives earned by the material.

The generator-facing shell and layout classes are:

`vbg-skip-link`, `vbg-header`, `vbg-masthead`, `vbg-identity`, `vbg-wordmark`, `vbg-document-meta`, `vbg-recipient`, `vbg-state`, `vbg-date`, `vbg-confidentiality`, `vbg-context`, `vbg-opening`, `vbg-opening-claim`, `vbg-opening-proof`, `vbg-opening-context`, `vbg-section`, `vbg-chapter`, `vbg-reading`, `vbg-flow`, `vbg-stack`, `vbg-cluster`, `vbg-grid`, `vbg-split`, `vbg-band`, `vbg-span-4`, `vbg-span-5`, `vbg-span-6`, `vbg-span-7`, `vbg-span-8`, `vbg-span-12`, `vbg-footer`, `vbg-logo`.

The generator-facing type and evidence classes are:

`vbg-title`, `vbg-display`, `vbg-heading-24`, `vbg-heading-20`, `vbg-heading-16`, `vbg-lede`, `vbg-label`, `vbg-meta`, `vbg-caption`, `vbg-mono`, `vbg-numeric`, `vbg-visually-hidden`, `vbg-note`, `vbg-formula`, `vbg-sources`, `vbg-stat-strip`, `vbg-stat`, `vbg-stat-label`, `vbg-stat-value`, `vbg-stat-detail`, `vbg-comparison`, `vbg-table-wrap`, `vbg-chart`, `vbg-chart-header`, `vbg-chart-viewport`, `vbg-legend`, `vbg-bar-comparison`, `vbg-bar-list`, `vbg-bar`, `vbg-bar-label`, `vbg-bar-value`, `vbg-bar-track`, `vbg-bar-fill`.

The generator-facing calculator classes are:

`vbg-calculator`, `vbg-calculator-inputs`, `vbg-calculator-output`, `vbg-control-group`, `vbg-field`, `vbg-unit-field`, `vbg-unit-prefix`, `vbg-unit-suffix`, `vbg-helper`, `vbg-error`, `vbg-range-ends`, `vbg-range-min`, `vbg-range-max`, `vbg-result-group`, `vbg-result`, `vbg-result-label`, `vbg-result-value`, `vbg-result-detail`, `vbg-button`.

Use these primitives according to their semantic names. A `.vbg-stat-strip` owns peer `.vbg-stat` blocks with label, value, and optional detail. A `.vbg-table-wrap` directly owns one semantic table. A `figure.vbg-chart` owns its header, focusable viewport with inline SVG, caption, and optional legend. A `.vbg-calculator` keeps its results, inputs, and output group in one coherent subtree. Do not interpose decorative wrappers or restyle foundation controls.

Use the exact public child names. Do not invent synonyms such as `vbg-stat-note` for `vbg-stat-detail`:

```html
<div class="vbg-stat-strip">
  <div class="vbg-stat">
    <p class="vbg-stat-label">Visitors</p>
    <p class="vbg-stat-value">122,580</p>
    <p class="vbg-stat-detail">June 17 to August 3</p>
  </div>
</div>
```

Treat only the listed names and visualization names below as the public API. If none fits, use semantic HTML plus a page-owned `vbg-custom-*` or `vbg-viz-*` hook; never inspect the CSS for internal selectors, guess a `vbg-*` class, or extrapolate a name from another primitive.

Published visualization classes include `vbg-chart-axis`, `vbg-chart-gridline`, `vbg-series-stroke`, `vbg-series-fill`, `vbg-data-point`, `vbg-chart-direct-label`, `vbg-chart-value`, `vbg-chart-annotation`, `vbg-chart-annotation-line`, and `vbg-series-1` through `vbg-series-6`. Combine the fill or stroke role with a numbered series class; never synthesize names such as `vbg-series-fill-1`. Use `vbg-custom-*` only for local layout geometry and `vbg-viz-*` only for non-text visualization marks. Never apply custom visualization classes to SVG text.

Page-owned CSS may read only these public token families:

- Surfaces and text: `--vbg-surface-primary`, `--vbg-surface-secondary`, `--vbg-surface-contrast`, `--vbg-text-primary`, `--vbg-text-secondary`, `--vbg-text-on-contrast`, `--vbg-text-on-contrast-secondary`.
- Borders and state: `--vbg-border-subtle`, `--vbg-border-default`, `--vbg-border-strong`, `--vbg-border-on-contrast`, `--vbg-focus`, `--vbg-color-info`, `--vbg-color-success`, `--vbg-color-warning`, `--vbg-color-error`.
- Data: `--vbg-chart-1` through `--vbg-chart-6`.
- Rhythm and shape: `--vbg-space-1`, `--vbg-space-2`, `--vbg-space-3`, `--vbg-space-4`, `--vbg-space-5`, `--vbg-space-6`, `--vbg-space-8`, `--vbg-space-10`, `--vbg-space-12`, `--vbg-space-16`, `--vbg-radius-small`, `--vbg-radius`.
- Type size: `--vbg-type-display`, `--vbg-type-page-title`, `--vbg-type-title`, `--vbg-type-section`, `--vbg-type-subsection`, `--vbg-type-lede`, `--vbg-type-body`, `--vbg-type-compact`, `--vbg-type-label`, `--vbg-type-metadata`.
- Type weight and leading: `--vbg-weight-regular`, `--vbg-weight-heading`, `--vbg-weight-medium`, `--vbg-weight-semibold`, `--vbg-leading-body`, `--vbg-leading-compact`, `--vbg-leading-caption`, `--vbg-leading-display`, `--vbg-leading-page-title`, `--vbg-leading-title`, `--vbg-leading-section`, `--vbg-leading-subsection`, `--vbg-leading-lede`.

Use the exact names with `var()`. Never invent, alias, or redeclare a `--vbg-*` token. Prefer `currentColor`, `inherit`, or `transparent` when a custom mark needs no distinct semantic role. Every custom `font-weight` uses a published weight token.

## Accessibility and responsive behavior

Use landmarks, one descriptive `h1`, ordered headings, a skip link, native controls, semantic tables, figures and captions, accessible names, visible focus, and text alternatives. Meet WCAG AA and never rely on color alone. Treat source order as reading order.

Do not conceal page overflow. Give grid and flex children `min-width: 0`; reflow before shrinking. Preserve readable type and control sizes. Short comparisons may stack; long ledgers may scroll locally when reordering and simplification cannot preserve lookup. The page must remain usable in light and dark and across desktop and narrow screens without a visible theme switcher.

The target is Vercel judgment, not Vercel decoration.
