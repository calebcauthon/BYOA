SHELL := /bin/sh

HOST ?= 127.0.0.1
PORT ?= 7700
CONSOLE_PORT ?= 5173
AUTOMATIONS_STATE_DIR ?= .automations-state

.PHONY: dev build typecheck console-build orchestrator

dev:
	@HOST="$(HOST)" PORT="$(PORT)" CONSOLE_PORT="$(CONSOLE_PORT)" AUTOMATIONS_STATE_DIR="$(AUTOMATIONS_STATE_DIR)" node scripts/dev.mjs

build:
	npm run build
	npm run build -w @automations/console

typecheck:
	npm run typecheck

console-build:
	npm run build -w @automations/console

orchestrator:
	AUTOMATIONS_STATE_DIR="$(AUTOMATIONS_STATE_DIR)" PORT="$(PORT)" node packages/orchestrator/src/main.ts
