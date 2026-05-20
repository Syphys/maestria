# Maestria — Visual Branding Brief

> **Hand this whole file to a design-capable Claude.** It is self-contained: the
> designer does **not** have access to the source repository. Everything needed
> (asset list, exact pixel sizes, formats, placement, platform rules) is here.

---

## 0. How to use this brief (meta-guidance for the design AI)

You are designing the **complete icon + logo system for a desktop application**.
Please follow these principles — they are the difference between a usable app
icon set and an unusable one:

1. **Deliver ONE master vector first.** Design a single, clean **SVG app-mark**
   (the symbol) and a separate **SVG wordmark** (the name set in type). Every
   raster size below is derived from these. Do not design each size separately.
2. **Design for the smallest size first (16×16).** If the mark is not
   instantly readable as a 16 px favicon / menubar glyph, it fails. Test the
   silhouette at 16 px before refining.
3. **NO TEXT INSIDE THE APP ICON.** The previous icons had `v6.11.4 LITE`
   baked into the artwork — this is exactly what to avoid. The app-mark is a
   pure symbol. Versioning/edition text is never part of an icon.
4. **Respect platform icon shapes** (detailed in §5). macOS, Windows, Linux,
   menubar, and web each have different framing rules. A square full-bleed PNG
   shoved into all of them looks broken.
5. **Two tonal variants required:** a full-color version, and a **pure
   monochrome silhouette** (single color + alpha only) for the menubar/tray
   "template" images that the OS recolors automatically for light/dark.
6. **Provide exact hex values** and a light-mode + dark-mode behaviour note for
   every color used.
7. **Originality / legal:** this is a rebrand away from "TagSpaces". The new
   identity must share **no visual DNA** with TagSpaces (no reused glyph,
   color, or layout). Fully original artwork only.
8. **Deliverables format:** master `.svg` files (optimized, no embedded
   rasters), plus exported PNGs at the exact sizes in §4, plus a short
   `colors.md` (hex, usage, light/dark). The application packager will
   assemble `.ico` / `.icns` / `.icon` from your PNG/SVG exports — you do not
   need to produce platform container files yourself, **but** you must provide
   every source PNG size listed.

---

## 1. Product & brand context

