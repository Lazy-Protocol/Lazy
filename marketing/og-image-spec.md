# OG Image Design Specification

## Purpose
Social media preview card for link sharing on X, Discord, Telegram, LinkedIn.

## Dimensions
- **Size:** 1200 × 630 px (1.91:1 aspect ratio)
- **Safe zone:** 1100 × 550 px (50px margin all sides)
- **Format:** PNG (no transparency)
- **File size:** Under 300KB (optimize for social platform compression)

## Visual Design

### Background
- Base: Lazy Navy (#1a2332)
- Grid overlay: 24px spacing, rgba(255,255,255,0.05), 1px stroke
- No radial gradient (keep flat for compression resilience)

### Logo
- "Lazy" wordmark, centered top
- Drift White (#FAFBFC)
- Font: Inter Bold, 24px
- Position: 48px from top edge

### Primary Text (Hero)
- **Headline:** "Patient capital, rewarded."
- Font: Inter Bold (700), 64px
- Letter-spacing: -0.03em
- Color: Drift White (#FAFBFC)
- Position: Centered, vertical center minus 24px

### Accent Element
- Yield Gold (#C4A052) underline on "rewarded"
- Width: 80px, Height: 2px
- Position: Centered, 12px below headline baseline

### Secondary Text
- **Tagline:** "No staking. No claiming. Just yield."
- Font: Inter Medium (500), 24px
- Color: rgba(250, 251, 252, 0.7) (Drift White at 70%)
- Position: 16px below accent bar, centered

### URL/Branding
- "getlazy.xyz" centered bottom
- Font: JetBrains Mono, 14px
- Color: Slate (#64748B)
- Position: 48px from bottom edge

## Color Palette (Canonical)
| Name | Hex | Usage |
|------|-----|-------|
| Lazy Navy | #1a2332 | Background |
| Drift White | #FAFBFC | Primary text |
| Yield Gold | #C4A052 | Accent underline |
| Slate | #64748B | URL text |

## Layout
```
+----------------------------------------------------------+
|                                                          |
|                         Lazy                             |
|                                                          |
|                                                          |
|              Patient capital, rewarded.                  |
|                       ________                           |
|                                                          |
|         No staking. No claiming. Just yield.             |
|                                                          |
|                                                          |
|                      getlazy.xyz                         |
+----------------------------------------------------------+
```

## Platform Optimization Notes
- X/Twitter: Crops to ~1.91:1, centered content critical
- Discord: Adds rounded corners, test at 400px wide preview
- Telegram: Full image, test at 320px wide
- LinkedIn: May display at 552×289, ensure 24px+ text remains legible

## Don'ts
- No gradients (compress poorly)
- No text smaller than 14px
- No content in outer 50px
- No Yield Gold for large areas (reserved for data/accents)
- No decorative elements that don't serve function

## File Delivery
- Primary: `frontend/public/og-image.png`
- Retina (optional): `frontend/public/og-image@2x.png` (2400×1260)
