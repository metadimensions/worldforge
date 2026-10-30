"use client";

import { Edges, Html, Line, OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";

import { headingToYaw, toScene, toSceneLength } from "@/lib/coords";
import { robotPoseAt, trackPositionAt, type Pose } from "@/lib/playback";
import type { Obstacle, Replay } from "@/lib/replay";

export type CameraMode = "overview" | "follow" | "collision";

type Vec3 = [number, number, number];

const RACK_HEIGHT = 1.5;
const PILLAR_HEIGHT = 1.5;
const WALL_HEIGHT = 0.6;
const WALL_THICKNESS = 0.08;
const MOVER_HEIGHT = 0.5;
const ROBOT_HEIGHT = 0.22;
export const FLASH_WINDOW = 0.6;
const CAMERA_EASE_SECONDS = 0.9;

export const COLORS = {
  floor: "#d9d6cf",
  wall: "#5b6070",
  rack: "#56657d",
  rackTop: "#e0a43a",
  mover: "#e67e22",
  robot: "#1f2a3c",
  robotHit: "#e0242e",
  start: "#2fa05a",
  goal: "#c8323c",
  unreachable: "#8b3fd6",
  plan: "#4a78dc",
  trail: "#14aabe",
  collision: "#ff2a2a",
};

interface SceneProps {
  replay: Replay;
  time: number;
  cameraMode: CameraMode;
  resetKey: number;
}

function highlights(replay: Replay, time: number): Map<string, string> {
  const out = new Map<string, string>();
  const { collision, diagnostics } = replay.result;
  if (collision && time >= collision.t - FLASH_WINDOW) out.set(collision.obstacle_id, COLORS.collision);
  for (const id of diagnostics?.blocking_obstacle_ids ?? []) out.set(id, COLORS.unreachable);
  return out;
}

export default function WarehouseScene(props: SceneProps) {
  const { scenario } = props.replay;
  const w = toSceneLength(scenario.width);
  const d = toSceneLength(scenario.height);
  return (
    <Canvas shadows camera={{ fov: 45, near: 0.05, far: 200, position: overviewPose(props.replay).position }}>
      <color attach="background" args={["#eef0f3"]} />
      <hemisphereLight args={["#ffffff", "#b0a898", 0.9]} />
      <directionalLight
        position={[w * 0.2, 9, d * 0.2]}
        intensity={1.6}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-w}
        shadow-camera-right={w}
        shadow-camera-top={d}
        shadow-camera-bottom={-d}
      />
      <SceneContents {...props} />
    </Canvas>
  );
}

function SceneContents({ replay, time, cameraMode, resetKey }: SceneProps) {
  const { scenario, result, moving_obstacle_tracks: tracks } = replay;
  const pose = robotPoseAt(result.trajectory, time);
  const lit = highlights(replay, time);
  const noPath = result.outcome === "no_path";

  return (
    <>
      <Floor width={scenario.width} height={scenario.height} />
      <PerimeterWalls width={scenario.width} height={scenario.height} />
      {scenario.static_obstacles.map((o) => (
        <StaticObstacle key={o.id} obstacle={o} highlight={lit.get(o.id)} />
      ))}
      {tracks.map((tr) => {
        const p = trackPositionAt(tr.samples, time);
        return (
          <ObstacleBody
            key={tr.id}
            obstacle={{ ...tr, x: p.x, y: p.y }}
            height={MOVER_HEIGHT}
            color={COLORS.mover}
            highlight={lit.get(tr.id)}
          />
        );
      })}
      <StartMarker x={result.start[0]} y={result.start[1]} />
      <GoalMarker x={result.goal[0]} y={result.goal[1]} tolerance={scenario.goal_tolerance} unreachable={noPath} />
      {noPath ? <NoRouteIndicator from={result.start} to={result.goal} /> : <PlannedPath points={result.planned_path} />}
      <Trail replay={replay} pose={pose} />
      <Robot replay={replay} pose={pose} time={time} />
      {result.collision && time >= result.collision.t && (
        <CollisionMarker
          x={result.collision.x}
          y={result.collision.y}
          t={result.collision.t}
          radius={scenario.robot_radius}
        />
      )}
      <CameraRig replay={replay} pose={pose} mode={cameraMode} resetKey={resetKey} />
    </>
  );
}

function Floor({ width, height }: { width: number; height: number }) {
  const [cx, , cz] = toScene(width / 2, height / 2);
  const w = toSceneLength(width);
  const d = toSceneLength(height);
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} position={[cx, 0, cz]} receiveShadow>
        <planeGeometry args={[w, d]} />
        <meshStandardMaterial color={COLORS.floor} />
      </mesh>
      <gridHelper
        args={[Math.max(w, d), Math.round(Math.max(w, d) / 0.5), "#bdb8ae", "#c9c4ba"]}
        position={[cx, 0.002, cz]}
        scale={[w / Math.max(w, d), 1, d / Math.max(w, d)]}
      />
    </group>
  );
}

