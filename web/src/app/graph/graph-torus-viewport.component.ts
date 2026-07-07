// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  effect,
  inject,
  signal,
} from "@angular/core";
import { CommonModule } from "@angular/common";
import * as THREE from "three";
import { CapillaryStore } from "../state/capillary.store";
import { GraphNode, GraphShapeSample } from "../models";

// Radii mirror the API's TORUS_RADIUS_MAJOR/MINOR so sample angles land on
// the drawn surface. Convention (house style, as in emet-torus / kujua):
// phi = major (toroidal) angle, theta = minor (poloidal) angle.
const TORUS_MAJOR = 2.4;
const TORUS_MINOR = 0.8;
const CHANGED_COLOR = new THREE.Color("#ffd400");
const WETTED_COLOR = new THREE.Color("#f2f2f2");
const MIN_DISTANCE = 4;
const MAX_DISTANCE = 13;

interface HoverInfo {
  readonly name: string;
  readonly path: string;
  readonly kind: string;
  readonly changed: boolean;
  readonly x: number;
  readonly y: number;
}

@Component({
  selector: "app-graph-torus-viewport",
  standalone: true,
  imports: [CommonModule],
  template: `
    <section>
      <header class="cap-panel-title">
        <span>3Tor Program Shape</span>
        <span class="cap-muted">DAG diff // wetting // T³ projection</span>
      </header>
      <div class="cap-panel-body">
        <div class="cap-torus-stage">
          <canvas
            #torusCanvas
            class="cap-torus-canvas"
            aria-label="Interactive 3D Capillary graph torus view"></canvas>
          @if (hover(); as info) {
            <div
              class="cap-torus-tooltip"
              [class.changed]="info.changed"
              [style.left.px]="info.x"
              [style.top.px]="info.y">
              <span class="cap-torus-tooltip-name">{{ info.name }}</span>
              <span class="cap-torus-tooltip-path">{{ info.path }}</span>
              <span class="cap-torus-tooltip-kind">{{ info.kind }}{{ info.changed ? ' · changed' : ' · wetted' }}</span>
            </div>
          }
          <div class="cap-torus-legend">
            <span><i class="dot changed"></i>changed</span>
            <span><i class="dot wetted"></i>wetted</span>
            <span class="cap-muted">scroll = zoom · drag = orbit · hover = file</span>
          </div>
        </div>
      </div>
    </section>
  `,
  styles: [`
    .cap-torus-stage { position: relative; }
    .cap-torus-canvas {
      width: 100%;
      height: 360px;
      display: block;
      border: 1px solid var(--cap-border);
      border-radius: var(--cap-radius-sm, 12px);
      background: radial-gradient(120% 120% at 50% 20%, #0c1a28 0%, #050b12 70%);
      cursor: grab;
      touch-action: none;
    }
    .cap-torus-tooltip {
      position: absolute;
      transform: translate(-50%, calc(-100% - 12px));
      pointer-events: none;
      display: grid;
      gap: 1px;
      padding: 7px 9px;
      min-width: 120px;
      max-width: 260px;
      border-radius: 9px;
      border: 1px solid rgba(242, 242, 242, 0.18);
      background: rgba(8, 16, 24, 0.94);
      box-shadow: 0 10px 26px rgba(0, 0, 0, 0.55);
      z-index: 6;
    }
    .cap-torus-tooltip.changed { border-color: rgba(255, 212, 0, 0.55); }
    .cap-torus-tooltip-name {
      font-size: 12px;
      font-weight: 700;
      color: #f2f2f2;
      word-break: break-all;
    }
    .cap-torus-tooltip-path {
      font-size: 10.5px;
      color: #9fb6c8;
      word-break: break-all;
    }
    .cap-torus-tooltip-kind {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #6f8aa0;
    }
    .cap-torus-legend {
      position: absolute;
      left: 10px;
      bottom: 10px;
      display: flex;
      gap: 12px;
      align-items: center;
      font-size: 11px;
      color: #cdd9e3;
      pointer-events: none;
    }
    .cap-torus-legend span { display: inline-flex; align-items: center; gap: 5px; }
    .cap-torus-legend .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
    .cap-torus-legend .dot.changed { background: #ffd400; box-shadow: 0 0 6px #ffd400; }
    .cap-torus-legend .dot.wetted { background: #f2f2f2; box-shadow: 0 0 6px rgba(242, 242, 242, 0.7); }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GraphTorusViewportComponent implements AfterViewInit, OnDestroy {
  @ViewChild("torusCanvas", { static: true })
  private canvasRef!: ElementRef<HTMLCanvasElement>;

  readonly store = inject(CapillaryStore);
  readonly hover = signal<HoverInfo | null>(null);

  private renderer?: THREE.WebGLRenderer;
  private scene?: THREE.Scene;
  private camera?: THREE.PerspectiveCamera;
  private spin?: THREE.Group;
  private graphGroup?: THREE.Group;
  private nodePoints?: THREE.Points;
  private nodeMeta: GraphNode[] = [];
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private resizeObserver?: ResizeObserver;
  private frameHandle = 0;
  private ready = false;
  private disposed = false;

  private dragYaw = 0;
  private dragPitch = 0.62;
  private dragging = false;
  private cameraDistance = 7.4;
  private lastPointerX = 0;
  private lastPointerY = 0;
  private pendingPointer: { x: number; y: number } | null = null;

  constructor() {
    effect(() => {
      this.store.reviewGraph();
      this.store.findings();
      if (this.ready) {
        this.buildGraphObjects();
      }
    });
  }

  ngAfterViewInit(): void {
    this.initThree();
    this.buildGraphObjects();
    this.ready = true;
    this.animate();
  }

  ngOnDestroy(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frameHandle);
    this.resizeObserver?.disconnect();
    this.disposeGraphObjects();
    this.renderer?.dispose();
    const canvas = this.canvasRef?.nativeElement;
    if (canvas) {
      canvas.removeEventListener("pointerdown", this.onPointerDown);
      canvas.removeEventListener("pointermove", this.onPointerMove);
      canvas.removeEventListener("pointerup", this.onPointerUp);
      canvas.removeEventListener("pointerleave", this.onPointerLeave);
      canvas.removeEventListener("wheel", this.onWheel);
    }
  }

  private initThree(): void {
    const canvas = this.canvasRef.nativeElement;
    const width = canvas.clientWidth || 640;
    const height = canvas.clientHeight || 360;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height, false);

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(48, width / height, 0.1, 100);
    this.camera.position.set(0, 0, this.cameraDistance);
    this.camera.lookAt(0, 0, 0);

    this.raycaster.params.Points = { threshold: 0.12 };

    this.spin = new THREE.Group();
    this.scene.add(this.spin);

    const ambient = new THREE.AmbientLight(0x9fc4e0, 0.9);
    const key = new THREE.DirectionalLight(0xffffff, 0.6);
    key.position.set(3, 4, 5);
    this.scene.add(ambient, key);

    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointerleave", this.onPointerLeave);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });

    this.resizeObserver = new ResizeObserver(() => this.onResize());
    this.resizeObserver.observe(canvas);
  }

  private buildGraphObjects(): void {
    if (!this.scene || !this.spin) {
      return;
    }

    this.disposeGraphObjects();
    const group = new THREE.Group();

    // Reference torus surface as a clean ring wireframe (no triangulated faces).
    group.add(buildTorusCage());

    const graph = this.store.reviewGraph();
    const shapeByNodeId = new Map<string, GraphShapeSample>(
      (graph?.shapeSamples ?? []).map((sample) => [sample.nodeId, sample]),
    );

    const nodes: GraphNode[] = graph?.nodes?.slice(0, 420) ?? this.fallbackNodes();
    const edges = graph?.edges?.slice(0, 1100) ?? [];
    const positions = new Map<string, THREE.Vector3>();
    this.nodeMeta = [];

    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      positions.set(node.id, torusPosition(node, shapeByNodeId.get(node.id), index, nodes.length));
    }

    // Edges as depth-aware line segments.
    const edgePoints: number[] = [];
    for (const edge of edges) {
      const from = positions.get(edge.fromNodeId);
      const to = positions.get(edge.toNodeId);
      if (!from || !to) {
        continue;
      }
      edgePoints.push(from.x, from.y, from.z, to.x, to.y, to.z);
    }
    if (edgePoints.length > 0) {
      const edgeGeometry = new THREE.BufferGeometry();
      edgeGeometry.setAttribute("position", new THREE.Float32BufferAttribute(edgePoints, 3));
      const edgeMaterial = new THREE.LineBasicMaterial({
        color: 0xf2f2f2,
        transparent: true,
        opacity: 0.14,
      });
      group.add(new THREE.LineSegments(edgeGeometry, edgeMaterial));
    }

    // Nodes as colored points; size encodes risk gradient.
    const nodePositions: number[] = [];
    const nodeColors: number[] = [];
    const nodeSizes: number[] = [];
    for (const node of nodes) {
      const position = positions.get(node.id);
      if (!position) {
        continue;
      }
      const shape = shapeByNodeId.get(node.id);
      const risk = shape ? Math.min(1.5, Math.max(0, shape.riskGradient)) : 0;
      const color = node.changed ? CHANGED_COLOR : WETTED_COLOR;
      nodePositions.push(position.x, position.y, position.z);
      nodeColors.push(color.r, color.g, color.b);
      nodeSizes.push((node.changed ? 0.16 : 0.1) + risk * 0.09);
      this.nodeMeta.push(node);
    }

    this.nodePoints = undefined;
    if (nodePositions.length > 0) {
      const nodeGeometry = new THREE.BufferGeometry();
      nodeGeometry.setAttribute("position", new THREE.Float32BufferAttribute(nodePositions, 3));
      nodeGeometry.setAttribute("color", new THREE.Float32BufferAttribute(nodeColors, 3));
      nodeGeometry.setAttribute("aSize", new THREE.Float32BufferAttribute(nodeSizes, 1));
      const points = new THREE.Points(nodeGeometry, createNodeMaterial());
      this.nodePoints = points;
      group.add(points);
    }

    this.graphGroup = group;
    this.spin.add(group);
  }

  private fallbackNodes(): GraphNode[] {
    const count = Math.max(6, this.store.findings().length || 8);
    return Array.from({ length: count }, (_, index) => ({
      id: `seed-${index}`,
      name: `seed-${index}.ts`,
      path: `src/seed/seed-${index}.ts`,
      kind: "file" as const,
      changed: index % 2 === 0,
      weight: 1,
    }));
  }

  private disposeGraphObjects(): void {
    if (!this.graphGroup) {
      return;
    }
    this.spin?.remove(this.graphGroup);
    this.graphGroup.traverse((object) => {
      const mesh = object as THREE.Mesh & { geometry?: THREE.BufferGeometry; material?: THREE.Material };
      mesh.geometry?.dispose?.();
      const material = mesh.material;
      if (Array.isArray(material)) {
        material.forEach((entry) => entry.dispose());
      } else {
        material?.dispose?.();
      }
    });
    this.graphGroup = undefined;
  }

  private animate = (): void => {
    if (this.disposed || !this.renderer || !this.scene || !this.camera || !this.spin) {
      return;
    }
    this.spin.rotation.y = this.dragYaw;
    this.spin.rotation.x = this.dragPitch;
    this.camera.position.z += (this.cameraDistance - this.camera.position.z) * 0.18;
    this.updateHover();
    this.renderer.render(this.scene, this.camera);
    this.frameHandle = requestAnimationFrame(this.animate);
  };

  private updateHover(): void {
    if (!this.camera || !this.nodePoints || this.dragging || !this.pendingPointer) {
      return;
    }
    const canvas = this.canvasRef.nativeElement;
    const rect = canvas.getBoundingClientRect();
    this.pointer.x = ((this.pendingPointer.x - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((this.pendingPointer.y - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObject(this.nodePoints, false);
    const index = hits.length > 0 ? hits[0].index ?? -1 : -1;
    if (index < 0 || index >= this.nodeMeta.length) {
      if (this.hover() !== null) {
        this.hover.set(null);
      }
      return;
    }
    const node = this.nodeMeta[index];
    this.hover.set({
      name: node.name || node.id,
      path: node.path || "",
      kind: node.kind,
      changed: node.changed,
      x: this.pendingPointer.x - rect.left,
      y: this.pendingPointer.y - rect.top,
    });
  }

  private onResize(): void {
    if (!this.renderer || !this.camera) {
      return;
    }
    const canvas = this.canvasRef.nativeElement;
    const width = canvas.clientWidth || 640;
    const height = canvas.clientHeight || 360;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private onPointerDown = (event: PointerEvent): void => {
    this.dragging = true;
    this.hover.set(null);
    this.lastPointerX = event.clientX;
    this.lastPointerY = event.clientY;
    this.canvasRef.nativeElement.style.cursor = "grabbing";
    this.canvasRef.nativeElement.setPointerCapture?.(event.pointerId);
  };

  private onPointerMove = (event: PointerEvent): void => {
    this.pendingPointer = { x: event.clientX, y: event.clientY };
    if (!this.dragging) {
      return;
    }
    const deltaX = event.clientX - this.lastPointerX;
    const deltaY = event.clientY - this.lastPointerY;
    this.lastPointerX = event.clientX;
    this.lastPointerY = event.clientY;
    this.dragYaw += deltaX * 0.008;
    this.dragPitch = clamp(this.dragPitch + deltaY * 0.008, -1.2, 1.2);
  };

  private onPointerUp = (): void => {
    if (!this.dragging) {
      return;
    }
    this.dragging = false;
    this.canvasRef.nativeElement.style.cursor = "grab";
  };

  private onPointerLeave = (): void => {
    this.dragging = false;
    this.pendingPointer = null;
    this.hover.set(null);
    this.canvasRef.nativeElement.style.cursor = "grab";
  };

  private onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const step = event.deltaY * 0.0016 * (this.cameraDistance * 0.5);
    this.cameraDistance = clamp(this.cameraDistance + step, MIN_DISTANCE, MAX_DISTANCE);
  };
}

function buildTorusCage(): THREE.LineSegments {
  const points: number[] = [];
  const tubeRings = 14;
  const tubeSteps = 60;
  const crossRings = 24;
  const crossSteps = 30;

  // Longitudinal rings (sweep the major angle at a fixed minor angle).
  for (let i = 0; i < tubeRings; i += 1) {
    const theta = (i / tubeRings) * Math.PI * 2;
    for (let j = 0; j < tubeSteps; j += 1) {
      pushCagePoint(points, (j / tubeSteps) * Math.PI * 2, theta);
      pushCagePoint(points, ((j + 1) / tubeSteps) * Math.PI * 2, theta);
    }
  }

  // Cross-sectional rings (sweep the minor angle at a fixed major angle).
  for (let i = 0; i < crossRings; i += 1) {
    const phi = (i / crossRings) * Math.PI * 2;
    for (let j = 0; j < crossSteps; j += 1) {
      pushCagePoint(points, phi, (j / crossSteps) * Math.PI * 2);
      pushCagePoint(points, phi, ((j + 1) / crossSteps) * Math.PI * 2);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
  const material = new THREE.LineBasicMaterial({
    color: 0xffd400,
    transparent: true,
    opacity: 0.1,
  });
  return new THREE.LineSegments(geometry, material);
}

function pushCagePoint(target: number[], phi: number, theta: number): void {
  const ring = TORUS_MAJOR + TORUS_MINOR * Math.cos(theta);
  target.push(ring * Math.cos(phi), ring * Math.sin(phi), TORUS_MINOR * Math.sin(theta));
}

function torusPosition(
  node: GraphNode,
  shape: GraphShapeSample | undefined,
  index: number,
  total: number,
): THREE.Vector3 {
  const phi = shape?.phi ?? (index / Math.max(1, total)) * Math.PI * 2;
  const theta = shape?.theta ?? ((index % 24) / 24) * Math.PI * 2;
  const swell = node.changed ? 1.08 : 1;
  const minor = TORUS_MINOR * swell;
  const ring = TORUS_MAJOR + minor * Math.cos(theta);
  return new THREE.Vector3(
    ring * Math.cos(phi),
    ring * Math.sin(phi),
    minor * Math.sin(theta),
  );
}

function createNodeMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    vertexColors: true,
    uniforms: {
      uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
    },
    vertexShader: `
      attribute float aSize;
      varying vec3 vColor;
      uniform float uPixelRatio;
      void main() {
        vColor = color;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * 320.0 * uPixelRatio / -mvPosition.z;
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      void main() {
        float d = distance(gl_PointCoord, vec2(0.5));
        if (d > 0.5) {
          discard;
        }
        float glow = smoothstep(0.5, 0.0, d);
        gl_FragColor = vec4(vColor, glow);
      }
    `,
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
