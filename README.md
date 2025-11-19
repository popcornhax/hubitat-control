# Hubitat Control – Stream Deck Plugin

Control Hubitat Elevation devices directly from an Elgato Stream Deck. Supports full device command execution, dynamic state icons, and automatic device/command discovery.

## Features

- Auto-discovers Hubitat devices via Maker API
- Loads supported device commands (on, off, toggle, setLevel, setColorTemperature, refresh, poll, etc.)
- Loads available status attributes for state tracking
- Optional matched/unmatched icons based on attribute value
- Automatic polling updates key titles and icons
- Global Hubitat connection settings reused across all keys
- Works with any device exposed by Maker API

## Requirements

- Hubitat Elevation with Maker API enabled
- Hub IP, Maker API App ID, and Access Token
- Stream Deck (Original, MK.2, XL, or Stream Deck+)

## Setup

1. Install the plugin by double-clicking the .streamDeckPlugin file  
2. In Hubitat Maker API:  
   - Enable desired devices  
   - Copy Hub IP, App ID, and Access Token  
3. In Stream Deck:  
   - Add a Hubitat Control action  
   - Enter Hubitat connection info  
   - Select a device  
   - Select a command  
   - (Optional) enter a command parameter  
   - (Optional) choose a status attribute + expected value  
   - (Optional) choose matched/unmatched images  

## Status Icons

You can provide two optional images:
- Matched image (shown when attribute equals expected value)
- Unmatched image (shown otherwise)

Example:  
Attribute: switch  
Expected value: on

## Building From Source

npm install  
npm run build  

The compiled plugin appears in:  
com.popcornhax.hubitat-control.sdPlugin/bin/

To package for release:

zip -r HubitatControl.streamDeckPlugin com.popcornhax.hubitat-control.sdPlugin

