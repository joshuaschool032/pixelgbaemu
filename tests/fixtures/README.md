# Browser-test ROM fixture

`make-homebrew-rom.js` generates the fixture in memory. It is original project test code: one ARM `b .` instruction, a project-created header, and zero padding. It contains no Nintendo logo, BIOS, ROM dump, or commercial game content. The fixture is used only to verify that the bundled mGBA core reaches its start event.
