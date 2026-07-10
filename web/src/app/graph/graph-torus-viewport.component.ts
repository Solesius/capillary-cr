// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  computed,
  effect,
  inject,
  signal,
} from "@angular/core";
import { CommonModule } from "@angular/common";
import Zdog from "zdog";
import { CapillaryStore } from "../state/capillary.store";
import { GraphEdge, GraphNode, GraphShapeSample } from "../models";

// Radii mirror the API's TORUS_RADIUS_MAJOR/MINOR so sample angles land on
// the drawn surface. Convention (house style): phi = major (toroidal) angle,
// theta = minor (poloidal) angle. Rendered with Zdog (pure canvas 2D) — no
// WebGL dependency, so it works under locked-down enterprise browsers.
const TORUS_MAJOR = 2.4;
const TORUS_MINOR = 0.8;
const SCALE = 46; // world units -> canvas px at zoom 1
const CHANGED_COLOR = "#ffd400";
const WETTED_COLOR = "#f2f2f2";
const CAGE_COLOR = "rgba(148, 163, 184, 0.25)";
const EDGE_COLORS: Record<string, string> = {
  semantic: "rgba(45, 212, 191, 0.55)",
  imports: "rgba(148, 163, 184, 0.4)",
  changed_with: "rgba(148, 163, 184, 0.22)",
};
const MAX_DRAWN_EDGES = 400;

interface HoverInfo {
  readonly name: string;
  readonly path: string;
  readonly kind: string;
  readonly changed: boolean;
  readonly x: number;
  readonly y: number;
}

