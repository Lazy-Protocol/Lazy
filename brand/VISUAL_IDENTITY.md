# Lazy Protocol: Visual Identity Guide

## Design Philosophy

### The Core Tension
Lazy's visual identity must embody the same tension as its messaging:

> **Simple surface. Serious underneath.**

Users should feel calm and unburdened. Designers and developers should see precision and intentionality. The brand looks effortless because the craft is invisible.

### Design Principles

1. **Calm over exciting:** We're not a memecoin. No visual chaos.
2. **Warm over cold:** Approachable, not sterile corporate.
3. **Precise over decorative:** Every element earns its place.
4. **Confident over loud:** Quiet authority, not desperate attention-seeking.

---

## Color System

### Primary Palette

| Name | Hex | RGB | Usage |
|------|-----|-----|-------|
| **Lazy Navy** | `#1a2332` | 26, 35, 50 | Primary brand color, headers, CTAs |
| **Drift White** | `#FAFBFC` | 250, 251, 252 | Backgrounds, negative space |
| **Yield Gold** | `#C4A052` | 196, 160, 82 | Accents, earnings, positive states |

### Secondary Palette

| Name | Hex | RGB | Usage |
|------|-----|-----|-------|
| **Slate** | `#64748B` | 100, 116, 139 | Secondary text, borders |
| **Cloud** | `#E2E8F0` | 226, 232, 240 | Dividers, subtle backgrounds |
| **Ink** | `#0F172A` | 15, 23, 42 | Body text on light backgrounds |

### Semantic Colors

| Name | Hex | Usage |
|------|-----|-------|
| **Earn Green** | `#22C55E` | Positive yield, success states |
| **Alert Amber** | `#F59E0B` | Warnings, pending states |
| **Risk Red** | `#EF4444` | Errors, losses (use sparingly) |
| **Info Blue** | `#3B82F6` | Informational states, links |

### Color Psychology

