// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import { bootstrapApplication } from "@angular/platform-browser";
import { CapillaryShellComponent } from "./app/shell/capillary-shell.component";
import { appConfig } from "./app/app.config";

bootstrapApplication(CapillaryShellComponent, appConfig)
  .catch((error) => console.error(error));
