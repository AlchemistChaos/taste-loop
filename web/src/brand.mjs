// brand.mjs — fixed TikTok BrandSpec, returned instantly (no network).
// Frozen signature:
//   export async function deconstructBrand() -> BrandSpec
//
// The BrandSpec is exactly as defined in the project data contract.

/**
 * Returns a fixed TikTok BrandSpec. Async to match the contract, but resolves
 * immediately — no network, no model call.
 * @returns {Promise<{
 *   colors:{primary:string,accent:string,bg:string,fg:string},
 *   fonts:{heading:string,body:string},
 *   tone:string[],
 *   audience:string,
 *   do:string[],
 *   dont:string[],
 *   sections:string[]
 * }>}
 */
export async function deconstructBrand() {
  return {
    colors: { primary: "#FE2C55", accent: "#25F4EE", bg: "#000000", fg: "#FFFFFF" },
    fonts: { heading: "Inter", body: "Inter" },
    tone: ["bold", "energetic", "direct"],
    audience: "creators & businesses",
    do: ["strong hierarchy", "flat brand color blocks", "proof points"],
    dont: ["NO gradients", "no generic AI stock", "no tiny text"],
    sections: ["hero", "problem", "how-it-works", "proof", "cta"],
  };
}

// ---- tiny smoke test (no network required) ----
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    let ok = true;
    const log = (cond, msg) => { if (!cond) ok = false; console.log(cond ? "PASS" : "FAIL", msg); };

    const b = await deconstructBrand();
    log(b.colors.primary === "#FE2C55", "primary color");
    log(b.colors.accent === "#25F4EE", "accent color");
    log(b.colors.bg === "#000000" && b.colors.fg === "#FFFFFF", "bg/fg colors");
    log(b.fonts.heading === "Inter" && b.fonts.body === "Inter", "fonts");
    log(Array.isArray(b.tone) && b.tone.length === 3, "tone array");
    log(b.audience === "creators & businesses", "audience");
    log(Array.isArray(b.do) && b.do.length === 3, "do array");
    log(Array.isArray(b.dont) && b.dont.length === 3, "dont array");
    log(Array.isArray(b.sections) && b.sections.length === 5, "sections array");

    console.log(ok ? "brand.mjs smoke: ALL PASS" : "brand.mjs smoke: FAILURES");
    process.exit(ok ? 0 : 1);
  })();
}