interface PlacedNode {
  readonly node: GraphNode;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

interface TrailStep {
  readonly path: string;
  readonly kind: string;
  readonly changed: boolean;
  readonly via: string;
}

interface TrailRow {
  readonly path: string;
  readonly direct: TrailStep[];
  readonly rippleCount: number;
  readonly ripplePreview: string[];
}

@Component({
  selector: "app-graph-torus-viewport",
  standalone: true,
  imports: [CommonModule],
  template: `
    <section>
      <header class="cap-panel-title">
        <span>Change Surface</span>
        <div class="cap-surface-tabs">
          <button
            type="button"
            class="cap-surface-tab"
            [class.active]="mode() === 'surface'"
            (click)="setMode('surface')">Surface</button>
          <button
            type="button"
            class="cap-surface-tab"
            [class.active]="mode() === 'trail'"
            (click)="setMode('trail')">Trail</button>
        </div>
      </header>
      <div class="cap-panel-body">
        <div class="cap-torus-stage" [hidden]="mode() !== 'surface'">
          <canvas
            #torusCanvas
            class="cap-torus-canvas"
            aria-label="Interactive Capillary change surface"></canvas>
          @if (hover(); as info) {
            <div
              class="cap-torus-tooltip"
              [class.changed]="info.changed"
              [style.left.px]="info.x"
              [style.top.px]="info.y">
              <span class="cap-torus-tooltip-name">{{ info.name }}</span>
              <span class="cap-torus-tooltip-path">{{ info.path }}</span>
              <span class="cap-torus-tooltip-kind">{{ info.kind }}{{ info.changed ? ' · changed' : ' · touched' }}</span>
            </div>
          }
          <div class="cap-torus-legend">
            <span><i class="dot changed"></i>changed</span>
            <span><i class="dot wetted"></i>touched</span>
            <span class="cap-muted">scroll = zoom · drag = orbit · hover = file</span>
          </div>
        </div>

        @if (mode() === 'trail') {
          @if (trail().length === 0) {
            <div class="cap-review-output-shell">
              <div class="cap-review-output-empty">
                <strong>No trail yet.</strong>
                <span class="cap-muted">Run a review — every changed file and everything it touches lands here.</span>
              </div>
            </div>
          } @else {
            <div class="cap-trail">
              @for (row of trail(); track row.path) {
                <div class="cap-trail-row">
                  <div class="cap-trail-head">
                    <i class="dot changed"></i>
                    <span class="cap-trail-path">{{ row.path }}</span>
                  </div>
                  @for (step of row.direct; track step.path) {
                    <div class="cap-trail-step">
                      <span class="cap-trail-arrow">└─</span>
                      <span class="cap-trail-via" [class.semantic]="step.via === 'meaning'">{{ step.via }}</span>
                      <i class="dot" [class.changed]="step.changed" [class.wetted]="!step.changed"></i>
                      <span class="cap-trail-target">{{ step.path }}</span>
                    </div>
                  }
                  @if (row.rippleCount > 0) {
                    <div class="cap-trail-ripple">
                      ripple: {{ row.ripplePreview.join(', ') }}{{ row.rippleCount > row.ripplePreview.length ? ' +' + (row.rippleCount - row.ripplePreview.length) + ' more' : '' }}
                    </div>
                  }
                </div>
              }
            </div>
          }
        }
      </div>
    </section>
  `,
  styles: [`
    .cap-surface-tabs { display: inline-flex; gap: 4px; }
    .cap-surface-tab {
      font-size: 0.7rem;
      font-weight: 600;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      padding: 4px 12px;
      border-radius: 3px;
      border: 1px solid var(--cap-border);
      background: transparent;
      color: var(--cap-muted);
      cursor: pointer;
      transition: border-color 0.18s, color 0.18s, background 0.18s;
    }
    .cap-surface-tab:hover { border-color: var(--cap-primary-line); }
    .cap-surface-tab.active {
      border-color: var(--cap-accent);
      color: var(--cap-text);
      background: rgba(var(--cap-accent-rgb), 0.08);
    }

    .cap-torus-stage { position: relative; }
    .cap-torus-canvas {
      width: 100%;
      height: 360px;
      display: block;
      border: 1px solid var(--cap-border);
      border-radius: var(--cap-radius-sm, 12px);
      background: radial-gradient(ellipse at 50% 40%, rgba(45, 212, 191, 0.05), transparent 70%);
      cursor: grab;
      touch-action: none;
    }
    .cap-torus-canvas:active { cursor: grabbing; }
    .cap-torus-tooltip {
      position: absolute;
      transform: translate(12px, -50%);
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 8px 10px;
      border-radius: 4px;
      border: 1px solid var(--cap-border);
      background: var(--cap-surface, #0e1420);
      pointer-events: none;
      max-width: 320px;
      z-index: 5;
    }
    .cap-torus-tooltip.changed { border-color: rgba(255, 212, 0, 0.5); }
    .cap-torus-tooltip-name { font-weight: 700; font-size: 0.8rem; }
    .cap-torus-tooltip-path {
      font-family: var(--cap-mono, monospace);
      font-size: 0.7rem;
      color: var(--cap-muted);
      word-break: break-all;
    }
    .cap-torus-tooltip-kind {
      font-size: 0.66rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--cap-muted);
    }
    .cap-torus-legend {
      display: flex;
      gap: 16px;
      align-items: center;
      margin-top: 8px;
      font-size: 0.72rem;
      color: var(--cap-muted);
    }
    .cap-torus-legend .dot, .cap-trail .dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      margin-right: 6px;
      vertical-align: baseline;
    }
    .dot.changed { background: #ffd400; }
    .dot.wetted { background: #f2f2f2; border: 1px solid var(--cap-border); }

    .cap-trail { display: flex; flex-direction: column; gap: 14px; }
    .cap-trail-row {
      padding: 12px 14px;
      border: 1px solid var(--cap-border);
      border-radius: var(--cap-radius-sm, 12px);
      background: var(--cap-surface-raised);
    }
    .cap-trail-head {
      display: flex;
      align-items: center;
      font-weight: 600;
      font-size: 0.84rem;
    }
    .cap-trail-path { font-family: var(--cap-mono, monospace); word-break: break-all; }
    .cap-trail-step {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 7px 0 0 10px;
      font-size: 0.78rem;
    }
    .cap-trail-arrow { color: var(--cap-muted); font-family: var(--cap-mono, monospace); }
    .cap-trail-via {
      font-size: 0.64rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      padding: 2px 8px;
      border-radius: 3px;
      border: 1px solid var(--cap-border);
      color: var(--cap-muted);
      white-space: nowrap;
    }
    .cap-trail-via.semantic {
      border-color: rgba(45, 212, 191, 0.6);
      color: rgb(45, 212, 191);
    }
    .cap-trail-target { font-family: var(--cap-mono, monospace); word-break: break-all; }
    .cap-trail-ripple {
      margin: 8px 0 0 28px;
      font-size: 0.72rem;
      color: var(--cap-muted);
      font-family: var(--cap-mono, monospace);
      word-break: break-all;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GraphTorusViewportComponent implements AfterViewInit, OnDestroy {
  @ViewChild("torusCanvas", { static: true })
  private canvasRef!: ElementRef<HTMLCanvasElement>;

  readonly store = inject(CapillaryStore);
  readonly hover = signal<HoverInfo | null>(null);
  readonly mode = signal<"surface" | "trail">("surface");

  private illo: Zdog.Illustration | null = null;
  private root: Zdog.Anchor | null = null;
  private placed: PlacedNode[] = [];
  private frameHandle = 0;
  private disposed = false;
  private ready = false;
  private resizeObserver?: ResizeObserver;

  private dragging = false;
  private dragYaw = 0;
  private dragPitch = 0.62;
  private zoomFactor = 1;
  private lastPointerX = 0;
  private lastPointerY = 0;

  constructor() {
    effect(() => {
      this.store.reviewGraph();
      if (this.ready) {
        this.buildScene();
      }
    });
  }

  readonly trail = computed<TrailRow[]>(() => buildTrail(this.store.reviewGraph()?.nodes ?? [], this.store.reviewGraph()?.edges ?? []));

  setMode(mode: "surface" | "trail"): void {
    this.mode.set(mode);
  }

  ngAfterViewInit(): void {
    const canvas = this.canvasRef.nativeElement;
    this.illo = new Zdog.Illustration({
      element: canvas,
      dragRotate: false,
      resize: false,
      zoom: this.zoomFactor,
    });

    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointerleave", this.onPointerLeave);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });

    this.resizeObserver = new ResizeObserver(() => this.onResize());
    this.resizeObserver.observe(canvas);
    this.onResize();

    this.buildScene();
    this.ready = true;
    this.animate();
  }

  ngOnDestroy(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frameHandle);
    this.resizeObserver?.disconnect();
    const canvas = this.canvasRef?.nativeElement;
    if (canvas) {
      canvas.removeEventListener("pointerdown", this.onPointerDown);
      canvas.removeEventListener("pointermove", this.onPointerMove);
      canvas.removeEventListener("pointerup", this.onPointerUp);
      canvas.removeEventListener("pointerleave", this.onPointerLeave);
      canvas.removeEventListener("wheel", this.onWheel);
    }
  }

  private onResize(): void {
    const canvas = this.canvasRef.nativeElement;
    const width = canvas.clientWidth || 640;
    const height = canvas.clientHeight || 360;
    this.illo?.setSize(width, height);
  }

  private buildScene(): void {
    if (!this.illo) {
      return;
    }
    // Rebuild from scratch: Zdog graphs are cheap to reconstruct and an
    // immutable-rebuild keeps this pure — no incremental mutation drift.
    // (children is real at runtime; the type defs just don't expose it.)
    (this.illo as unknown as { children: unknown[] }).children = [];
    this.root = new Zdog.Anchor({ addTo: this.illo });
    this.placed = [];

    buildCage(this.root);

    const graph = this.store.reviewGraph();
    if (!graph) {
      return;
    }

    const shapeByNodeId = new Map<string, GraphShapeSample>(
      (graph.shapeSamples ?? []).map((sample) => [sample.nodeId, sample]),
    );
    const fileNodes = graph.nodes.filter((node) => node.kind !== "symbol");
    const positionById = new Map<string, PlacedNode>();

    fileNodes.forEach((node, index) => {
      const sample = shapeByNodeId.get(node.id);
      const phi = sample?.phi ?? (index / Math.max(1, fileNodes.length)) * Zdog.TAU;
      const theta = sample?.theta ?? ((index % 24) / 24) * Zdog.TAU;
      const minor = TORUS_MINOR * (node.changed ? 1.08 : 1);
      const ring = TORUS_MAJOR + minor * Math.cos(theta);
      // Major circle in the x/z plane, tube height on y (screen-vertical
      // after the pitch tilt) — same surface, Zdog axes.
      const placedNode: PlacedNode = {
        node,
        x: SCALE * ring * Math.cos(phi),
        z: SCALE * ring * Math.sin(phi),
        y: -SCALE * minor * Math.sin(theta),
      };
      this.placed.push(placedNode);
      positionById.set(node.id, placedNode);

      new Zdog.Shape({
        addTo: this.root!,
        translate: { x: placedNode.x, y: placedNode.y, z: placedNode.z },
        stroke: node.changed ? 9 : 6,
        color: node.changed ? CHANGED_COLOR : WETTED_COLOR,
      });
    });

    let drawn = 0;
    for (const edge of graph.edges) {
      if (drawn >= MAX_DRAWN_EDGES) {
        break;
      }
      const color = EDGE_COLORS[edge.kind];
      if (!color) {
        continue;
      }
      const from = positionById.get(edge.fromNodeId);
      const to = positionById.get(edge.toNodeId);
      if (!from || !to) {
        continue;
      }
      new Zdog.Shape({
        addTo: this.root!,
        path: [
          { x: from.x, y: from.y, z: from.z },
          { x: to.x, y: to.y, z: to.z },
        ],
        closed: false,
        stroke: edge.kind === "semantic" ? 1.6 : 1,
        color,
      });
      drawn += 1;
    }
  }

  private animate = (): void => {
    if (this.disposed || !this.illo || !this.root) {
      return;
    }
    this.root.rotate.y = this.dragYaw;
    this.root.rotate.x = this.dragPitch;
    this.illo.zoom = this.zoomFactor;
    this.illo.updateRenderGraph();
    this.frameHandle = requestAnimationFrame(this.animate);
  };

  private onPointerDown = (event: PointerEvent): void => {
    this.dragging = true;
    this.lastPointerX = event.clientX;
    this.lastPointerY = event.clientY;
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (this.dragging) {
      this.dragYaw += (event.clientX - this.lastPointerX) * 0.008;
      this.dragPitch = clamp(this.dragPitch + (event.clientY - this.lastPointerY) * 0.008, -1.2, 1.2);
      this.lastPointerX = event.clientX;
      this.lastPointerY = event.clientY;
      this.hover.set(null);
      return;
    }
    this.updateHover(event);
  };

  private onPointerUp = (): void => {
    this.dragging = false;
  };

  private onPointerLeave = (): void => {
    this.dragging = false;
    this.hover.set(null);
  };

  private onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.zoomFactor = clamp(this.zoomFactor * (event.deltaY > 0 ? 0.92 : 1.08), 0.45, 2.4);
  };

  /**
   * Hit-test by projecting node positions with the same yaw/pitch the scene
   * uses — we own the math, so no renderer raycaster is needed.
   */
  private updateHover(event: PointerEvent): void {
    const canvas = this.canvasRef.nativeElement;
    const rect = canvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const cx = rect.width / 2;
    const cy = rect.height / 2;

    const cosY = Math.cos(this.dragYaw);
    const sinY = Math.sin(this.dragYaw);
    const cosX = Math.cos(this.dragPitch);
    const sinX = Math.sin(this.dragPitch);

    let best: { placed: PlacedNode; distance: number } | null = null;
    for (const placed of this.placed) {
      // Rotate about y (yaw), then x (pitch) — matches Zdog anchor order.
      const x1 = placed.x * cosY + placed.z * sinY;
      const z1 = -placed.x * sinY + placed.z * cosY;
      const y1 = placed.y * cosX - z1 * sinX;
      const sx = cx + x1 * this.zoomFactor;
      const sy = cy + y1 * this.zoomFactor;
      const distance = Math.hypot(sx - px, sy - py);
      if (distance < 12 && (!best || distance < best.distance)) {
        best = { placed, distance };
      }
    }

    if (!best) {
      this.hover.set(null);
      return;
    }
    this.hover.set({
      name: best.placed.node.name,
      path: best.placed.node.path,
      kind: best.placed.node.kind,
      changed: best.placed.node.changed,
      x: px,
      y: py,
    });
  }
}

// --- pure helpers ------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Quiet wireframe: meridian rings around the tube plus equator latitudes. */
function buildCage(root: Zdog.Anchor): void {
  const meridians = 16;
  for (let k = 0; k < meridians; k += 1) {
    const phi = (k / meridians) * Zdog.TAU;
    new Zdog.Ellipse({
      addTo: root,
      diameter: 2 * SCALE * TORUS_MINOR,
      translate: { x: SCALE * TORUS_MAJOR * Math.cos(phi), z: SCALE * TORUS_MAJOR * Math.sin(phi), y: 0 },
      rotate: { y: -phi },
      stroke: 1,
      color: CAGE_COLOR,
    });
  }
  for (const [radius, y] of [
    [TORUS_MAJOR + TORUS_MINOR, 0],
    [TORUS_MAJOR - TORUS_MINOR, 0],
    [TORUS_MAJOR, -TORUS_MINOR],
    [TORUS_MAJOR, TORUS_MINOR],
  ] as const) {
    new Zdog.Ellipse({
      addTo: root,
      diameter: 2 * SCALE * radius,
      rotate: { x: Zdog.TAU / 4 },
      translate: { y: SCALE * y },
      stroke: 1,
      color: CAGE_COLOR,
    });
  }
}

const EDGE_LABELS: Record<string, string> = {
  semantic: "meaning",
  imports: "imports",
  changed_with: "co-changed",
  tests: "tests",
  calls: "calls",
};

/**
 * The change trail: for every changed file, what it touches directly (with
 * how), and the second-degree ripple beyond that. Derived purely from the
 * graph snapshot the review already computed.
 */
function buildTrail(nodes: GraphNode[], edges: GraphEdge[]): TrailRow[] {
  const fileNodes = nodes.filter((node) => node.kind !== "symbol");
  const byId = new Map(fileNodes.map((node) => [node.id, node]));
  const adjacency = new Map<string, { node: GraphNode; kind: string }[]>();

  for (const edge of edges) {
    if (edge.kind === "owns") {
      continue;
    }
    const from = byId.get(edge.fromNodeId);
    const to = byId.get(edge.toNodeId);
    if (!from || !to) {
      continue;
    }
    const forward = adjacency.get(from.id) ?? [];
    forward.push({ node: to, kind: edge.kind });
    adjacency.set(from.id, forward);
    const backward = adjacency.get(to.id) ?? [];
    backward.push({ node: from, kind: edge.kind });
    adjacency.set(to.id, backward);
  }

  return fileNodes
    .filter((node) => node.changed)
    .map((node) => {
      const seen = new Set<string>([node.id]);
      const direct: TrailStep[] = [];
      for (const neighbor of adjacency.get(node.id) ?? []) {
        if (seen.has(neighbor.node.id)) {
          continue;
        }
        seen.add(neighbor.node.id);
        direct.push({
          path: neighbor.node.path,
          kind: neighbor.node.kind,
          changed: neighbor.node.changed,
          via: EDGE_LABELS[neighbor.kind] ?? neighbor.kind,
        });
      }

      const ripple: string[] = [];
      for (const step of direct) {
        const stepNode = fileNodes.find((candidate) => candidate.path === step.path);
        for (const second of adjacency.get(stepNode?.id ?? "") ?? []) {
          if (seen.has(second.node.id)) {
            continue;
          }
          seen.add(second.node.id);
          ripple.push(second.node.path);
        }
      }

      return {
        path: node.path,
        direct: direct.sort((a, b) => Number(b.changed) - Number(a.changed)),
        rippleCount: ripple.length,
        ripplePreview: ripple.slice(0, 4),
      };
    })
    .sort((a, b) => b.direct.length - a.direct.length);
}
