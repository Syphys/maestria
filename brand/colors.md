# Maestria — Color System

Every hex used across the brand system, its role, and its light/dark behaviour.

| Token            | Hex        | Role                                                  | Light mode                          | Dark mode                              |
|------------------|------------|-------------------------------------------------------|-------------------------------------|----------------------------------------|
| `ink`            | `#0E1014`  | Primary mark, wordmark on light, body text            | Used as-is                          | Swap to `cream` for the same role      |
| `graphite`       | `#1A1D24`  | Dark surface (app top bar, macOS squircle tile bg)    | n/a                                 | Used as-is                             |
| `cream`          | `#F4EEE3`  | Wordmark on dark, light surface, welcome bg           | Used as the page/canvas tone        | Used for type and marks on dark        |
| `copper`         | `#C68A3A`  | The baton-bead accent. Single accent — use sparingly. | Used as-is                          | Used as-is (passes contrast on graphite) |
| `copper-soft`    | `#E3B776`  | Hover/active tint of copper, never structural         | Optional                            | Optional                               |
| `mute`           | `#7A7569`  | Secondary type / meta labels on cream                 | Used as-is                          | Use `mute-dark` instead                |
| `mute-dark`      | `#8E8B82`  | Secondary type on dark                                | n/a                                 | Used as-is                             |
| `hairline-light` | `#E6DFD2`  | Dividers / 1px rules on cream                         | Used as-is                          | n/a                                    |
| `hairline-dark`  | `#2A2E37`  | Dividers / 1px rules on graphite                      | n/a                                 | Used as-is                             |

## Mark behaviour

- **Color mark** (`icon.svg`): ink stroke + copper bead. Use on `cream` or any light tone.
- **Mark on dark**: replace ink with `cream`; keep the copper bead unchanged.
- **Monochrome mark** (`icon-mono.svg`): one color + alpha. Renders black for light menubars, white for dark menubars. **Do not bake color into tray templates.**

## macOS Liquid Glass background

The opaque squircle tile (and the recommended `iconmac.png` background) is `#1A1D24` (`graphite`). The foreground glyph (the M + bead) is delivered separately on a transparent canvas at 1024×1024 with the live glyph kept within ~80% of the canvas. The OS adds glass, depth, and shadow — do not paint highlights yourself.

## Contrast notes

- `ink` on `cream` → AAA for all text sizes.
- `cream` on `graphite` → AAA for all text sizes.
- `copper` on `cream` → AA Large only — treat as a decorative accent, never as body type.
- `copper` on `graphite` → AA Large only — same rule.

## Forbidden combinations

- Copper on copper-soft (insufficient contrast).
- Any gradient inside the app-mark, tray template, or favicon.
- Any color other than pure `#000000` or pure `#FFFFFF` inside tray template PNGs.
