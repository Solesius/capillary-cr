// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { CommonModule } from "@angular/common";
import { FormsModule } from "@angular/forms";
import { CapillaryStore } from "../state/capillary.store";

@Component({
  selector: "app-confirmation-checklist-panel",
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <section>
      <header class="cap-panel-title">
        <span>Author Checklist</span>
        <span class="cap-muted">{{ store.checklistCompletion() }}%</span>
      </header>
      <div class="cap-panel-body cap-list">
        @for (item of store.checklist(); track item.id) {
          <label class="cap-check-item cap-card">
            <input type="checkbox" [checked]="item.completed" (change)="toggle(item.id)" />
            <span>
              <strong>{{ item.description }}</strong>
              @if (item.command) {
                <span class="cap-code">{{ item.command }}</span>
              }
            </span>
          </label>
        }
      </div>
    </section>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConfirmationChecklistPanelComponent {
  readonly store = inject(CapillaryStore);

  toggle(itemId: string): void {
    const updated = this.store.checklist().map((item) =>
      item.id === itemId ? { ...item, completed: !item.completed } : item
    );
    this.store.checklist.set(updated);
  }
}
