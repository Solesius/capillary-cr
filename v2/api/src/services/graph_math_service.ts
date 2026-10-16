// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Khalil Warren — capillary
// graph_math_service.ts — real differential geometry on the T² program torus.
//
// Convention (house style, matches the emet-torus / kujua renderers):
//   phi   — major (toroidal) angle around the main ring. Node identity:
//           hash-placed so coverage is even and stable across runs.
//   theta — minor (poloidal) angle around the tube. Disturbance axis:
//           theta = 0 is the outer equator (positive Gaussian curvature),
//           |theta| = pi is the inner rim (negative curvature — the saddle
//           region where disturbed, high-interop nodes migrate).
//
// Node metrics are the actual differential geometry of the embedded torus
// (major radius R, minor radius r):
//   principal curvatures   k1(theta) = cos(theta) / (R + r*cos(theta))   [toroidal]
//                          k2       = 1 / r                              [poloidal]
//   normal curvature       k_n(alpha) = k1*cos²(alpha) + k2*sin²(alpha)  [Euler]
//   geodesic torsion       tau_g(alpha) = (k2 - k1)*sin(alpha)*cos(alpha)
// where alpha is the tangent direction of the node's data flow on the
// surface: alpha = 0 rides the toroidal direction (balanced through-flow),
// alpha = pi/2 twists poloidally (fan-in/fan-out dominated). A disturbed
// node with mixed flow direction sits on the inner-rim saddle at the
// diagonal — exactly where geodesic torsion peaks: fragile interop.

export const TORUS_RADIUS_MAJOR = 2.4;
export const TORUS_RADIUS_MINOR = 0.8;

const K2 = 1 / TORUS_RADIUS_MINOR;
const K1_MIN = -1 / (TORUS_RADIUS_MAJOR - TORUS_RADIUS_MINOR);
const MAX_NORMAL_CURVATURE = Math.max(Math.abs(K1_MIN), K2);
const MAX_GEODESIC_TORSION = (K2 - K1_MIN) / 2;

export class GraphMathService {
  /** Major angle from a stable path hash in [0,1): even, run-stable placement. */
  calculatePhi(pathHash: number): number {
    return this.#clamp(pathHash, 0, 1) * 2 * Math.PI;
  }

  /**
   * Minor angle from disturbance in [0,1]: quiet nodes rest on the outer
   * equator, disturbed nodes migrate to the inner rim. Hemisphere (+/-1)
   * mirrors placement so both halves of the tube are used.
   */
  calculateTheta(disturbance: number, hemisphere: number): number {
    const d = this.#clamp(disturbance, 0, 1);
    const sign = hemisphere < 0 ? -1 : 1;
    return sign * d * Math.PI;
  }

  /**
   * Tangent direction of the node's flow on the surface, in [0, pi/2].
   * Balanced through-flow rides the toroidal direction; directional
   * imbalance and tight coupling twist the flow poloidally.
   */
  calculateFlowAngle(directionalImbalance: number, coupling: number): number {
    const imbalance = this.#clamp(directionalImbalance, 0, 1);
    const c = this.#clamp(coupling, 0, 1);
    return (Math.PI / 2) * this.#clamp(imbalance * 0.6 + c * 0.4, 0, 1);
  }

  /** Normalized magnitude of the Euler normal curvature k_n(alpha) in [0,1]. */
  calculateCurvature(theta: number, alpha: number): number {
    const k1 = this.#principalToroidal(theta);
    const cosA = Math.cos(alpha);
    const sinA = Math.sin(alpha);
    const normalCurvature = k1 * cosA * cosA + K2 * sinA * sinA;
    return this.#clamp(Math.abs(normalCurvature) / MAX_NORMAL_CURVATURE, 0, 1);
  }

  /** Normalized magnitude of the geodesic torsion tau_g(alpha) in [0,1]. */
  calculateTorsion(theta: number, alpha: number): number {
    const k1 = this.#principalToroidal(theta);
    const geodesicTorsion = (K2 - k1) * Math.sin(alpha) * Math.cos(alpha);
    return this.#clamp(Math.abs(geodesicTorsion) / MAX_GEODESIC_TORSION, 0, 1);
  }

  /**
   * Local shape risk from the surface geometry alone. Global run signals
   * (flow completeness, torus variance) belong at the risk-surface level —
   * they shift every node identically and would only wash out ranking here.
   */
  calculateRiskGradient(curvature: number, torsion: number): number {
    const c = this.#clamp(curvature, 0, 1);
    const t = this.#clamp(torsion, 0, 1);
    return this.#clamp(c * 0.55 + t * 0.45, 0, 1);
  }

  #principalToroidal(theta: number): number {
    const cosT = Math.cos(theta);
    return cosT / (TORUS_RADIUS_MAJOR + TORUS_RADIUS_MINOR * cosT);
  }

  #clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) {
      return min;
    }
    return Math.min(max, Math.max(min, value));
  }
}
