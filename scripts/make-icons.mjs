/**
 * Regenerates the raster icons in public/ from public/favicon.svg, which holds the
 * "d." lettermark as vector paths (Fraunces 600, the wordmark's face, converted once).
 *
 * @resvg/resvg-js is deliberately not a project dependency:
 *   npm i --no-save @resvg/resvg-js && node scripts/make-icons.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";

const master = readFileSync("public/favicon.svg", "utf8");
const pathOf = (cls) => master.match(new RegExp(`class="${cls}" d="([^"]+)"`))[1];
const d = pathOf("d");
const dot = pathOf("dot");

// Same colours as the light theme in src/tokens.css.
const PAPER = "#f7f4ee";
const INK = "#1a1815";
const ACCENT = "#c4462a";

/** `rx` rounds the tile (0 = full bleed, for icons the OS masks itself). `scale` shrinks the mark. */
function variant({ rx, scale = 1 }) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="${rx}" fill="${PAPER}"/>
  <g transform="translate(256 256) scale(${scale}) translate(-256 -256)">
    <path d="${d}" fill="${INK}"/>
    <path d="${dot}" fill="${ACCENT}"/>
  </g>
</svg>`;
}

const png = (svg, size) =>
    new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();

const rounded = variant({ rx: 112 });
const bleed = variant({ rx: 0 });
// Maskable icons keep their content inside the central 80% so any mask shape works.
const maskable = variant({ rx: 0, scale: 0.8 });

const files = {
    "public/apple-touch-icon.png": png(bleed, 180),
    "public/icon-192.png": png(rounded, 192),
    "public/icon-512.png": png(rounded, 512),
    "public/icon-maskable-512.png": png(maskable, 512),
};

// .ico is a small container; each image can be an embedded PNG.
function ico(images) {
    const header = Buffer.alloc(6);
    header.writeUInt16LE(1, 2); // type: icon
    header.writeUInt16LE(images.length, 4);
    let offset = 6 + 16 * images.length;
    const entries = images.map(({ size, data }) => {
        const e = Buffer.alloc(16);
        e.writeUInt8(size, 0);
        e.writeUInt8(size, 1);
        e.writeUInt16LE(1, 4); // colour planes
        e.writeUInt16LE(32, 6); // bits per pixel
        e.writeUInt32LE(data.length, 8);
        e.writeUInt32LE(offset, 12);
        offset += data.length;
        return e;
    });
    return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}
files["public/favicon.ico"] = ico([16, 32, 48].map((size) => ({ size, data: png(rounded, size) })));

for (const [path, data] of Object.entries(files)) {
    writeFileSync(path, data);
    console.log(`${path}  ${data.length} bytes`);
}
