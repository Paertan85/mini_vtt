# Why Mini VTT stays on Electron

_Written 2026-11-17 from a Tauri spike._

**Decision: Mini VTT stays on Electron.** `ROADMAP.md` planned a move to Tauri 2 "once the app is more feature complete", expecting a much smaller download and some memory saved. A spike tested that on the hardware Mini VTT is meant for, low-end Windows laptops. On such a laptop Tauri saves about 20 MB of memory and 113 MB of download. The cost is a rewrite of the main process in Rust and of the test suites. That is not worth it.

The spike is kept as its own repo (`mini_vtt_spike`). It ran Mini VTT's renderer unchanged inside Tauri windows, with a Rust main process covering the library, the media protocol, the player window and every relay. Its `FINDINGS.md` and `OPTIMIZE.md` hold every number below with the way it was taken.

## What was compared

- **The apps:** Mini VTT 1.5.0 as packaged (Electron 45), against the spike's release build (Tauri 2.12, WebView2 157).
- **The steps:** the same library, steps and clicks in both apps, driven by script.
  1. App open, no map.
  2. A 5550 × 3150 VP9 video map on both screens for a minute.
  3. A 318-megapixel JPEG (79 MB) on both screens, then panning the player's view and twelve fog strokes.
  4. Back to no map.
- **What was counted:** memory is the private bytes of the whole process tree, so WebView2's helper processes count for Tauri. CPU is the CPU time of the tree.
- **The machines:**
  - **The target:** a ThinkPad, Intel Core i5-10210U, 16 GB, Intel UHD integrated graphics, with the player screen on a 4K display.
  - A desktop with an RTX 3080 gave the same picture.
  - The Steam Deck was tested only in part, and is low priority.

## The results on the target laptop

|                                                       | Tauri spike       | Electron 1.5.0     |
| ----------------------------------------------------- | ----------------- | ------------------ |
| Windows installer                                     | **2.6 MB**        | 115.5 MB           |
| Memory, open with no map                              | **134 to 138 MB** | 155 to 158 MB      |
| Memory, video on both screens                         | 857 to 870 MB     | 901 to 958 MB      |
| CPU, a minute of that video                           | 20 to 22 s        | 20 s               |
| Memory after panning and fog on the large map         | 828 to 834 MB     | 843 to 858 MB      |
| CPU while panning and painting                        | 10.2 to 11.7 s    | 10.2 to 10.4 s     |
| Highest memory while the large map loads              | **2.1 to 2.2 GB** | 4.0 to 4.1 GB      |
| CPU to open the player window ten times               | 31.3 s            | **18.7 s**         |
| From click until the video shows on the player screen | 0.8 to 0.9 s      | **0.3 to 0.6 s**   |
| From start until the library is listed                | 0.83 to 0.90 s    | **0.57 to 0.65 s** |

**Memory and CPU in use are the same.** WebView2, Windows' web view, is Chromium, the same engine Electron bundles. The maps and video live in the web engine and the GPU, not in the main process. Tauri's main process is about 70 MB smaller than Electron's, and WebView2's extra helper processes take back most of that.

**The download is the one clear gain,** and only on Windows. On Linux the Tauri AppImage was the larger one (150 MB against 126 MB), because it has to carry its own web engine and media framework.

**The large-image peak is not really Tauri's.** While the 318-megapixel map loads, the spike peaks about 1.9 GB lower. A follow-up found why: it depends on how the web view receives the image, not on Tauri.

| How the image reaches the web view                                                                             | Peak          |
| -------------------------------------------------------------------------------------------------------------- | ------------- |
| Whole and at once, through a request handler (Tauri's custom protocol, or a handler of the spike's own)        | 2.1 GB        |
| Streamed from disk (WebView2 serving the folder itself, a local HTTP server, or Electron's `createReadStream`) | 3.2 to 4.1 GB |

The difference is about one full-size decode of the image (18,900 × 16,800 × 4 bytes). The fast path also costs the Tauri app's own process up to 989 MB for under a second. Whether Electron gets the lower peak by answering an image whole (see "A lead for Electron"): **untested**.

**Tauri is a little slower where it differs:** start-up, and opening the player screen.

**Nothing Tauri-only helped.** Three WebView2 settings that Electron lacks were tried:

- **Letting WebView2 serve the map files itself:** brought Electron's peak back.
- **A request handler of the spike's own, reading straight from the file:** saved 230 MB of that 989 MB transient, not all of it.
- **WebView2's "low memory" target:** saved about 460 MB after panning, at 2.5 times the CPU while panning.

## What a move would cost

- **The main process rewritten in Rust:** 2,837 lines of TypeScript today. The spike's partial port was already 2,392 lines of Rust plus a 523-line bridge. The project would have two languages from then on.
- **Two copies of the rules:** the checks the main process borrows from `src/lib/` (settings, grid, areas, rooms, markers, kill phrases) would exist twice, in TypeScript and in Rust.
- **The tests rewritten:** `scripts/test-app.mjs` and `scripts/test-library.mjs` (about 4,600 lines) run inside Electron. They would become Rust tests and WebDriver tests.
- **Seven changes in `src/`,** among them media URLs that differ per platform, file drop and drag-to-reorder that clash on Windows, and dropped files that arrive without a path.
- **Behaviour Electron gives for free, rebuilt by hand:** on Windows the web view's find bar, print dialog, reload keys and right-click menu all had to be switched off, and F11 and the Alt key handled in the page.
- **No fixed engine.** Electron ships the Chromium it was tested with. Tauri runs on whatever WebView2 the machine has, which updates itself, and on a different engine on Linux and macOS.
- **Linux and the Deck:**
  - WebKitGTK would not play video from Tauri's own media protocol; it played only from a local HTTP server.
  - It has no canvas blur, which the effect layer uses.
  - Encoding a fog snapshot took 130 to 155 ms on the Deck, against 6 to 9 ms on the Windows desktop.
  - Electron on the Deck was not measured for comparison.

## Not tested

- **macOS.**
- **A laptop with 8 GB.** The target laptop had 16 GB and never paged.
- **Battery power.**
- **Smoothness by eye.** The laptop runs were unattended. The one watched run where pan and zoom lagged badly was made under bad conditions and never repeated.
- **Whether Electron gets the lower large-image peak** (see the next section).

## A lead for Electron

**Large images, answered whole.** `map-media` in `electron/main.ts` streams every file with `createReadStream`. Answering an image (not a video) with the whole file, `new Response(await fs.readFile(mediaPath), …)`, might give Electron the spike's 1.9 GB lower peak on a 318-megapixel map. That matters most on an 8 GB laptop. **Untested.** It needs one measured run of a patched build, and a check that removing a map while it loads still works on Windows (the reason the code streams today). It is listed under **Ideas** in `ROADMAP.md`.

## When to look again

- **The download size starts to matter,** for example a store with a size limit.
- **Electron stops meeting a need,** for example a security or platform requirement.
- **WebView2 gains something Electron can't match,** such as sharing its engine processes between apps.
- **That lead fails, and very large maps on 8 GB laptops turn out to matter.** Then the large-image peak is the one real argument for Tauri, and the spike repo is the place to start.
