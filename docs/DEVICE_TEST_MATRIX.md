# PixelGBA real-device test matrix

Automated tests cannot reproduce mobile storage eviction, sleep/wake, real controllers, touch latency, or the GPU behavior of physical Safari/Firefox devices. Run this checklist before a release and record results through the **Device compatibility report** issue form.

## Release gate

For every device/browser combination below:

1. Open `check.html` and confirm every asset passes.
2. Install PixelGBA when the platform offers installation; reopen it standalone.
3. Load the project-owned smoke ROM or a legally dumped ROM. Test raw `.gba` and ZIP copies and confirm they share one library entry/save.
4. Play for five minutes. Save in-game, immediately background or sleep the device for at least one minute, then resume and confirm the hidden-page flush updated the save. Stop and relaunch to verify it persisted.
5. Create/load/delete a state; export/import `.pgstate`; export a full backup.
6. Connect a standard controller where supported. Verify D-pad, A/B, shoulders, Start/Select, disconnect, and reconnect.
7. Exercise touch controls in portrait and landscape, fullscreen entry/exit, audio mute/unmute, and rotation.
8. Inspect **Help → Install & storage health** and request persistent storage.
9. Export the privacy-safe diagnostic report and attach it only if something fails. Never attach ROMs or saves.

## Target matrix

| Platform | Browser | Install | Core boot | Save after sleep | Touch/rotation | Controller | Backup restore | Result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| iPhone/iPad current iOS | Safari standalone | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | Not yet recorded |
| macOS current | Safari | ☐ | ☐ | ☐ | N/A | ☐ | ☐ | Not yet recorded |
| Android current | Chrome standalone | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ | Not yet recorded |
| Windows 11 | Chrome/Edge | ☐ | ☐ | ☐ | N/A | ☐ | ☐ | Not yet recorded |
| Windows 11 | Firefox | N/A | ☐ | ☐ | N/A | ☐ | ☐ | Not yet recorded |
| macOS/Linux current | Firefox | N/A | ☐ | ☐ | N/A | ☐ | ☐ | Not yet recorded |

## Pass criteria

- No uncaught page errors or unexplained black screen.
- Battery save restored byte-for-byte after stop/relaunch and after sleep/wake.
- No duplicate ROM identity between raw and archived copies.
- Controller/touch input does not stick after reconnect or rotation.
- Backup restores into a clean browser profile and passes all checksums.
- Installed app receives the explicit update prompt and retains data after updating.

Do not mark a platform supported based only on desktop emulation or a headless browser. Record the physical model, OS/browser versions, result, and diagnostic report build ID.