- **Product name:** Maestria
- **What it is:** a desktop application for **browsing, organizing, tagging,
  and launching local AI models** (a "models hub" / library + orchestrator for
  local LLMs on the user's machine). It parses model files, enriches metadata,
  and launches model servers that external tools connect to.
- **Platform:** cross-platform desktop (Windows, macOS, Linux), built on
  Electron. There is also a web build and (legacy) mobile builds.
- **Audience:** technical users / AI practitioners / self-hosters. Local-first,
  privacy-respecting, no telemetry. Confident and precise, not playful.
- **Name meaning:** *Maestria* = "mastery / virtuosity" (Spanish/Italian/
  Portuguese). Connotations to draw from (designer's choice, do not feel
  obligated to be literal): a **maestro / conductor** orchestrating many
  instruments (= orchestrating many AI models), a **baton**, mastery,
  precision, an elegant "M", a tuning fork, a node/graph of coordinated
  elements, a guiding hand. Avoid clichés: no robot heads, no generic "brain",
  no generic gear, no chat bubble.
- **Personality keywords:** precise, mastered, orchestrated, calm-powerful,
  modern, local/independent, premium-but-not-corporate.
- **Tone:** geometric, confident, minimal. Should look good on a dark IDE-style
  UI and on a light OS dock equally.

> Color palette is **open to the designer.** If you want a steer: a single
> strong accent + neutral, working on both light and dark. Provide final hex.

---

## 2. Concept direction (suggested, not prescriptive)

Pick ONE coherent concept and apply it across the whole system so the app-mark,
wordmark, and menubar glyph clearly belong together. Examples that fit the
"orchestration of models / mastery" idea:

- An abstract **conductor's baton / motion arc** forming an "M".
- A **central node coordinating satellite nodes** (orchestration), reducible to
  a clean silhouette at 16 px.
- A confident geometric **monogram "M"** with a subtle "in-motion / directing"
  cue.

Constraint: whatever you choose **must survive reduction to a flat one-color
16 px silhouette** (that is the menubar/tray test).

---

## 3. Master deliverables (make these first)

| # | Deliverable | Format | Notes |
|---|---|---|---|
| M1 | **App-mark** (the symbol, no text) | SVG, square artboard 1024×1024, centered, transparent | The source of every app/launcher/favicon icon. |
| M2 | **App-mark — monochrome** | SVG, single color `#000000` on transparent | Source for menubar/tray "template" images. Must be recognizable as pure silhouette. |
| M3 | **Wordmark** "Maestria" | SVG, transparent, tight bounding box | Logotype used inside the app UI header & About box. Horizontal lockup. |
| M4 | **Wordmark — light-on-dark variant** | SVG | Same wordmark recolored for dark backgrounds (the in-app top bar is dark). |
| M5 | `colors.md` | text | Every hex used, where, and light vs dark behaviour. |

Optional but appreciated: a horizontal **mark + wordmark lockup** SVG.

---

## 4. Full raster export matrix (exact sizes — produce ALL of these)

All PNGs: 8-bit RGBA, transparent background unless stated, sRGB, no metadata.
Filenames are the exact names the application expects — keep them.

### 4.1 Application icon — generic square master set

Used for Linux launcher, web/PWA, favicon, in-app logo, and as the source the
packager turns into Windows `.ico` and macOS `.icns`.

| File | Size (px) | Bg |
|---|---|---|
| `icon.svg` | vector | transparent |
| `icon.png` | 1024×1024 | transparent |
| `512x512.png` | 512 | transparent |
| `256x256.png` | 256 | transparent |
| `128x128.png` | 128 | transparent |
| `96x96.png` | 96 | transparent |
| `64x64.png` | 64 | transparent |
| `48x48.png` | 48 | transparent |
| `32x32.png` | 32 | transparent |
| `24x24.png` | 24 | transparent |
| `16x16.png` | 16 | transparent |

> The 16 and 24 px versions almost always need a **simplified** drawing
> (fewer details, thicker strokes) — please hand-tune them, do not just
> downscale 1024.

### 4.2 macOS app icon (squircle + "Liquid Glass")

macOS does **not** want a full-bleed square. Provide:

| Deliverable | Spec |
|---|---|
| `iconmac.png` | 1024×1024, the app-mark **already composed inside the macOS rounded-rectangle ("squircle") with correct padding** and a subtle solid background fill (icon must not be transparent here — macOS icons sit on an opaque rounded tile). ~824×824 live area centered in 1024. |
| macOS 26 "Liquid Glass" foreground | A **transparent-background** 1024×1024 PNG of just the **foreground glyph layer** (no background tile, no shadow — the OS adds glass, depth, shadow). Plus a recommended background fill color (hex). This becomes the layered `.icon`. Keep the glyph within ~80% of the canvas, no hard square edges. |
| Light & dark | If the glyph needs different treatment on the system's light vs dark icon background, provide both; otherwise state "single glyph works on both". |

### 4.3 Windows app icon

Provide the square set in §4.1 (16→256 minimum, plus 512/1024). The packager
builds the multi-resolution `.ico`. Windows icons may be full-bleed; if your
mark needs a background to read on the taskbar, include an opaque-background
1024 variant named `icon-win.png` and say so.

### 4.4 Menubar / system-tray icons — **monochrome "template" images**

These render in the macOS menubar and Windows/Linux tray. They are tiny and
must be **pure single-color silhouette + alpha** (macOS auto-inverts them for
light/dark menubars — do NOT bake in color or it breaks). Derive from M2.

| File | Size (px) | Notes |
|---|---|---|
| `trayIconTemplate.png` | 16×16 | macOS template, black shape on transparent |
| `trayIconTemplate@2x.png` | 32×32 | macOS template @2x |
| `trayIcon.png` | 16×16 | Win/Linux tray (may be the color mark, simplified) |
| `trayIcon@2x.png` | 32×32 | " |
| `trayIcon@3x.png` | 48×48 | " |
| `trayIcon.ico` | 16+32 multi | Windows tray container (or provide the PNGs and packager builds it) |
| Tray monochrome — light menubar | 16×16 & 44×44, **solid black** shape + alpha | |
| Tray monochrome — dark menubar | 16×16 & 44×44, **solid white** shape + alpha | |

> There are also small embedded tray bitmaps (~16, ~20, ~42 px, black & white
> variants) compiled into the app. Provide the four sizes **16, 20, 32, 42 px**
> in BOTH solid-black-on-transparent and solid-white-on-transparent. The
> developer will re-embed them.

### 4.5 In-app logo & onboarding

| File | Size (px) | Bg | Where it appears |
|---|---|---|---|
| `text-logo.svg` | vector (approx aspect 110×21, i.e. wide wordmark) | transparent | App top bar / About dialog — the "Maestria" logotype (M3). |
| `text-logo-dev.svg` | vector | transparent | Same wordmark, a dev-build tint/variant (e.g. subdued or with a small "dev" affordance — your call, keep it subtle, still NO version number). |
| `text-logo-web.svg` | vector | transparent | Same wordmark, web-build variant. |
| `custom-logo.svg` | vector | transparent | Generic in-app logo slot (can equal the lockup M1+M3). |
| `welcome-logo.png` | 300×200 | transparent | Onboarding / welcome splash. Mark + wordmark, centered, generous padding. |
| `welcome-logo2x.png` | 600×400 | transparent | @2x of the above. |

### 4.6 Web / PWA & favicon

| Deliverable | Spec |
|---|---|
| `favicon` source | 16, 32, 48 px from §4.1 (packager builds `.ico`). |
| PWA icons | 192×192 and 512×512, plus a 512×512 **maskable** variant (mark inside the safe zone — ~80% — with an opaque background so Android can mask it to any shape). |
| `apple-touch-icon.png` | 180×180, opaque background, no transparency, square (iOS rounds it). |

### 4.7 (Optional / lower priority) Mobile launcher

Only if mobile builds are kept. Android adaptive icon: provide a 432×432
**foreground** (transparent, glyph within central 66%) + a solid background
color hex. iOS: 1024×1024 opaque square. If unsure, **skip** — desktop is the
priority.

---

## 5. Platform framing rules (apply per target)

- **macOS (classic .icns + new .icon):** rounded-rectangle "squircle" tile,
  never a bare square; ~10% padding; for the Liquid Glass `.icon`, deliver the
  glyph as its own transparent layer and let the OS add glass/shadow/depth —
  do not paint highlights or shadows yourself.
- **Windows (.ico):** can be full-bleed; ensure contrast on both light and
  dark taskbars; hand-tune 16/24/32.
- **Linux:** transparent square PNG set, full-bleed acceptable.
- **Menubar/tray:** single-color silhouette + alpha only ("template" image).
  Must read at 16 px on both a white and a black bar. No gradients, no color.
- **Web/PWA:** provide a **maskable** variant (safe zone) in addition to the
  standard transparent one.
- **In-app wordmark:** the app's top bar is **dark**; ensure the wordmark has a
  light-on-dark variant (M4) with sufficient contrast.

---

## 6. Acceptance checklist (designer self-check before delivery)

- [ ] App-mark readable as a flat silhouette at 16 px.
- [ ] **Zero text inside any app/launcher/tray icon.**
- [ ] No visual element traceable to "TagSpaces" (original work only).
- [ ] macOS `iconmac.png` is an opaque squircle with correct padding (not a
      transparent full-bleed square).
- [ ] Liquid-Glass foreground delivered as transparent glyph-only layer +
      background hex.
- [ ] Tray/menubar set delivered as pure black-on-alpha AND white-on-alpha at
      16/20/32/42/44 px.
- [ ] Every filename in §4 present at the exact pixel size and color space.
- [ ] `colors.md` lists every hex with light/dark behaviour.
- [ ] Master `icon.svg`, wordmark SVG(s), and monochrome SVG included and
      optimized (no embedded rasters).
- [ ] Mark + wordmark visibly belong to the same family.

---

## 7. What the developer will do with the output

Returned assets are dropped back into the project; the build pipeline assembles
the Windows `.ico`, macOS `.icns` + `.icon`, and re-embeds the tray bitmaps.
So: **correct filenames + exact sizes + the source SVGs** matter more than
producing platform container files. When in doubt, deliver the SVG plus all
PNG sizes and leave containerization to the build.
