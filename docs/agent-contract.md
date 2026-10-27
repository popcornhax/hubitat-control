# Agent Contract

## Stack and layout

- TypeScript Stream Deck plugin built with Rollup. `src/plugin.ts` owns Stream Deck lifecycle and actions; `src/hubitat-client.ts` owns Maker API communication.
- `com.popcornhax.hubitat-control.sdPlugin/` contains the plugin manifest, property inspector, images, and generated `bin/` output.
- Rollup compiles `src/plugin.ts` to the ignored plugin `bin/plugin.js`; watch mode also restarts the Stream Deck plugin.

## Boundaries and hazards

- Hubitat IP, Maker API app ID, access token, device state, and Stream Deck settings are secrets or personal data. Never log or commit them.
- Device commands have physical effects. Routine checks must not contact a live hub or invoke commands.
- Keep manifest UUIDs, action identifiers, property-inspector messages, plugin runtime messages, and settings keys compatible.
- Packaging, installation, release archives, and watch-mode restarts are outside `check`.

## Canonical commands

- Bootstrap: `just bootstrap`
- Production bundle: `just build`
- Full safe check: `just check`
- No automated test or lint lane exists; `just test` and `just lint` fail explicitly.

## Completion evidence

- Run `just check` and confirm Rollup/TypeScript completes.
- Manually verify the property inspector and plugin in Stream Deck with a non-production or explicitly authorized Hubitat environment. Report live device behavior as unverified otherwise.
