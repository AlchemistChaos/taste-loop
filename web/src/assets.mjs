// assets.mjs — on-brand TikTok visual assets for TasteLoop generated sites.
// FROZEN SIGNATURE:
//   export const TIKTOK_LOGO_SVG (string)
//   export function heroSVG(brand) -> inline SVG string (flat, brand colors, NO gradients)
//   export function baseTemplate({ brand, title, sectionsHtml }) -> full self-contained HTML string

// ---------------------------------------------------------------------------
// TikTok wordmark: the musical-note glyph with the signature cyan/red offset,
// plus the "TikTok" wordmark. Self-contained, flat fills only.
// ---------------------------------------------------------------------------
export const TIKTOK_LOGO_SVG = `<svg viewBox="0 0 180 48" width="160" height="42" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="TikTok">
  <g>
    <!-- note glyph: cyan offset layer -->
    <path d="M30.5 6.2c1.3 4.4 4.6 7.9 9 9.1v6.6c-2.7-.1-5.3-.9-7.6-2.3v10.6c0 7.2-5.8 13-13 13-2.7 0-5.2-.8-7.3-2.2 2.4 2.6 5.9 4.2 9.7 4.2 7.2 0 13-5.8 13-13V21.4c2.3 1.4 4.9 2.2 7.6 2.3v-6.6c-4.4-1.2-7.7-4.7-9-9.1h-2.4z" fill="#25F4EE"/>
    <!-- note glyph: red offset layer -->
    <path d="M27.5 6.2c1.3 4.4 4.6 7.9 9 9.1v6.6c-2.7-.1-5.3-.9-7.6-2.3v10.6c0 7.2-5.8 13-13 13S2.9 37.4 2.9 30.2 8.7 17.2 15.9 17.2c.6 0 1.2 0 1.8.1v6.8c-.6-.2-1.2-.3-1.8-.3-3.4 0-6.2 2.8-6.2 6.2s2.8 6.2 6.2 6.2 6.2-2.8 6.2-6.2V6.2h5.4z" fill="#FE2C55"/>
    <!-- note glyph: white top layer -->
    <path d="M29 6.2c1.3 4.4 4.6 7.9 9 9.1v6.6c-2.7-.1-5.3-.9-7.6-2.3v10.6c0 7.2-5.8 13-13 13S4.4 37.4 4.4 30.2 10.2 17.2 17.4 17.2c.6 0 1.2 0 1.8.1v6.8c-.6-.2-1.2-.3-1.8-.3-3.4 0-6.2 2.8-6.2 6.2s2.8 6.2 6.2 6.2 6.2-2.8 6.2-6.2V6.2H29z" fill="#FFFFFF"/>
  </g>
  <!-- wordmark -->
  <g fill="#FFFFFF">
    <text x="54" y="33" font-family="Inter, system-ui, sans-serif" font-size="26" font-weight="800" letter-spacing="-1">TikTok</text>
  </g>
</svg>`;

// ---------------------------------------------------------------------------
// heroSVG(brand): a flat, bold hero illustration in brand colors.
// Phone frame + play button + flat color blocks + sound-wave bars.
// NO gradients — only solid fills derived from the brand palette.
// ---------------------------------------------------------------------------
export function heroSVG(brand) {
  const c = (brand && brand.colors) || {};
  const primary = c.primary || "#FE2C55";
  const accent = c.accent || "#25F4EE";
  const fg = c.fg || "#FFFFFF";

  return `<svg viewBox="0 0 520 460" width="100%" height="100%" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Brand hero graphic" preserveAspectRatio="xMidYMid meet">
  <!-- flat backdrop blocks -->
  <rect x="22" y="60" width="150" height="150" rx="20" fill="${accent}" opacity="0.16"/>
  <rect x="360" y="250" width="140" height="140" rx="20" fill="${primary}" opacity="0.18"/>
  <circle cx="430" cy="80" r="40" fill="${accent}" opacity="0.22"/>

  <!-- phone body -->
  <rect x="170" y="40" width="200" height="380" rx="34" fill="#101013" stroke="${fg}" stroke-opacity="0.12" stroke-width="2"/>
  <rect x="184" y="56" width="172" height="348" rx="22" fill="#000000"/>

  <!-- screen content: stacked color cards (flat) -->
  <rect x="198" y="78" width="144" height="92" rx="14" fill="${primary}"/>
  <rect x="198" y="182" width="144" height="70" rx="14" fill="${accent}"/>
  <rect x="198" y="264" width="144" height="44" rx="12" fill="${fg}" opacity="0.10"/>
  <rect x="198" y="318" width="92" height="14" rx="7" fill="${fg}" opacity="0.22"/>
  <rect x="198" y="342" width="120" height="14" rx="7" fill="${fg}" opacity="0.14"/>

  <!-- center play button -->
  <circle cx="270" cy="124" r="30" fill="#000000" opacity="0.28"/>
  <circle cx="270" cy="124" r="30" fill="${fg}" opacity="0.92"/>
  <path d="M261 110 L286 124 L261 138 Z" fill="${primary}"/>

  <!-- notch -->
  <rect x="246" y="46" width="48" height="9" rx="4.5" fill="${fg}" opacity="0.25"/>

  <!-- sound-wave bars beside the phone (flat accent) -->
  <g fill="${accent}">
    <rect x="396" y="150" width="12" height="40" rx="6"/>
    <rect x="416" y="130" width="12" height="80" rx="6"/>
    <rect x="436" y="110" width="12" height="120" rx="6"/>
    <rect x="456" y="146" width="12" height="48" rx="6"/>
  </g>
  <g fill="${primary}">
    <rect x="70" y="250" width="12" height="64" rx="6"/>
    <rect x="90" y="230" width="12" height="104" rx="6"/>
    <rect x="110" y="266" width="12" height="32" rx="6"/>
  </g>
</svg>`;
}

