import { useState } from "react";

// Platform mark used wherever PokerStars and ClubGG content sits side by side
// (Results cards, My Stats section headings). Falls back to a suit glyph if the
// logo file is missing, so the layout never breaks.
const BRAND = {
  pokerstars: { src: "/pokerstars.png", glyph: "♠", color: "#d0021b", label: "PokerStars" },
  clubgg: { src: "/clubgg.png", glyph: "♣", color: "#e2e6ee", label: "ClubGG" },
};

export default function PlatformLogo({ platform, size = 18 }) {
  const [ok, setOk] = useState(true);
  const b = BRAND[platform] || BRAND.pokerstars;
  return ok ? (
    <img
      src={b.src}
      alt={b.label}
      title={b.label}
      onError={() => setOk(false)}
      style={{ height: size, width: "auto", maxWidth: size * 2.6, objectFit: "contain", verticalAlign: "middle" }}
    />
  ) : (
    <span title={b.label} style={{ color: b.color, fontSize: size * 0.85, lineHeight: 1 }}>{b.glyph}</span>
  );
}
