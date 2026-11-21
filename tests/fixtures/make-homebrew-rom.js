"use strict";

/**
 * Generate a minimal, original GBA test program. The first ARM instruction loops
 * forever; the remaining bytes are a project-created header and zero padding.
 * It includes no Nintendo logo, BIOS, or commercial game data.
 */
function makeHomebrewRom() {
  const rom = Buffer.alloc(1024, 0);
  rom.writeUInt32LE(0xeafffffe, 0); // b .
  rom.write("ARENA SMOKE", 0xa0, "ascii");
  rom.write("ASMK", 0xac, "ascii");
  rom.write("00", 0xb0, "ascii");
  rom[0xb2] = 0x96;
  rom[0xbc] = 0;
  let sum = 0;
  for (let i = 0xa0; i <= 0xbc; i++) sum = (sum + rom[i]) & 0xff;
  rom[0xbd] = (-(sum + 0x19)) & 0xff;
  return rom;
}

module.exports = { makeHomebrewRom };
