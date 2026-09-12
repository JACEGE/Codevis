// d3-force-3d simulation in a Web Worker.
// Main thread sends node IDs + initial positions + links; we run the full
// simulation here and post back position buffers as Float32Array (transferred,
// not copied). Frees the main thread for rendering + React work.

import {
  forceSimulation,
  forceManyBody,
  forceLink,
  forceCenter,
  forceCollide,
  forceX,
  forceY,
  forceZ,
} from 'd3-force-3d';

let sim = null;
let nodes = [];

function postPositions() {
  if (!sim || nodes.length === 0) return;
  const buf = new Float32Array(nodes.length * 3);
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    buf[i * 3] = n.x ?? 0;
    buf[i * 3 + 1] = n.y ?? 0;
    buf[i * 3 + 2] = n.z ?? 0;
  }
  self.postMessage({ type: 'positions', buffer: buf.buffer }, [buf.buffer]);
}

self.onmessage = (e) => {
  const m = e.data;

  if (m.type === 'init') {
    if (sim) sim.stop();

    // Build internal node list with initial positions (or zeros).
    nodes = m.nodes.map((n) => ({
      id: n.id,
      x: n.x ?? 0,
      y: n.y ?? 0,
      z: n.z ?? 0,
    }));

    // Map IDs → index for link rewriting.
    const idx = new Map(nodes.map((n, i) => [n.id, i]));
    const links = [];
    for (const l of m.links) {
      const s = idx.get(l.source);
      const t = idx.get(l.target);
      if (s != null && t != null) links.push({ source: s, target: t });
    }

    // dimensions: 2 in der 2D-Ansicht (sonst wird eine 3D-Kugel auf x/y projiziert
    // und überlappt zu einem Klump), 3 in der 3D-Ansicht.
    sim = forceSimulation(nodes, m.dimensions ?? 3)
      // distanceMax caps the repulsion's reach: disconnected components stop
      // pushing each other once they are ~800 apart instead of drifting to
      // infinity (which blew up the bounding box and broke camera framing).
      .force('charge', forceManyBody().strength(m.charge ?? -80).distanceMax(m.chargeDistanceMax ?? 800))
      .force(
        'link',
        forceLink(links)
          .id((_, i) => i)
          .distance(m.distance ?? 30)
          // Schwächere Links lassen dicht verknüpfte Kerne aufgehen statt zur
          // Kugel kollabieren; Cluster-Struktur bleibt dennoch sichtbar.
          .strength(m.linkStrength ?? 0.2),
      )
      .force('center', forceCenter(0, 0, 0))
      // Weak gravity toward the origin keeps link-less nodes (common on the
      // architecture level, where CONTAINS edges are hidden) in a compact
      // shell around the connected core instead of repelling into the void.
      .force('gravityX', forceX(0).strength(m.gravity ?? 0.14))
      .force('gravityY', forceY(0).strength(m.gravity ?? 0.14))
      .force('gravityZ', forceZ(0).strength(m.gravity ?? 0.14))
      // Kollision: hält Knoten auf Abstand → kein Überlappen/Pile-up, der Graph
      // wird lesbar statt zur dichten Kugel zu verschmelzen.
      .force('collide', forceCollide(m.collideRadius ?? 12).strength(0.9).iterations(2))
      .alphaDecay(m.alphaDecay ?? 0.02)
      .velocityDecay(m.velocityDecay ?? 0.3)
      .on('tick', postPositions);


    // When the simulation converges, post final positions so the frontend can
    // persist them (layoutX/layoutY/layoutZ) and skip the simulation next time.
    sim.on('end', () => {
      const finalPositions = nodes.map((n) => ({ id: n.id, x: n.x ?? 0, y: n.y ?? 0, z: n.z ?? 0 }));
      self.postMessage({ type: 'layout-settled', nodes: finalPositions });
    });

    // Push initial positions immediately so the renderer has something.
    postPositions();
    if (m.paused) sim.stop();
    return;
  }

  if (m.type === 'pause') {
    sim?.stop();
    return;
  }

  if (m.type === 'resume') {
    // Preserve alpha and velocity: returning to a tab must not reheat layout.
    if (sim && sim.alpha() >= sim.alphaMin()) sim.restart();
    return;
  }

  if (m.type === 'force-params' && sim) {
    if (m.charge != null) sim.force('charge').strength(m.charge);
    if (m.distance != null) sim.force('link').distance(m.distance);
    sim.alpha(1).restart();
    return;
  }

  if (m.type === 'reheat' && sim) {
    sim.alpha(1).restart();
    return;
  }

  if (m.type === 'stop') {
    if (sim) sim.stop();
    sim = null;
    nodes = [];
    return;
  }
};
