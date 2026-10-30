export const SCALE = 0.01;

export function toScene(x: number, y: number, height = 0): [number, number, number] {
  return [x * SCALE, height, -y * SCALE];
}

export function toSceneLength(units: number): number {
  return units * SCALE;
}

export function headingToYaw(heading: number): number {
  return heading;
}