function PerimeterWalls({ width, height }: { width: number; height: number }) {
  const w = toSceneLength(width);
  const d = toSceneLength(height);
  const t = WALL_THICKNESS;
  const walls: { pos: Vec3; size: Vec3 }[] = [
    { pos: [w / 2, WALL_HEIGHT / 2, t / 2], size: [w + 2 * t, WALL_HEIGHT, t] },
    { pos: [w / 2, WALL_HEIGHT / 2, -d - t / 2], size: [w + 2 * t, WALL_HEIGHT, t] },
    { pos: [-t / 2, WALL_HEIGHT / 2, -d / 2], size: [t, WALL_HEIGHT, d] },
    { pos: [w + t / 2, WALL_HEIGHT / 2, -d / 2], size: [t, WALL_HEIGHT, d] },
  ];
  return (
    <group>
      {walls.map((wall, i) => (
        <mesh key={i} position={wall.pos} castShadow receiveShadow>
          <boxGeometry args={wall.size} />
          <meshStandardMaterial color={COLORS.wall} />
        </mesh>
      ))}
    </group>
  );
}

type ShapeLike = Pick<Obstacle, "kind" | "x" | "y" | "width" | "height" | "radius">;

function ObstacleBody({ obstacle, height, color, highlight }: { obstacle: ShapeLike; height: number; color: string; highlight?: string }) {
  const pos = toScene(obstacle.x, obstacle.y, height / 2);
  const material = (
    <meshStandardMaterial
      color={highlight ? new THREE.Color(color).lerp(new THREE.Color(highlight), 0.45) : color}
      emissive={highlight ?? "#000000"}
      emissiveIntensity={highlight ? 0.35 : 0}
    />
  );
  const outline = highlight ? <Edges color={highlight} lineWidth={3} scale={1.04} /> : null;
  if (obstacle.kind === "circle") {
    const r = toSceneLength(obstacle.radius);
    return (
      <mesh position={pos} castShadow receiveShadow>
        <cylinderGeometry args={[r, r, height, 40]} />
        {material}
        {outline}
      </mesh>
    );
  }
  return (
    <mesh position={pos} castShadow receiveShadow>
      <boxGeometry args={[toSceneLength(obstacle.width), height, toSceneLength(obstacle.height)]} />
      {material}
      {outline}
    </mesh>
  );
}

function StaticObstacle({ obstacle, highlight }: { obstacle: Obstacle; highlight?: string }) {
  if (obstacle.kind === "circle") {
    return <ObstacleBody obstacle={obstacle} height={PILLAR_HEIGHT} color={COLORS.rack} highlight={highlight} />;
  }
  const w = toSceneLength(obstacle.width);
  const d = toSceneLength(obstacle.height);
  const [x, , z] = toScene(obstacle.x, obstacle.y);
  const shelves = [0.5, 1.0, RACK_HEIGHT];
  return (
    <group>
      <ObstacleBody obstacle={obstacle} height={RACK_HEIGHT} color={COLORS.rack} highlight={highlight} />
      {shelves.map((h) => (
        <mesh key={h} position={[x, h, z]}>
          <boxGeometry args={[w + 0.02, 0.04, d + 0.02]} />
          <meshStandardMaterial color={highlight ?? COLORS.rackTop} />
        </mesh>
      ))}
    </group>
  );
}

function StartMarker({ x, y }: { x: number; y: number }) {
  return (
    <mesh position={toScene(x, y, 0.01)} rotation-x={-Math.PI / 2}>
      <circleGeometry args={[0.12, 32]} />
      <meshStandardMaterial color={COLORS.start} />
    </mesh>
  );
}

function GoalMarker({ x, y, tolerance, unreachable }: { x: number; y: number; tolerance: number; unreachable: boolean }) {
  const r = Math.max(toSceneLength(tolerance), 0.06);
  const [gx, , gz] = toScene(x, y);
  const color = unreachable ? COLORS.unreachable : COLORS.goal;
  return (
    <group position={[gx, 0, gz]}>
      <mesh position={[0, 0.012, 0]} rotation-x={-Math.PI / 2}>
        <ringGeometry args={unreachable ? [0.16, 0.24, 40] : [r, r + 0.04, 40]} />
        <meshStandardMaterial color={color} emissive={unreachable ? color : "#000"} emissiveIntensity={0.4} />
      </mesh>
      <mesh position={[0, 0.5, 0]}>
        <cylinderGeometry args={[0.012, 0.012, 1, 8]} />
        <meshStandardMaterial color="#444" />
      </mesh>
      <mesh position={[0.11, 0.9, 0]}>
        <boxGeometry args={[0.2, 0.13, 0.01]} />
        <meshStandardMaterial color={color} side={THREE.DoubleSide} />
      </mesh>
      {unreachable && <SceneLabel position={[0, 1.15, 0]} tone="unreachable">Goal unreachable</SceneLabel>}
    </group>
  );
}

