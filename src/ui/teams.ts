/* Team tile colours, by sport and abbreviation (primary colour only; purely cosmetic).
   An abbreviation that isn't listed gets a neutral tile, so a new or renamed team never breaks anything. */
const T = {
  mlb: {
    ARI: "#a71930", AZ: "#a71930", ATL: "#13274f", BAL: "#df4601", BOS: "#bd3039", CHC: "#0e3386", CWS: "#27251f", CHW: "#27251f", CIN: "#c6011f",
    CLE: "#00385d", COL: "#33006f", DET: "#0c2340", HOU: "#eb6e1f", KC: "#004687", LAA: "#ba0021", LAD: "#005a9c", MIA: "#00a3e0", MIL: "#12284b",
    MIN: "#002b5c", NYM: "#002d72", NYY: "#0c2340", ATH: "#003831", OAK: "#003831", PHI: "#e81828", PIT: "#fdb827", SD: "#2f241d", SF: "#fd5a1e",
    SEA: "#0c2c56", STL: "#c41e3a", TB: "#092c5c", TEX: "#003278", TOR: "#134a8e", WSH: "#ab0003", WAS: "#ab0003",
  },
  nba: {
    ATL: "#e03a3e", BOS: "#007a33", BKN: "#27251f", CHA: "#1d1160", CHI: "#ce1141", CLE: "#860038", DAL: "#00538c", DEN: "#0e2240", DET: "#c8102e",
    GS: "#1d428a", GSW: "#1d428a", HOU: "#ce1141", IND: "#002d62", LAC: "#c8102e", LAL: "#552583", MEM: "#5d76a9", MIA: "#98002e", MIL: "#00471b",
    MIN: "#0c2340", NO: "#0c2340", NOP: "#0c2340", NY: "#f58426", NYK: "#f58426", OKC: "#007ac1", ORL: "#0077c0", PHI: "#006bb6", PHX: "#1d1160",
    POR: "#e03a3e", SAC: "#5a2d81", SA: "#8a8d8f", SAS: "#8a8d8f", TOR: "#ce1141", UTAH: "#002b5c", UTA: "#002b5c", WSH: "#002b5c", WAS: "#002b5c",
  },
  nfl: {
    ARI: "#97233f", ATL: "#a71930", BAL: "#241773", BUF: "#00338d", CAR: "#0085ca", CHI: "#0b162a", CIN: "#fb4f14", CLE: "#311d00", DAL: "#003594",
    DEN: "#fb4f14", DET: "#0076b6", GB: "#203731", HOU: "#03202f", IND: "#002c5f", JAX: "#006778", JAC: "#006778", KC: "#e31837", LV: "#27251f",
    LAC: "#0080c6", LAR: "#003594", LA: "#003594", MIA: "#008e97", MIN: "#4f2683", NE: "#002244", NO: "#d3bc8d", NYG: "#0b2265", NYJ: "#125740",
    PHI: "#004c54", PIT: "#ffb612", SF: "#aa0000", SEA: "#002244", TB: "#d50a0a", TEN: "#0c2340", WSH: "#5a1414", WAS: "#5a1414",
  },
  nhl: {
    ANA: "#f47a38", BOS: "#ffb81c", BUF: "#003087", CGY: "#c8102e", CAR: "#cc0000", CHI: "#cf0a2c", COL: "#6f263d", CBJ: "#002654", DAL: "#006847",
    DET: "#ce1126", EDM: "#ff4c00", FLA: "#c8102e", LA: "#27251f", LAK: "#27251f", MIN: "#154734", MTL: "#af1e2d", NSH: "#ffb81c", NJ: "#ce1126",
    NJD: "#ce1126", NYI: "#00539b", NYR: "#0038a8", OTT: "#c52032", PHI: "#f74902", PIT: "#fcb514", SJ: "#006d75", SJS: "#006d75", SEA: "#001628",
    STL: "#002f87", TB: "#002868", TBL: "#002868", TOR: "#00205b", UTA: "#6cace4", UTAH: "#6cace4", VAN: "#00205b", VGK: "#b4975a", WSH: "#041e42",
    WPG: "#041e42",
  },
};
export function teamColor(sport, ab) {
  const bg = T[sport] && T[sport][String(ab || "").toUpperCase()];
  if (!bg) return { background: "var(--panel-2)", color: "var(--ink)", boxShadow: "inset 0 0 0 1px var(--line-2)" };
  const n = parseInt(bg.slice(1), 16), lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return { background: bg, color: lum > 0.6 ? "#10141a" : "#ffffff" };
}
