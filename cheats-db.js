/* ==========================================================================
   PixelGBA — Pokémon cheat-code preset database
   --------------------------------------------------------------------------
   Codes are community-collected GameShark / Action Replay / CodeBreaker
   codes for the *English* retail releases. Format accepted by the emulator:

     GameShark / Action Replay : XXXXXXXXX YYYYYYYY  (8+8 hex)
     CodeBreaker               : XXXXXXXX YYYY       (8+4 hex)

   One line per code line. Multi-line codes go on separate lines.
   Cheats that need a "master code" have it included as its own preset so
   you can toggle it separately.
   ========================================================================== */

window.PIXELGBA_PRESETS = {
  version: 1,

  games: [
    {
      id: "emerald",
      title: "Pokémon Emerald",
      matches: ["emerald"],
      headers: [{ gameCode: "BPEE", revisions: [0] }],
      accent: "#34d399",
      note: "Item cheats marked “PokéMart” replace the first item sold in any shop — buy it for $0. Turn the cheat off when you are done.",
      cheats: [
        {
          name: "∞ Rare Candy (PokéMart)",
          code: "BFF956FA 2F9EC50D\n82005274 0044",
          tag: "Item"
        },
        {
          name: "∞ Master Ball (PokéMart)",
          code: "958D8046 A7151D70\n8BB602F7 8CEB681A\n82005274 0001",
          tag: "Item"
        },
        {
          name: "∞ Money (up to $999,999)",
          code: "82025BCC 0001\n82025BC4 E0FF\n82025BC6 05F5",
          tag: "Money"
        },
        {
          name: "Master Code (GameShark v3)",
          code: "D8BAE4D9 4864DCE5\nA86CDBA5 19BA49B3",
          tag: "Master",
          note: "Enable this first if a GameShark v3 / Action Replay code below does nothing."
        },
        {
          name: "Walk Through Walls",
          code: "7881A409 E2026E0C\n8E883EFF 92E9660D",
          tag: "Movement"
        },
        {
          name: "No Random Wild Battles",
          code: "B505DB41 6E39EA4E",
          tag: "Encounter"
        }
      ]
    },

    {
      id: "firered",
      title: "Pokémon FireRed",
      matches: ["firered", "fire red", "pokefirered"],
      headers: [{ gameCode: "BPRE", revisions: [0] }],
      accent: "#fb923c",
      note: "“PC slot 1” cheats overwrite the first item stack in your PC — withdraw it, then turn the cheat off.",
      cheats: [
        {
          name: "∞ Rare Candy (PC slot 1)",
          code: "82025840 0044",
          tag: "Item",
          note: "No master code needed. Withdraw from any Pokémon Center PC."
        },
        {
          name: "∞ Master Ball (PC slot 1)",
          code: "82025840 0001",
          tag: "Item"
        },
        {
          name: "∞ Money",
          code: "82025838 104E\n8202583A E971",
          tag: "Money"
        },
        {
          name: "All Badges",
          code: "EFCE867D 5403D40D",
          tag: "Progress",
          note: "Walk in and out of a building a few times after enabling."
        },
        {
          name: "Walk Through Walls",
          code: "509197D3 542975F4\n78DA95DF 44018CB4",
          tag: "Movement"
        },
        {
          name: "No Random Wild Battles",
          code: "A202166E FF00\n820255AC 0000",
          tag: "Encounter"
        },
        {
          name: "Items Cost $1",
          code: "3C25A344 FD8F451C\nAD86124F 2823D8DA",
          tag: "Shop"
        },
        {
          name: "Fast Level Up",
          code: "82023D50 270F",
          tag: "EXP"
        }
      ]
    },

    {
      id: "leafgreen",
      title: "Pokémon LeafGreen",
      matches: ["leafgreen", "leaf green", "pokeleafgreen"],
      headers: [{ gameCode: "BPGE", revisions: [0] }],
      accent: "#4ade80",
      note: "“PC slot 1” cheats overwrite the first item stack in your PC — withdraw it, then turn the cheat off.",
      cheats: [
        {
          name: "∞ Rare Candy (PC slot 1)",
          code: "82025840 0044",
          tag: "Item"
        },
        {
          name: "∞ Master Ball (PC slot 1)",
          code: "82025840 0001",
          tag: "Item"
        },
        {
          name: "∞ Money",
          code: "82025838 104E\n8202583A E971",
          tag: "Money"
        },
        {
          name: "All Badges",
          code: "EFCE867D 5403D40D",
          tag: "Progress"
        },
        {
          name: "Walk Through Walls",
          code: "509197D3 542975F4\n78DA95DF 44018CB4",
          tag: "Movement"
        },
        {
          name: "No Random Wild Battles",
          code: "A202166E FF00\n820255AC 0000",
          tag: "Encounter"
        },
        {
          name: "Items Cost $1",
          code: "3C25A344 FD8F451C\nAD86124F 2823D8DA",
          tag: "Shop"
        }
      ]
    },

    {
      id: "ruby",
      title: "Pokémon Ruby",
      matches: ["ruby"],
      headers: [{ gameCode: "AXVE", revisions: [0] }],
      accent: "#f87171",
      note: "Older (pre-Emerald) engine — some codes are less reliable. Enable the master code first if a cheat does nothing.",
      cheats: [
        {
          name: "Walk Through Walls",
          code: "E03B0649 5D67050C\n78DA95DF 44018CB4",
          tag: "Movement"
        },
        {
          name: "99 Master Balls (Bag)",
          code: "910C4AFB 679BA66A\n68E6EAC1 6AB638B4",
          tag: "Item"
        },
        {
          name: "∞ Money",
          code: "E51E97C3 7858E4EB",
          tag: "Money"
        },
        {
          name: "Rare Candies (PC)",
          code: "280EA266 88A62E5C",
          tag: "Item",
          note: "If this does nothing, try the FireRed-style code 82025840 0044 as a custom cheat instead."
        }
      ]
    },

    {
      id: "sapphire",
      title: "Pokémon Sapphire",
      matches: ["sapphire"],
      headers: [{ gameCode: "AXPE", revisions: [0] }],
      accent: "#60a5fa",
      note: "Older (pre-Emerald) engine — some codes are less reliable. Enable the master code first if a cheat does nothing.",
      cheats: [
        {
          name: "Walk Through Walls",
          code: "E03B0649 5D67050C\n78DA95DF 44018CB4",
          tag: "Movement"
        },
        {
          name: "99 Master Balls (Bag)",
          code: "910C4AFB 679BA66A\n68E6EAC1 6AB638B4",
          tag: "Item"
        },
        {
          name: "∞ Money",
          code: "E51E97C3 7858E4EB",
          tag: "Money"
        },
        {
          name: "Rare Candies (PC)",
          code: "280EA266 88A62E5C",
          tag: "Item"
        }
      ]
    }
  ],

  /* ------- helpers shared with js/app.js (kept here so UI + API agree) ---- */

  /** Normalise a ROM filename to a stable key, e.g. "Pokemon - Emerald.gba" -> "pokemon-emerald" */
  slug(name) {
    return String(name || "game")
      .replace(/\.(gba|agb|bin|zip|7z|rom)$/i, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "game";
  },

  /**
   * Match a preset from the cartridge header when available. Header matches are
   * deliberately exact by game code and revision: a renamed regional/revised ROM
   * must not silently receive codes intended for another executable. Filename
   * matching remains only for old metadata and files without a readable header.
   */
  match(filename, header = null) {
    if (header && /^[A-Z0-9]{4}$/.test(header.gameCode || "")) {
      for (const game of this.games) {
        for (const candidate of (game.headers || [])) {
          if (candidate.gameCode === header.gameCode &&
              (!candidate.revisions || candidate.revisions.includes(header.revision))) return game;
        }
      }
      return null;
    }
    const base = String(filename || "")
      .replace(/\.(gba|agb|bin|zip|7z|rom)$/i, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ");
    const compact = base.replace(/\s+/g, "");
    for (const game of this.games) {
      for (const m of game.matches) {
        const needle = m.replace(/[^a-z0-9]/g, "");
        if (compact.includes(needle)) return game;
      }
    }
    return null;
  }
};
