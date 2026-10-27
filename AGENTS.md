# Stream Deck Hubitat Agent Guide

Read `docs/agent-contract.md` before changing Maker API calls, device discovery, polling, settings, or plugin packaging.

- Never expose Hubitat IPs, app IDs, access tokens, or user settings.
- Keep the manifest, property inspector, runtime messages, and compiled plugin contract aligned.
- Do not use watch mode, restart Stream Deck, install/package a plugin, or operate real Hubitat devices unless the user explicitly asks.
- Validate with the canonical `just` recipes and report hardware integration as unverified.
