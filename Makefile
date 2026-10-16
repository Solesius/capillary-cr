SHELL := /bin/bash

# Container image coordinates for GitHub Container Registry (GHCR).
# Override OWNER/REPO once your registry repo exists, e.g.:
#   make image-push IMAGE=ghcr.io/acme/capillary TAG=v0.1.0
REGISTRY ?= ghcr.io
OWNER    ?= Solesius
REPO     ?= capillary
IMAGE    ?= $(REGISTRY)/$(OWNER)/$(REPO)
TAG      ?= latest

.PHONY: dev dev-api dev-web native check test test-api test-web test-e2e cdp-retv \
	docker-build docker-up docker-down compat \
	image-build image-push image-pull image-run registry-login

dev: ## Run API and web locally
	@echo "Starting Capillary local dev stack"
	@$(MAKE) -j2 dev-api dev-web

dev-api:
	cd api && npm run dev

dev-web:
	cd web && npm install && npm run start

native: ## Build the celer-mem FFI shim (api/native/libceler_ffi.so)
	cd api && ./native/build.sh

check: ## Type-check the API
	cd api && npm run check

test: test-api test-web test-e2e

test-api:
	cd api && npm test

test-web:
	cd web && npm install && npm run test

test-e2e:
	cd web && npm install && npm run e2e

cdp-retv:
	cd api && npm run cdp:retv -- $(ARGS)

docker-build:
	docker compose build capillary

docker-up:
	docker compose up --build capillary

docker-down:
	docker compose down

compat: ## Deno ↔ Node wire + storage compatibility check (V1=<image> V2=<image>)
	compat/run.sh $(V1) $(V2)

## --- GitHub Container Registry (GHCR) ---------------------------------------

registry-login: ## Log in to GHCR (expects: echo $$GHCR_TOKEN | make registry-login)
	@test -n "$(OWNER)" && [ "$(OWNER)" != "OWNER" ] || { echo "Set OWNER=<github-user-or-org>"; exit 1; }
	@test -n "$$GHCR_TOKEN" || { echo "Set GHCR_TOKEN (a PAT with write:packages) in the environment"; exit 1; }
	@echo "$$GHCR_TOKEN" | docker login $(REGISTRY) -u "$(OWNER)" --password-stdin

image-build: ## Build and tag the release image as $(IMAGE):$(TAG)
	docker build -f Dockerfile -t $(IMAGE):$(TAG) .

image-push: image-build ## Build then push $(IMAGE):$(TAG) to GHCR
	@[ "$(OWNER)" != "OWNER" ] && [ "$(REPO)" != "REPO" ] || { echo "Set OWNER and REPO to your GHCR repo before pushing"; exit 1; }
	docker push $(IMAGE):$(TAG)

image-pull: ## Pull $(IMAGE):$(TAG) from GHCR
	docker pull $(IMAGE):$(TAG)

image-run: ## Run the published image via compose (CAPILLARY_IMAGE=$(IMAGE):$(TAG))
	CAPILLARY_IMAGE=$(IMAGE):$(TAG) docker compose up -d
