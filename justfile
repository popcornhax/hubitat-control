set shell := ["zsh", "-cu"]

default: check

bootstrap:
    npm ci

build:
    npm run build

test:
    @echo "No automated test suite is configured for streamdeck-hubitat." >&2; exit 1

lint:
    @echo "No lint command is configured for streamdeck-hubitat." >&2; exit 1

check: build
