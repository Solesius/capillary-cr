SHELL := /bin/bash

# v2 (Node) stack. Paths are relative to v2/; the image builds from the
# repository root because the web app is shared with v1.
REGISTRY ?= ghcr.io
OWNER    ?= Solesius
REPO     ?= capillary
IMAGE    ?= $(REGISTRY)/$(OWNER)/$(REPO)
TAG      ?= latest
COMPOSE  := docker compose -f docker-compose.yml

.PHONY: dev dev-api dev-web native test test-api test-web check cdp-retv \
	docker-build docker-up docker-down image-build image-push compat

dev: ## Run API and web locally
	@$(MAKE) -j2 dev-api dev-web

dev-api:
	cd api && npm run dev

dev-web:
	cd ../web && npm install && npm run start

native: ## Build the celer-mem FFI shim (api/native/libceler_ffi.so)
	cd api && ./native/build.sh

check:
	cd api && npm run check

test: test-api test-web

test-api:
	cd api && npm test

test-web:
	cd ../web && npm install && npm run test

cdp-retv:
	cd api && npm run cdp:retv -- $(ARGS)

docker-build:
	$(COMPOSE) build capillary

docker-up:
	$(COMPOSE) up --build capillary

docker-down:
	$(COMPOSE) down

image-build: ## Build and tag the release image as $(IMAGE):$(TAG)
	docker build -f Dockerfile -t $(IMAGE):$(TAG) ..

image-push: image-build
	docker push $(IMAGE):$(TAG)

compat: ## v1 ↔ v2 wire + storage compatibility check (see compat/run.sh)
	cd .. && v2/compat/run.sh $(V1) $(V2)