// ---------------------------------------------------------------------------
// baseTemplate: full self-contained HTML doc. Tailwind CDN + Inter font,
// dark bg, logo, hero, and a slot for sectionsHtml.
// ---------------------------------------------------------------------------
export function baseTemplate({ brand, title, sectionsHtml }) {
  const b = brand || {};
  const c = b.colors || {};
  const primary = c.primary || "#FE2C55";
  const accent = c.accent || "#25F4EE";
  const bg = c.bg || "#000000";
  const fg = c.fg || "#FFFFFF";
  const headingFont = (b.fonts && b.fonts.heading) || "Inter";
  const bodyFont = (b.fonts && b.fonts.body) || "Inter";
  const safeTitle = title || "TikTok for Business";
  const inner = sectionsHtml || "";

  return `<!doctype html>
<html lang="en" class="scroll-smooth">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${safeTitle}</title>
<script src="https://cdn.tailwindcss.com"></script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
<script>
  tailwind.config = {
    theme: {
      extend: {
        colors: {
          brand: "${primary}",
          accent: "${accent}",
          ink: "${bg}",
          paper: "${fg}"
        },
        fontFamily: {
          heading: ["${headingFont}", "Inter", "system-ui", "sans-serif"],
          body: ["${bodyFont}", "Inter", "system-ui", "sans-serif"]
        }
      }
    }
  };
</script>
<style>
  :root { color-scheme: dark; }
  html, body { background: ${bg}; }
  body { font-family: "${bodyFont}", "Inter", system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
  h1,h2,h3,h4 { font-family: "${headingFont}", "Inter", system-ui, sans-serif; letter-spacing: -0.02em; }
  .tl-pill { display:inline-flex; align-items:center; gap:.5rem; }
</style>
</head>
<body class="bg-ink text-paper font-body antialiased">

  <!-- NAV -->
  <header class="sticky top-0 z-50 backdrop-blur border-b border-white/10 bg-black/70">
    <div class="mx-auto max-w-6xl px-6 h-16 flex items-center justify-between">
      <div class="flex items-center gap-2">${TIKTOK_LOGO_SVG}</div>
      <nav class="hidden md:flex items-center gap-8 text-sm font-semibold text-white/70">
        <a href="#how" class="hover:text-white transition">How it works</a>
        <a href="#proof" class="hover:text-white transition">Proof</a>
        <a href="#cta" class="hover:text-white transition">Pricing</a>
      </nav>
      <a href="#cta" class="rounded-full px-5 py-2 text-sm font-bold text-black"
         style="background:${primary}">Get started</a>
    </div>
  </header>

  <!-- HERO -->
  <section class="relative overflow-hidden">
    <div class="absolute inset-0 -z-10" style="background:${bg}"></div>
    <div class="mx-auto max-w-6xl px-6 pt-16 pb-20 grid md:grid-cols-2 gap-10 items-center">
      <div>
        <span class="tl-pill rounded-full px-3 py-1 text-xs font-bold uppercase tracking-widest"
              style="background:${accent}1A;color:${accent}">For creators &amp; businesses</span>
        <h1 class="mt-6 text-5xl md:text-6xl font-black leading-[1.02]">
          ${safeTitle}
        </h1>
        <p class="mt-5 text-lg text-white/70 max-w-md font-medium">
          Reach a billion people, spark real demand, and turn attention into action — with the platform built for the sound-on generation.
        </p>
        <div class="mt-8 flex flex-wrap gap-4">
          <a href="#cta" class="rounded-full px-7 py-3 text-base font-bold text-black shadow-lg"
             style="background:${primary}">Start for free</a>
          <a href="#how" class="rounded-full px-7 py-3 text-base font-bold border-2 text-white"
             style="border-color:${accent};color:${accent}">See how it works</a>
        </div>
        <div class="mt-10 flex items-center gap-8 text-sm font-semibold text-white/60">
          <div><span class="block text-2xl font-black text-white">1B+</span>monthly users</div>
          <div><span class="block text-2xl font-black text-white">7M+</span>businesses</div>
          <div><span class="block text-2xl font-black text-white">2.5x</span>avg. ROAS lift</div>
        </div>
      </div>
      <div class="relative h-[460px]">
        ${heroSVG(b)}
      </div>
    </div>
  </section>

  ${inner}

  <!-- FOOTER -->
  <footer class="border-t border-white/10 mt-10">
    <div class="mx-auto max-w-6xl px-6 py-10 flex flex-col md:flex-row items-center justify-between gap-6">
      <div class="flex items-center gap-2 opacity-90">${TIKTOK_LOGO_SVG}</div>
      <p class="text-sm text-white/50 font-medium">&copy; ${new Date().getFullYear()} TikTok for Business. Demo site generated by TasteLoop.</p>
      <div class="flex gap-5 text-sm font-semibold text-white/60">
        <a href="#" class="hover:text-white">Privacy</a>
        <a href="#" class="hover:text-white">Terms</a>
        <a href="#" class="hover:text-white">Contact</a>
      </div>
    </div>
  </footer>

</body>
</html>`;
}