**Lazy Navy:** Deep, restful, trustworthy. Evokes nighttime (when you're sleeping and your yield is working). Not the aggressive navy of corporate finance, softer, with warmth.

**Yield Gold:** Earned, not flashy. This isn't crypto-bro gold. It's the warm gold of morning light, of something valuable that accumulated quietly. Use sparingly for maximum impact.

**Drift White:** Not pure white (#FFFFFF). Slightly warm, easier on the eyes. Suggests calm, openness, nothing to hide.

### Color Usage Ratios

```
Backgrounds:     70% Drift White / Cloud
Primary UI:      20% Lazy Navy
Accents:         10% Yield Gold + Semantic colors
```

### Dark Mode Palette

| Light Mode | Dark Mode Equivalent |
|------------|---------------------|
| Drift White `#FAFBFC` | Deep Navy `#0B1120` |
| Lazy Navy `#1a2332` | Soft White `#E2E8F0` |
| Ink `#0F172A` | Cloud `#E2E8F0` |
| Cloud `#E2E8F0` | Charcoal `#1E293B` |
| Yield Gold `#C4A052` | Yield Gold `#C4A052` (unchanged) |

---

## Typography

### Font Stack

**Primary: Inter**
```css
font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
```
- Clean, modern, highly legible
- Excellent for both UI and marketing
- Strong numeric characters (important for financial data)
- Open source, widely available

**Monospace: JetBrains Mono**
```css
font-family: 'JetBrains Mono', 'Fira Code', 'Consolas', monospace;
```
- For addresses, amounts, technical data
- Signals "this is verified data"
- Excellent legibility at small sizes

### Type Scale

| Name | Size | Weight | Line Height | Usage |
|------|------|--------|-------------|-------|
| **Display** | 48px / 3rem | 700 | 1.1 | Hero headlines |
| **H1** | 36px / 2.25rem | 700 | 1.2 | Page titles |
| **H2** | 28px / 1.75rem | 600 | 1.3 | Section headers |
| **H3** | 22px / 1.375rem | 600 | 1.4 | Subsections |
| **H4** | 18px / 1.125rem | 600 | 1.4 | Card titles |
| **Body** | 16px / 1rem | 400 | 1.6 | Paragraphs |
| **Body Small** | 14px / 0.875rem | 400 | 1.5 | Secondary text |
| **Caption** | 12px / 0.75rem | 500 | 1.4 | Labels, metadata |
| **Mono** | 14px / 0.875rem | 400 | 1.4 | Data, addresses |

### Typography Principles

1. **Generous line height:** Body text at 1.6 feels calm and readable
2. **Limited weights:** Only 400 (regular), 500 (medium), 600 (semibold), 700 (bold)
3. **Tabular numerals:** Use `font-variant-numeric: tabular-nums` for financial data
4. **No italics in UI:** Reserve for documentation emphasis only

### Sample Hierarchy

```
Be lazy.                                    [Display, 700]
Deposit your crypto. Earn yield.            [H2, 600]

Lazy is a yield protocol for people         [Body, 400]
who have better things to do.

Current APY: 5.2%                           [Mono, 400]
```

---

## Logo Concepts

### Concept 1: The Hammock Mark

**Description:** Abstract hammock shape formed by a single curved line suspended between two points. Suggests rest, suspension, and the idea of being "held" safely.

```
    ╭─────────────╮
   ╱               ╲
  •                 •
```

**Rationale:**
- Hammock = the ultimate lazy symbol
- Two anchor points = security/stability
- Curved line = ease, comfort, organic
- Minimal and geometric = modern, tech-forward

**Usage:** Works as standalone icon and with wordmark

---

### Concept 2: The Resting L

**Description:** A stylized "L" that appears to be leaning or reclining. The letterform looks relaxed but intentional.

```
  │
  │
  │____
     ↘ (subtle tilt or curve)
```

**Rationale:**
- Direct initial from "Lazy"
- The lean suggests rest without being sloppy
- Simple enough to work at small sizes
- Can incorporate subtle movement

---

### Concept 3: The Yield Curve

**Description:** An upward-curving line that suggests growth while remaining horizontal/calm. Not a steep chart. A gentle, inevitable rise.

```
                    ╱
               ╱───╱
          ╱───╱
     ────╱
```

**Rationale:**
- Represents passive yield accumulation
- Calm, not aggressive (not a rocket)
- Could work as underline element for wordmark
- Suggests "drift upward"

---

### Concept 4: The Closed Eye

**Description:** A simple closed eye shape, suggesting sleep/rest. One curved line for the closed lid, optional lash details.

```
    ╭───────╮
    ╰───────╯
```

**Rationale:**
- "Sleep on it" messaging alignment
- Universal symbol of rest
- Human/warm feeling
- Works well as avatar/favicon

---

### Concept 5: The Stack

**Description:** Stacked horizontal lines of increasing length, suggesting accumulated layers of yield. Minimal, architectural.

```
    ───
   ─────
  ───────
 ─────────
```

**Rationale:**
- Represents accumulation/growth
- Clean, tech-forward aesthetic
- Works at any size
- Could animate (layers appearing)

---

### Wordmark Specifications

**Font:** Inter Bold or custom geometric sans
**Case:** Lowercase "lazy" (approachable, not corporate)
**Tracking:** Slightly loose (+2% to +5%)

```
lazy
```

**With tagline:**
```
lazy
yield on autopilot
```

### Logo Usage Rules

1. **Minimum size:** Icon at 24px, wordmark at 80px wide
2. **Clear space:** Minimum padding equal to the "a" height
3. **Backgrounds:** Navy on light, white/gold on dark, never on busy images
4. **No modifications:** No stretching, rotating, adding effects
5. **Monochrome:** Single color only, no gradients in logo

---

## Iconography

### Style Guidelines

| Property | Specification |
|----------|---------------|
| Stroke weight | 1.5px - 2px |
| Corner radius | 2px (slightly rounded) |
| Style | Outline preferred, filled for emphasis |
| Grid | 24x24px base |
| Optical alignment | Centered visually, not mathematically |

### Icon Principles

1. **Simple geometry:** Circles, lines, basic shapes
2. **Consistent weight:** All icons feel like a family
3. **Purposeful:** Every icon communicates function
4. **No decoration:** No unnecessary flourishes

### Core Icon Set

| Icon | Usage |
|------|-------|
| Wallet | Connect wallet, balances |
| Arrow down | Deposit |
| Arrow up | Withdraw |
| Clock | Pending, cooldown |
| Check | Success, complete |
| Yield/growth | APY, earnings |
| Shield | Security, verified |
| Info circle | Tooltips, help |
| Menu | Navigation |
| Close | Dismiss |

---

## Imagery & Illustration

### Photography Direction

**Do use:**
- Calm natural scenes (still water, horizons, dawn/dusk)
- Architectural precision (clean lines, modern buildings)
- Restful moments (without being cliché "sleeping" stock photos)
- Abstract textures (soft gradients, subtle patterns)

**Don't use:**
- People staring at phones/charts
- Typical "crypto" imagery (coins, chains, rockets)
- Busy, cluttered scenes
- Aggressive or high-energy imagery

### Illustration Style

If using illustrations:
- Geometric and minimal
- Limited color palette (2-3 colors max)
- Flat or subtle gradients (no 3D renders)
- Abstract > literal

### Background Patterns

Subtle, geometric patterns can add depth:
- Soft grid patterns
- Concentric circles (growth rings)
- Wave patterns (calm, flowing)
- Dot grids (precision, technical)

Use at 5-10% opacity only. Never compete with content.

---

## UI Components

### Buttons

**Primary (CTA):**
```css
background: #1a2332;        /* Lazy Navy */
color: #FAFBFC;             /* Drift White */
padding: 12px 24px;
border-radius: 8px;
font-weight: 600;
```

**Secondary:**
```css
background: transparent;
color: #1a2332;
border: 1.5px solid #E2E8F0;
padding: 12px 24px;
border-radius: 8px;
font-weight: 600;
```

**Accent (Earnings/Positive):**
```css
background: #C4A052;        /* Yield Gold */
color: #0F172A;             /* Ink */
padding: 12px 24px;
border-radius: 8px;
font-weight: 600;
```

### Cards

```css
background: #FFFFFF;
border: 1px solid #E2E8F0;
border-radius: 12px;
padding: 24px;
box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
```

### Input Fields

```css
background: #FAFBFC;
border: 1.5px solid #E2E8F0;
border-radius: 8px;
padding: 12px 16px;
font-size: 16px;

/* Focus state */
border-color: #1a2332;
box-shadow: 0 0 0 3px rgba(26, 35, 50, 0.1);
```

### Spacing Scale

Use multiples of 4px:
```
4px   - Tight (icon padding)
8px   - Small (between related elements)
16px  - Medium (standard spacing)
24px  - Large (section padding)
32px  - XL (between sections)
48px  - XXL (major section breaks)
64px  - Hero spacing
```

---

## Motion & Animation

### Principles

1. **Subtle over dramatic:** Animations should feel natural, not performative
2. **Purposeful:** Motion communicates state change, not decoration
3. **Quick:** 150-300ms for most transitions
4. **Eased:** Use ease-out for entering, ease-in for exiting

### Timing

| Type | Duration | Easing |
|------|----------|--------|
| Micro-interactions | 150ms | ease-out |
| State changes | 200ms | ease-out |
| Page transitions | 300ms | ease-in-out |
| Loading states | 400ms+ | linear (loops) |

### Animation Examples

**Button hover:**
```css
transition: background-color 150ms ease-out, transform 150ms ease-out;

&:hover {
  transform: translateY(-1px);
}
```

**Card appearance:**
```css
animation: fadeUp 300ms ease-out;

@keyframes fadeUp {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
```

**Loading spinner:**
- Gentle rotation (not aggressive spinning)
- Consider pulsing dots or calm wave animation
- Avoid spinners that feel "urgent"

---

## Responsive Behavior

### Breakpoints

```css
/* Mobile first */
--mobile: 0px;
--tablet: 768px;
--desktop: 1024px;
--wide: 1280px;
```

### Scaling Principles

1. **Type scales down:** Reduce display/headline sizes on mobile
2. **Spacing compresses:** Use 60-70% of desktop spacing on mobile
3. **Stack, don't shrink:** Multi-column layouts become single column
4. **Touch targets:** Minimum 44x44px on mobile

---

## Brand Applications

### Social Media Avatars
- Use icon-only logo mark
- Navy icon on white background, or
- White icon on navy background
- No wordmark at avatar sizes

### Email Templates
- White background
- Navy headers
- Limited color palette (navy, gold accents only)
- Maximum width: 600px

### Presentation Decks
- White or light gray backgrounds
- Navy for headers and emphasis
- Gold for key metrics/highlights
- One idea per slide
- Generous white space

### Documentation
- Clean, readable layout
- Code blocks in subtle gray backgrounds
- Use monospace for technical terms
- Clear hierarchy with navy headers

---

## What to Avoid

### Visual Don'ts

1. **No neon colors:** We're not a nightclub
2. **No gradients in core brand:** Save for subtle backgrounds only
3. **No 3D renders:** Dated, crypto-cliché
4. **No busy patterns:** Calm > chaos
5. **No stock photos of people looking at charts:** Overdone
6. **No aggressive animations:** Bouncing, shaking, flashing
7. **No drop shadows on everything:** Use sparingly
8. **No rounded everything:** Mix radiuses intentionally

### Brand Dilution

- Don't use off-brand colors "just this once"
- Don't stretch or distort the logo
- Don't use low-contrast text
- Don't abandon the grid/spacing system
- Don't mix too many type sizes in one view

---

## Asset Checklist

### Required Assets

- [ ] Logo (icon, wordmark, combination mark)
- [ ] Logo files (SVG, PNG at 1x, 2x, 3x)
- [ ] Favicon (16x16, 32x32, apple-touch-icon)
- [ ] OG image template (1200x630)
- [ ] Twitter card template (1200x600)
- [ ] Color palette file (Figma, Sketch, CSS variables)
- [ ] Icon set (SVG)
- [ ] Font files (or CDN links)

### Nice to Have

- [ ] Illustration library
- [ ] Animation library (Lottie files)
- [ ] Presentation template
- [ ] Email template
- [ ] Brand guidelines PDF

---

*This is a living document. Update as the brand evolves.*
