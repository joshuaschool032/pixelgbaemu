# Cheat preset provenance and compatibility

Preset availability is deliberately narrower than filename matching. PixelGBA reads the cartridge header and requires an exact game code and revision. Verification is tracked per entry: only codes matched in full against the pinned revision-specific snapshot are interactive. Legacy entries that are absent from that snapshot remain visible for auditability but are disabled and marked **source needed**.

| Preset | Cartridge | Region/revision | Status | Pinned cross-reference |
| --- | --- | --- | --- | --- |
| Pokémon Emerald | `BPEE`, revision `0` | US English v1.0 | 4 source-matched entries; physical-device test pending | [Cheat Companion snapshot](https://github.com/Cristofferb7/cheat-companion/blob/0dff83c1a03a4c502126e9592d36900cd1275e4e/data/games/pokemon-emerald-us.json) |
| Pokémon FireRed | `BPRE`, revision `0` | US English v1.0 | 3 source-matched entries; physical-device test pending | [Cheat Companion snapshot](https://github.com/Cristofferb7/cheat-companion/blob/0dff83c1a03a4c502126e9592d36900cd1275e4e/data/games/pokemon-firered-us.json) |
| Pokémon LeafGreen | `BPGE`, revision `0` | US English v1.0 | 4 source-matched entries; physical-device test pending | [Cheat Companion snapshot](https://github.com/Cristofferb7/cheat-companion/blob/0dff83c1a03a4c502126e9592d36900cd1275e4e/data/games/pokemon-leafgreen-us.json) |
| Pokémon Ruby | `AXVE`, revision `0` | US English v1.0 | 3 source-matched entries; physical-device test pending | [Cheat Companion snapshot](https://github.com/Cristofferb7/cheat-companion/blob/0dff83c1a03a4c502126e9592d36900cd1275e4e/data/games/pokemon-ruby-us.json) |
| Pokémon Sapphire | `AXPE`, revision `0` | US English v1.0 | Disabled: independent revision-specific source needed | Legacy project list only |

“Source-matched” means the complete entry appears in the immutable snapshot; it does **not** mean verified on every cartridge, emulator version, or save. The physical-device matrix in `DEVICE_TEST_MATRIX.md` tracks that stronger claim. Preset entries also record their GameShark/Action Replay, CodeBreaker, or mixed-device format; custom codes remain the user's responsibility.

When changing a preset:

1. Pin the source to an immutable commit URL.
2. Confirm game code, region, and ROM revision separately; never assume FireRed/LeafGreen or Ruby/Sapphire addresses are interchangeable.
3. Record code device type and master-code requirements.
4. Add unit coverage for header matching and disabled unverified lists.
5. Complete the real-device checklist before changing status from “physical-device test pending.”