function PlannedPath({ points }: { points: [number, number][] }) {
  const pts = useMemo(() => points.map(([x, y]) => toScene(x, y, 0.02)), [points]);
  if (pts.length < 2) return null;
  return <Line points={pts} color={COLORS.plan} lineWidth={2} dashed dashSize={0.1} gapSize={0.07} />;
}

function NoRouteIndicator({ from, to }: { from: [number, number]; to: [number, number] }) {
  const a = toScene(from[0], from[1], 0.02);
  const b = toScene(to[0], to[1], 0.02);
  const mid: Vec3 = [(a[0] + b[0]) / 2, 0.02, (a[2] + b[2]) / 2];
  const s = 0.14;
  return (
    <group>
      <Line points={[a, b]} color={COLORS.unreachable} lineWidth={1.5} dashed dashSize={0.06} gapSize={0.09} transparent opacity={0.6} />
      <Line points={[[mid[0] - s, 0.03, mid[2] - s], [mid[0] + s, 0.03, mid[2] + s]]} color={COLORS.unreachable} lineWidth={4} />
      <Line points={[[mid[0] - s, 0.03, mid[2] + s], [mid[0] + s, 0.03, mid[2] - s]]} color={COLORS.unreachable} lineWidth={4} />
      <SceneLabel position={[mid[0], 0.35, mid[2]]} tone="unreachable">No valid route</SceneLabel>
    </group>
  );
}

function Trail({ replay, pose }: { replay: Replay; pose: Pose }) {
  const traj = replay.result.trajectory;
  const recorded = useMemo(() => traj.map((p) => toScene(p.x, p.y, 0.03)), [traj]);
  const pts = useMemo(
    () => [...recorded.slice(0, pose.index + 1), toScene(pose.x, pose.y, 0.03)],
    [recorded, pose.index, pose.x, pose.y],
  );
  if (pts.length < 2) return null;
  return <Line points={pts} color={COLORS.trail} lineWidth={3} />;
}

function Robot({ replay, pose, time }: { replay: Replay; pose: Pose; time: number }) {
  const r = toSceneLength(replay.scenario.robot_radius);
  const bodyMat = useRef<THREE.MeshStandardMaterial>(null);
  const collision = replay.result.collision;
  const hit = collision !== null && time >= collision.t;
  const flashing = collision !== null && !hit && time >= collision.t - FLASH_WINDOW;

  useFrame(({ clock }) => {
    if (!bodyMat.current) return;
    const on = hit || (flashing && Math.sin(clock.elapsedTime * 18) > 0);
    bodyMat.current.color.set(on ? COLORS.robotHit : COLORS.robot);
    bodyMat.current.emissive.set(on ? COLORS.robotHit : "#000000");
    bodyMat.current.emissiveIntensity = on ? 0.6 : 0;
  });

  return (
    <group position={toScene(pose.x, pose.y)} rotation-y={headingToYaw(pose.heading)}>
      <mesh position={[0, ROBOT_HEIGHT / 2 + 0.02, 0]} castShadow>
        <cylinderGeometry args={[r, r, ROBOT_HEIGHT, 40]} />
        <meshStandardMaterial ref={bodyMat} color={COLORS.robot} />
        {hit && <Edges color={COLORS.collision} lineWidth={3} scale={1.08} />}
      </mesh>
      <mesh position={[r * 0.5, ROBOT_HEIGHT + 0.035, 0]}>
        <boxGeometry args={[r, 0.03, r * 0.35]} />
        <meshStandardMaterial color="#ffd23f" />
      </mesh>
      {[-1, 1].map((s) => (
        <mesh key={s} position={[0, 0.05, s * r * 0.95]} rotation-x={Math.PI / 2}>
          <cylinderGeometry args={[0.05, 0.05, 0.03, 16]} />
          <meshStandardMaterial color="#111" />
        </mesh>
      ))}
    </group>
  );
}

function CollisionMarker({ x, y, t, radius }: { x: number; y: number; t: number; radius: number }) {
  const ring = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    if (ring.current) ring.current.scale.setScalar(1 + 0.18 * Math.sin(clock.elapsedTime * 6));
  });
  const r = toSceneLength(radius);
  const [cx, , cz] = toScene(x, y);
  return (
    <group position={[cx, 0, cz]}>
      <mesh ref={ring} position={[0, 0.015, 0]} rotation-x={-Math.PI / 2}>
        <ringGeometry args={[r * 1.35, r * 1.6, 48]} />
        <meshBasicMaterial color={COLORS.collision} transparent opacity={0.9} />
      </mesh>
      <mesh position={[0, 0.013, 0]} rotation-x={-Math.PI / 2}>
        <circleGeometry args={[r * 0.25, 24]} />
        <meshBasicMaterial color={COLORS.collision} />
      </mesh>
      <SceneLabel position={[0, 0.65, 0]} tone="collision">
        Collision · t = {t.toFixed(2)} s
      </SceneLabel>
    </group>
  );
}

