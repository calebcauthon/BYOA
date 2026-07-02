SHELL := /bin/sh

HOST ?= 127.0.0.1
AUTOMATIONS_STATE_DIR ?= .automations-state

# PORT / CONSOLE_PORT are intentionally NOT given defaults here. If set, they are
# forwarded and honored as-is; if unset, scripts/dev.mjs auto-detects free ports
# (starting at 7700 / 5173) so `make dev` works on a clean checkout even when a
# stale dev stack is holding those ports. Injecting a default here would make the
# vars always "set", defeating that auto-detection.

.PHONY: dev build typecheck console-build orchestrator

dev:
	@HOST="$(HOST)" $(if $(PORT),PORT="$(PORT)") $(if $(CONSOLE_PORT),CONSOLE_PORT="$(CONSOLE_PORT)") AUTOMATIONS_STATE_DIR="$(AUTOMATIONS_STATE_DIR)" node scripts/dev.mjs

build:
	npm run build
	npm run build -w @automations/console

typecheck:
	npm run typecheck

console-build:
	npm run build -w @automations/console

orchestrator:
	AUTOMATIONS_STATE_DIR="$(AUTOMATIONS_STATE_DIR)" $(if $(PORT),PORT="$(PORT)") node packages/orchestrator/src/main.ts