function SceneLabel({ position, tone, children }: { position: Vec3; tone: "collision" | "unreachable"; children: React.ReactNode }) {
  const color = tone === "collision" ? COLORS.collision : COLORS.unreachable;
  return (
    <Html position={position} center zIndexRange={[10, 0]} style={{ pointerEvents: "none" }}>
      <div
        style={{
          whiteSpace: "nowrap",
          font: "600 12px/1.2 system-ui, sans-serif",
          color: "#fff",
          background: color,
          padding: "4px 8px",
          borderRadius: 6,
          boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
        }}
      >
        {children}
      </div>
    </Html>
  );
}

interface CameraPose {
  position: Vec3;
  target: Vec3;
}

function overviewPose(replay: Replay): CameraPose {
  const w = toSceneLength(replay.scenario.width);
  const d = toSceneLength(replay.scenario.height);
  const span = Math.max(w, d);
  return { target: [w / 2, 0, -d / 2], position: [w / 2, span * 1.2, -d / 2 + span * 0.28] };
}

function followPose(pose: Pose): CameraPose {
  const [x, , z] = toScene(pose.x, pose.y);
  const yaw = headingToYaw(pose.heading);
  const back = 2.2;
  return { target: [x, 0.1, z], position: [x - Math.cos(yaw) * back, 2.4, z + Math.sin(yaw) * back] };
}

function collisionPose(replay: Replay): CameraPose | null {
  const c = replay.result.collision;
  if (!c) return null;
  const traj = replay.result.trajectory;
  const robot = traj[traj.length - 1];
  const track = replay.moving_obstacle_tracks.find((tr) => tr.id === c.obstacle_id);
  const stat = replay.scenario.static_obstacles.find((o) => o.id === c.obstacle_id);
  const other = track ? trackPositionAt(track.samples, c.t) : stat ? { x: stat.x, y: stat.y } : { x: c.x, y: c.y };
  const k = track ? 0.5 : 0.2;
  const focus = toScene(c.x + (other.x - c.x) * k, c.y + (other.y - c.y) * k);
  const yaw = headingToYaw(robot.heading);
  const back = new THREE.Vector2(-Math.cos(yaw), Math.sin(yaw));
  const [rx, , rz] = toScene(c.x, c.y);
  const [ox, , oz] = toScene(other.x, other.y);
  const away = new THREE.Vector2(rx - ox, rz - oz);
  if (away.lengthSq() > 1e-9) away.normalize();
  const dir = back.add(away.multiplyScalar(1.2)).normalize().multiplyScalar(1.1);
  return {
    target: [focus[0], 0.1, focus[2]],
    position: [focus[0] + dir.x, 2.6, focus[2] + dir.y],
  };
}

function CameraRig({ replay, pose, mode, resetKey }: { replay: Replay; pose: Pose; mode: CameraMode; resetKey: number }) {
  const controls = useRef<OrbitControlsImpl>(null);
  const camera = useThree((s) => s.camera);
  const easeUntil = useRef(0);
  const lastTarget = useRef(new THREE.Vector3());
  const poseRef = useRef(pose);
  useEffect(() => {
    poseRef.current = pose;
  });

  useEffect(() => {
    easeUntil.current = performance.now() + CAMERA_EASE_SECONDS * 1000;
  }, [mode, resetKey, replay]);

  useFrame((_, delta) => {
    const c = controls.current;
    if (!c) return;
    const p = poseRef.current;
    const preset =
      mode === "follow" ? followPose(p) : mode === "collision" ? (collisionPose(replay) ?? overviewPose(replay)) : overviewPose(replay);

    if (performance.now() < easeUntil.current) {
      const f = 1 - Math.exp(-delta * 7);
      camera.position.lerp(new THREE.Vector3(...preset.position), f);
      c.target.lerp(new THREE.Vector3(...preset.target), f);
      lastTarget.current.copy(c.target);
      c.update();
      return;
    }
    if (mode === "follow") {
      const next = new THREE.Vector3(...preset.target);
      camera.position.add(next.clone().sub(lastTarget.current));
      c.target.copy(next);
      lastTarget.current.copy(next);
      c.update();
    }
  });

  return <OrbitControls ref={controls} makeDefault enableDamping dampingFactor={0.1} maxPolarAngle={Math.PI / 2.05} />;
}
